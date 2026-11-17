import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "./db/index.ts";
import { postMentions, users } from "./db/schema.ts";
import { recordNotification } from "./notification-events.ts";

// Reject email addresses, URL paths, and partial/overlong handles.
export function mentionHandles(content: string) {
  return [...new Set(Array.from(
    content.matchAll(/(?<![\p{L}\p{N}_@/.])@([a-z0-9_]{3,32})(?![\p{L}\p{N}_])/giu),
    (match) => match[1].toLowerCase(),
  ))];
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function syncMentions(tx: Transaction, postId: string, actorId: string, content: string) {
  const handles = mentionHandles(content);
  const targets = handles.length
    ? await tx.select({ id: users.id, handle: users.handle }).from(users).where(inArray(users.handle, handles))
    : [];
  await tx.delete(postMentions).where(and(
    eq(postMentions.postId, postId),
    targets.length ? notInArray(postMentions.userId, targets.map((user) => user.id)) : undefined,
  ));
  if (!targets.length) return;
  const added = await tx.insert(postMentions).values(targets.map((user) => ({
    postId, userId: user.id, handle: user.handle,
  }))).onConflictDoNothing().returning({ userId: postMentions.userId });
  for (const target of added) {
    await recordNotification(tx, {
      recipientId: target.userId, actorId, kind: "mention", postId, subject: postId,
    });
  }
}
