import { Router } from "express";
import { and, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { notifications, posts, pushSettings, users } from "./db/schema.ts";
import { requireUser } from "./auth/request.ts";
import { AuthError } from "./auth/provider.ts";
import { userSelection } from "./user-data.ts";

type Executor = Pick<typeof db, "insert" | "delete">;
type Kind = "like" | "repost" | "reply" | "follow";

/** Records an inbox entry for `userId`. Acting on your own content is silent. */
export async function notify(
  tx: Executor,
  entry: { userId: string; actorId: string; kind: Kind; postId?: string },
) {
  if (entry.userId === entry.actorId) return;
  await tx
    .insert(notifications)
    .values({ ...entry, postId: entry.postId ?? null })
    .onConflictDoNothing();
}
/** Removes the entry again when the like, repost or follow is undone. */
export async function unnotify(
  tx: Executor,
  entry: { userId: string; actorId: string; kind: Kind; postId?: string },
) {
  await tx
    .delete(notifications)
    .where(
      and(
        eq(notifications.userId, entry.userId),
        eq(notifications.actorId, entry.actorId),
        eq(notifications.kind, entry.kind),
        entry.postId
          ? eq(notifications.postId, entry.postId)
          : isNull(notifications.postId),
      ),
    );
}

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
const cursorSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});

router.get("/", async (req, res) => {
  const user = await requireUser(req);
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (req.query.cursor !== undefined) {
    try {
      if (typeof req.query.cursor !== "string" || req.query.cursor.length > 512)
        throw new Error();
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(req.query.cursor, "base64url").toString("utf8")),
      );
    } catch {
      throw new AuthError(400, "invalid_cursor");
    }
  }
  const unreadOnly = req.query.unread === "true";
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      postId: notifications.postId,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
      preview: sql<string | null>`left(${posts.content}, 140)`,
      actor: userSelection,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.actorId))
    .leftJoin(posts, eq(posts.id, notifications.postId))
    .where(
      and(
        eq(notifications.userId, user.id),
        unreadOnly ? isNull(notifications.readAt) : undefined,
        cursor
          ? or(
              lt(notifications.createdAt, new Date(cursor.createdAt)),
              and(
                eq(notifications.createdAt, new Date(cursor.createdAt)),
                lt(notifications.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(21);
  const [{ unreadCount }] = await db
    .select({ unreadCount: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(eq(notifications.userId, user.id), isNull(notifications.readAt)),
    );
  const page = rows.slice(0, 20);
  const last = page.at(-1);
  res.json({
    notifications: page,
    unreadCount,
    nextCursor:
      rows.length > 20 && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            }),
          ).toString("base64url")
        : null,
  });
});

router.put("/read", async (req, res) => {
  const user = await requireUser(req);
  const parsed = z.strictObject({ through: z.iso.datetime() }).safeParse(req.body);
  if (!parsed.success) throw new AuthError(400, "invalid_notification_range");
  await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(notifications.userId, user.id),
        isNull(notifications.readAt),
        lte(notifications.createdAt, new Date(parsed.data.through)),
      ),
    );
  res.status(204).end();
});

router.get("/push", async (req, res) => {
  const user = await requireUser(req);
  const [settings] = await db
    .select()
    .from(pushSettings)
    .where(eq(pushSettings.userId, user.id));
  const mutedUntil =
    settings?.mutedUntil && settings.mutedUntil.getTime() > Date.now()
      ? settings.mutedUntil.toISOString()
      : null;
  res.json({
    // Web Push (VAPID) is not configured on this server yet.
    publicKey: null,
    subscribed: false,
    promptDismissed: settings?.promptDismissed ?? false,
    mutedUntil,
    mutedForever: settings?.mutedForever ?? false,
  });
});
router.put("/push", async (req, res) => {
  await requireUser(req);
  throw new AuthError(501, "push_not_configured");
});
router.delete("/push", async (req, res) => {
  await requireUser(req);
  res.status(204).end();
});
router.put("/push/prompt-dismissal", async (req, res) => {
  const user = await requireUser(req);
  await db
    .insert(pushSettings)
    .values({ userId: user.id, promptDismissed: true })
    .onConflictDoUpdate({
      target: pushSettings.userId,
      set: { promptDismissed: true },
    });
  res.status(204).end();
});
router.patch("/push/mute", async (req, res) => {
  const user = await requireUser(req);
  const parsed = z
    .strictObject({
      endpoint: z.string().max(2048),
      duration: z.enum(["1h", "8h", "forever", "off"]),
    })
    .safeParse(req.body);
  if (!parsed.success) throw new AuthError(400, "invalid_mute");
  const hours = { "1h": 1, "8h": 8 } as const;
  const mutedForever = parsed.data.duration === "forever";
  const mutedUntil =
    parsed.data.duration === "1h" || parsed.data.duration === "8h"
      ? new Date(Date.now() + hours[parsed.data.duration] * 3_600_000)
      : null;
  await db
    .insert(pushSettings)
    .values({ userId: user.id, mutedForever, mutedUntil })
    .onConflictDoUpdate({
      target: pushSettings.userId,
      set: { mutedForever, mutedUntil },
    });
  res.json({ mutedUntil: mutedUntil?.toISOString() ?? null, mutedForever });
});
router.put("/:id/read", async (req, res) => {
  const user = await requireUser(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(400, "invalid_notification_id");
  await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      and(eq(notifications.id, id.data), eq(notifications.userId, user.id)),
    );
  res.status(204).end();
});

export default router;
