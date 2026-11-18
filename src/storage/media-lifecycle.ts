import type { PoolClient } from "pg";
import { sweepUnusedMedia } from "./media-sweep.ts";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { createDatabase, db, pool } from "../db/index.ts";
import { mediaDeletions, posts, users } from "../db/schema.ts";
import { AuthError } from "../auth/provider.ts";
import type { BannerCrop } from "./banner-crop.ts";
import { avatarStorage, putAvatar } from "./r2.ts";

// Future media routes use stageMediaUpload before writing an object, then remove
// its pending deletion in the same transaction that attaches it to its owner.
export async function stageMediaUpload(
  key: string,
  body: Buffer,
  contentType = "image/avif",
  lifetimeMs = 3600000,
) {
  const [pending] = await db
    .insert(mediaDeletions)
    .values({ key, availableAt: sql`now() + ${lifetimeMs} * interval '1 millisecond'` })
    .returning({ availableAt: mediaDeletions.availableAt });
  try {
    await putAvatar(key, body, contentType);
  } catch (error) {
    await db
      .update(mediaDeletions)
      .set({ availableAt: new Date() })
      .where(eq(mediaDeletions.key, key));
    await flushMediaDeletions(key);
    throw error;
  }
  return pending.availableAt;
}

type ProfileMedia =
  | { kind: "avatar"; key: string }
  | {
      kind: "banner";
      key: string | null;
      url: string | null;
      crop: BannerCrop | null;
    };
export async function replaceProfileMedia(userId: string, media: ProfileMedia) {
  let previous: string | null = null;
  try {
    previous = await db.transaction(async (tx) => {
      const [user] = await tx
        .select({ avatarKey: users.avatarKey, bannerKey: users.bannerKey })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      if (!user) throw new AuthError(401, "sign_in_required");
      const previous =
        media.kind === "avatar" ? user.avatarKey : user.bannerKey;
      await tx
        .update(users)
        .set(
          media.kind === "avatar"
            ? { avatarKey: media.key, updatedAt: new Date() }
            : {
                bannerKey: media.key,
                bannerExternalUrl: media.url,
                bannerCrop: media.crop,
                updatedAt: new Date(),
              },
        )
        .where(eq(users.id, userId));
      if (media.key)
        await tx
          .delete(mediaDeletions)
          .where(eq(mediaDeletions.key, media.key));
      if (previous && previous !== media.key)
        await tx
          .insert(mediaDeletions)
          .values({ key: previous })
          .onConflictDoUpdate({
            target: mediaDeletions.key,
            set: { availableAt: new Date() },
          });
      return previous;
    });
  } catch (error) {
    // An unattached upload is already in the outbox; make it immediately due.
    if (media.key)
      await db
        .update(mediaDeletions)
        .set({ availableAt: new Date() })
        .where(eq(mediaDeletions.key, media.key));
    if (media.key) await flushMediaDeletions(media.key);
    throw error;
  }
  if (previous && previous !== media.key) await flushMediaDeletions(previous);
}

export async function flushMediaDeletions(key?: string, database = db) {
  if (!avatarStorage) return;
  const { client, bucket } = avatarStorage;
  try {
    for (let processed = 0; processed < 25; processed++) {
      const found = await database.transaction(async (tx) => {
        // Multiple API processes can safely drain the same outbox.
        const [job] = await tx
          .select()
          .from(mediaDeletions)
          .where(
            and(
              lte(mediaDeletions.availableAt, sql`now()`),
              key ? eq(mediaDeletions.key, key) : undefined,
            ),
          )
          .orderBy(mediaDeletions.availableAt)
          .limit(1)
          .for("update", { skipLocked: true });
        if (!job) return false;
        const [active] = await tx
          .select({ id: users.id })
          .from(users)
          .where(or(eq(users.avatarKey, job.key), eq(users.bannerKey, job.key)))
          .limit(1);
        const [voicePost] = job.key.startsWith("voices/") ? await tx.select({ id: posts.id }).from(posts)
          .where(eq(sql`${posts.voice}->>'key'`, job.key)).limit(1) : [];
        if (!active && !voicePost) {
          try {
            // Deleting an already absent key succeeds, including after a crash.
            await client.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: job.key }),
              { abortSignal: AbortSignal.timeout(5000) },
            );
          } catch (error) {
            const voice = job.key.startsWith("voices/");
            if (voice) console.warn({
              event: "voice_deletion_retry",
              key: job.key,
              attempt: job.attempts + 1,
              error: error instanceof Error ? error.name : undefined,
            });
            const delay = Math.min(
              voice ? 30_000 : 3_600_000,
              (voice ? 3000 : 30_000) * 2 ** Math.min(job.attempts, 7),
            );
            await tx
              .update(mediaDeletions)
              .set({
                attempts: job.attempts + 1,
                availableAt: sql`now() + ${delay} * interval '1 millisecond'`,
              })
              .where(eq(mediaDeletions.key, job.key));
            return true;
          }
        }
        await tx.delete(mediaDeletions).where(eq(mediaDeletions.key, job.key));
        return true;
      });
      if (!found) break;
    }
  } catch {
    console.error({ event: "media_cleanup_unavailable" });
  }
}

const MEDIA_SWEEP_LOCK = 7_001_001;

export function startMediaCleanup() {
  if (!avatarStorage) return () => {};
  let sweeping = false;
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    let lock: PoolClient | undefined;
    try {
      lock = await pool.connect();
      const { rows } = await lock.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [MEDIA_SWEEP_LOCK],
      );
      if (!rows[0]?.locked) return;
      const database = createDatabase(lock);
      await sweepUnusedMedia(true, database);
      await flushMediaDeletions(undefined, database);
    } catch {
      console.error({ event: "media_sweep_unavailable" });
    } finally {
      lock?.release(true);
      sweeping = false;
    }
  }
  void sweep();
  const sweepTimer = setInterval(() => void sweep(), 6 * 60 * 60 * 1000);
  sweepTimer.unref();
  let running = false;
  function drain() {
    if (running) return;
    running = true;
    void flushMediaDeletions().finally(() => {
      running = false;
    });
  }
  drain();
  const timer = setInterval(drain, 3000);
  timer.unref();
  return () => {
    clearInterval(timer);
    clearInterval(sweepTimer);
  };
}
