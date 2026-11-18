import { sql } from "drizzle-orm";
import pg from "pg";
import type { Response } from "express";
import { env } from "./config.ts";
import { db } from "./db/index.ts";

const CHANNEL = "live_posts";
const HEARTBEAT_MS = 20_000;
const MAX_BUFFERED_BYTES = 64 * 1024;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type LivePost = {
  id: string;
  parentId: string | null;
  authorId: string;
  topics: string[];
};

const streams = new Set<Response>();

function write(stream: Response, frame: string) {
  if (stream.writableLength > MAX_BUFFERED_BYTES) {
    stream.destroy();
    return;
  }
  stream.write(frame);
}

function broadcast(frame: string) {
  for (const stream of streams) write(stream, frame);
}

export function canOpenLiveStream() {
  return streams.size < env.LIVE_MAX_STREAMS;
}

export function openLiveStream(stream: Response) {
  streams.add(stream);
  stream.on("close", () => streams.delete(stream));
}

export function closeLiveStreams() {
  for (const stream of streams) stream.end();
  streams.clear();
}

export async function publishLivePost(tx: Transaction, post: LivePost) {
  await tx.execute(sql`select pg_notify(${CHANNEL}, ${JSON.stringify(post)})`);
}

export function startLiveEvents() {
  let stopped = false;
  let connectedBefore = false;
  let client: pg.Client | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let delay = 500;
  const heartbeat = setInterval(() => broadcast(": ping\n\n"), HEARTBEAT_MS);
  heartbeat.unref();

  function retry() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, delay);
    retryTimer.unref();
    delay = Math.min(delay * 2, 10_000);
  }

  async function connect() {
    const next = new pg.Client({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    client = next;
    let lost = false;
    const lose = () => {
      if (lost) return;
      lost = true;
      if (client === next) client = undefined;
      next.end().catch(() => {});
      retry();
    };
    next.on("notification", (message) => {
      if (message.channel === CHANNEL && message.payload)
        broadcast(`event: post\ndata: ${message.payload}\n\n`);
    });
    next.on("error", lose);
    next.on("end", lose);
    try {
      await next.connect();
      await next.query(`listen ${CHANNEL}`);
      delay = 500;
      if (connectedBefore) broadcast("event: resync\ndata: {}\n\n");
      connectedBefore = true;
      if (stopped) lose();
    } catch {
      lose();
    }
  }

  void connect();
  return () => {
    stopped = true;
    clearInterval(heartbeat);
    clearTimeout(retryTimer);
    closeLiveStreams();
    void client?.end().catch(() => {});
  };
}
