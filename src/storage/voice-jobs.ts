import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import { AuthError } from "../auth/provider.ts";
import { db } from "../db/index.ts";
import { mediaDeletions, voiceJobs } from "../db/schema.ts";
import { stageMediaUpload } from "./media-lifecycle.ts";
import { avatarStorage } from "./r2.ts";
import { normalizeVoice } from "./voice-audio.ts";
import { voiceDraftLifetimeMs } from "./voice-selection.ts";

type JobKey = { userId: string; id: string };
const intervalMs = 3000;
const leaseDeadline = sql`now() + interval '15 seconds'`;
const expiresAt = sql`now() + ${voiceDraftLifetimeMs} * interval '1 millisecond'`;
let running = 0;

function matches(key: JobKey) {
  return and(eq(voiceJobs.userId, key.userId), eq(voiceJobs.id, key.id));
}

export async function readVoiceJob(key: JobKey) {
  const [job] = await db.select({
    voice: voiceJobs.voice,
    error: voiceJobs.error,
    expiresAt: voiceJobs.expiresAt,
  }).from(voiceJobs).where(and(matches(key), gt(voiceJobs.expiresAt, sql`now()`)));
  return job;
}

export async function enqueueVoiceJob(key: JobKey, input: Buffer) {
  await db.insert(voiceJobs).values({ ...key, input, expiresAt }).onConflictDoNothing();
  if (!(await readVoiceJob(key))) throw new AuthError(429, "voice_processing_busy");
}

export async function cancelVoiceJob(key: JobKey) {
  await db.transaction(async (tx) => {
    // Keep a short-lived tombstone so a delayed upload cannot revive this job.
    await tx.insert(voiceJobs).values({
      ...key, error: "voice_job_cancelled", expiresAt,
    }).onConflictDoNothing();
    const [job] = await tx.select({ voice: voiceJobs.voice })
      .from(voiceJobs).where(matches(key)).for("update");
    if (job?.voice) {
      await tx.update(mediaDeletions).set({ availableAt: sql`now()` })
        .where(eq(mediaDeletions.key, job.voice.key));
    }
    await tx.update(voiceJobs).set({
      input: null, voice: null, error: "voice_job_cancelled", lease: null, expiresAt,
    }).where(matches(key));
  });
}

export async function processVoiceJob(key?: JobKey) {
  // Limit FFmpeg processes per pod. The database lease coordinates replicas.
  if (running >= 2) return;
  running++;
  try {
    const lease = randomUUID();
    const job = await db.transaction(async (tx) => {
      const [due] = await tx.select({
        id: voiceJobs.id,
        userId: voiceJobs.userId,
        input: voiceJobs.input,
        attempts: voiceJobs.attempts,
      }).from(voiceJobs).where(and(
        key ? matches(key) : undefined,
        isNotNull(voiceJobs.input),
        lte(voiceJobs.nextAttemptAt, sql`now()`),
        gt(voiceJobs.expiresAt, sql`now()`),
      )).orderBy(asc(voiceJobs.nextAttemptAt)).limit(1).for("update", { skipLocked: true });
      if (!due?.input) return;
      await tx.update(voiceJobs).set({ lease, nextAttemptAt: leaseDeadline }).where(matches(due));
      return { ...due, input: due.input };
    });
    if (!job) return;

    const owned = and(matches(job), eq(voiceJobs.lease, lease));
    // A hard kill stops heartbeats, so another pod can reclaim within seconds.
    // The lease token prevents a stalled worker from committing over its replacement.
    let heartbeat: Promise<unknown> | undefined;
    const timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = Promise.resolve(db.update(voiceJobs)
        .set({ nextAttemptAt: leaseDeadline }).where(owned))
        .catch(() => console.warn({ event: "voice_job_heartbeat_failed" }))
        .finally(() => { heartbeat = undefined; });
    }, intervalMs);
    timer.unref();
    try {
      const audio = await normalizeVoice(job.input);
      const objectKey = `voices/${randomUUID()}.m4a`;
      // Each attempt writes to its own staged object. An object abandoned before
      // commit remains in the media deletion outbox and expires there.
      const draftExpiresAt = await stageMediaUpload(objectKey, audio.body, "audio/mp4", voiceDraftLifetimeMs);
      const saved = await db.update(voiceJobs).set({
        voice: { key: objectKey, url: `/api/${objectKey}`, durationMs: audio.durationMs, bytes: audio.body.length, waveform: audio.waveform },
        input: null,
        lease: null,
        expiresAt: draftExpiresAt,
      }).where(owned).returning({ id: voiceJobs.id });
      if (!saved.length)
        await db.update(mediaDeletions).set({ availableAt: sql`now()` })
          .where(eq(mediaDeletions.key, objectKey));
    } catch (error) {
      if (error instanceof AuthError && error.status === 400) {
        await db.update(voiceJobs).set({ error: error.code, input: null, lease: null, expiresAt }).where(owned);
      } else {
        const delay = Math.min(15_000, intervalMs * 2 ** Math.min(job.attempts, 3));
        await db.update(voiceJobs).set({
          lease: null,
          attempts: job.attempts + 1,
          nextAttemptAt: sql`now() + ${delay} * interval '1 millisecond'`,
        }).where(owned);
        console.warn({ event: "voice_job_retry", jobId: job.id, delay });
      }
    } finally {
      clearInterval(timer);
    }
  } finally {
    running--;
  }
}

export function startVoiceJobs() {
  if (!avatarStorage) return () => {};
  let pruning = false;
  function tick() {
    const onWorkError = () => console.error({ event: "voice_jobs_unavailable" });
    for (let slot = running; slot < 2; slot++) {
      void processVoiceJob().catch(onWorkError);
    }
    if (pruning) return;
    pruning = true;
    void db.execute(sql`
      DELETE FROM voice_jobs WHERE ctid IN (
        SELECT ctid FROM voice_jobs
        WHERE expires_at <= now() AND (lease IS NULL OR next_attempt_at <= now())
        ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
      )
    `).catch(onWorkError).finally(() => { pruning = false; });
  }
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
