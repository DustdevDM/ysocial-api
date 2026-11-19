import { and, eq, type SQL } from "drizzle-orm";
import type { db } from "./db/index.ts";
import { posts } from "./db/schema.ts";
import { affectedPostIds, publishLiveChange } from "./live-events.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function removePost(tx: Transaction, id: string, condition?: SQL) {
  const affected = await affectedPostIds(tx, id);
  const [removed] = await tx.delete(posts)
    .where(and(eq(posts.id, id), condition))
    .returning({ voice: posts.voice, authorId: posts.authorId });
  if (removed) await publishLiveChange(tx, affected);
  return removed;
}
