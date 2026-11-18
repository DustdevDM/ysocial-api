import {
  postFields,
  postSelection,
  serializePost,
  reactionSelection,
  repostSelection,
  pollSelection,
} from "./post-data.ts";
import { Router, type Request } from "express";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { db } from "./db/index.ts";
import {
  postEdits,
  pollVotes,
  postLikes,
  postReposts,
  postTopics,
  posts,
  users,
} from "./db/schema.ts";
import { requireUser, readViewerId } from "./auth/request.ts";
import { AuthError } from "./auth/provider.ts";
import { userSelection } from "./user-data.ts";
import { recordNotification } from "./notification-events.ts";
import { parseTopicName, syncPostTopics } from "./topics.ts";

import { syncMentions } from "./mentions.ts";
import { readGifSelection } from "./storage/klipy.ts";
import { pollDefinitionSchema } from "./poll-schema.ts";

const router = Router();
const contentSchema = z.strictObject({
  content: z
    .string()
    .trim()
    .refine((value) => !value.includes("\u0000"))
    .refine((value) => {
      const length = Array.from(value).length;
      return length <= 2000;
    }),
});
const createSchema = contentSchema
  .extend({
    content: contentSchema.shape.content.default(""),
    clientId: z.uuid().optional(),
    // Preserve compatibility with callers that send an empty attachment list.
    attachmentIds: z.array(z.uuid()).max(0).optional(),
    gifToken: z.string().min(1).max(4096).optional(),
    poll: pollDefinitionSchema.optional(),
  })
  .refine(({ content, gifToken, poll }) => Boolean(content || gifToken || poll));
const cursorSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});
async function findPost(id: string, viewerId: string | null = null) {
  const [post] = await db
    .select(postSelection(viewerId))
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(eq(posts.id, id));
  if (!post) throw new AuthError(404, "post_not_found");
  return serializePost(post);
}
async function createPost({
  userId,
  input,
  parentId = null,
}: {
  userId: string;
  input: z.infer<typeof createSchema>;
  parentId?: string | null;
}) {
  const selection = input.gifToken ? readGifSelection(input.gifToken, userId) : null;
  const gif = selection?.gif ?? null;
  const id = await db.transaction(async (tx) => {
    let parentAuthor: string | undefined;
    if (parentId) {
      const [parent] = await tx
        .select({ id: posts.id, authorId: posts.authorId })
        .from(posts)
        .where(eq(posts.id, parentId))
        .for("key share");
      if (!parent) throw new AuthError(404, "post_not_found");
      parentAuthor = parent.authorId;
    }
    // An expired selection can confirm an earlier successful write by client ID.
    const expired = selection && selection.expires < Date.now();
    const [saved] = expired
      ? []
      : await tx
          .insert(posts)
          .values({
            id: input.clientId,
            authorId: userId,
            content: input.content,
            gif,
            poll: input.poll,
            parentId,
          })
          .onConflictDoNothing({ target: posts.id })
          .returning({ id: posts.id });
    if (saved) {
      await syncMentions(tx, saved.id, userId, input.content);
      await syncPostTopics(tx, saved.id, input.content);
      if (parentAuthor)
        await recordNotification(tx, {
          recipientId: parentAuthor,
          actorId: userId,
          kind: "reply",
          postId: saved.id,
          subject: saved.id,
        });
      return saved.id;
    }
    if (!input.clientId) {
      if (expired) throw new AuthError(400, "invalid_gif_selection");
      throw new Error("Post ID collision");
    }
    const [existing] = await tx
      .select({
        id: posts.id,
        authorId: posts.authorId,
        parentId: posts.parentId,
        content: posts.content,
        gif: posts.gif,
        poll: posts.poll,
      })
      .from(posts)
      .where(eq(posts.id, input.clientId));
    const savedPoll = existing?.poll;
    if (
      !existing ||
      existing.authorId !== userId ||
      existing.parentId !== parentId ||
      existing.content !== input.content ||
      existing.gif?.url !== gif?.url ||
      savedPoll?.title !== input.poll?.title ||
      savedPoll?.anonymous !== input.poll?.anonymous ||
      !isDeepStrictEqual(savedPoll?.options, input.poll?.options)
    )
      throw expired
        ? new AuthError(400, "invalid_gif_selection")
        : new AuthError(409, "post_id_conflict");
    return existing.id;
  });
  return findPost(id, userId);
}
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
// For each reply in `page`, the posts above it, root first.
async function loadAncestors(
  page: { id: string; parentId: string | null }[],
  viewerId: string | null,
) {
  const replyIds = page.filter((row) => row.parentId).map((row) => row.id);
  const result = new Map<string, ReturnType<typeof serializePost>[]>();
  if (!replyIds.length) return result;
  const chains = await db.execute<{ origin: string; id: string }>(sql`
    with recursive chain as (
      select id as origin, parent_id as id, 1 as depth
      from posts where id in (${sql.join(
        replyIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) and parent_id is not null
      union all
      select c.origin, p.parent_id, c.depth + 1
      from chain c join posts p on p.id = c.id
      where p.parent_id is not null and c.depth < 100
    )
    select origin, id from chain order by origin, depth desc
  `);
  const ancestorRows = await db
    .select(postSelection(viewerId))
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(inArray(posts.id, [...new Set(chains.rows.map((row) => row.id))]));
  const byId = new Map(ancestorRows.map((row) => [row.id, serializePost(row)]));
  for (const { origin, id } of chains.rows) {
    const found = byId.get(id);
    if (found) result.set(origin, [...(result.get(origin) ?? []), found]);
  }
  return result;
}
const listPosts: import("express").RequestHandler = async (req, res) => {
  const parentId =
    typeof req.params.id === "string" ? req.params.id : undefined;
  if (parentId) await findPost(parentId);
  const viewerId = await readViewerId(req);
  const topic =
    !parentId && req.query.topic !== undefined
      ? parseTopicName(req.query.topic)
      : undefined;
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
  const rows = await db
    .select(postSelection(viewerId))
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(
      and(
        parentId ? eq(posts.parentId, parentId) : undefined,
        !parentId && !topic ? isNull(posts.parentId) : undefined,
        topic
          ? inArray(
              posts.id,
              db
                .select({ id: postTopics.postId })
                .from(postTopics)
                .where(eq(postTopics.topic, topic)),
            )
          : undefined,
        cursor
          ? or(
              lt(posts.createdAt, new Date(cursor.createdAt)),
              and(
                eq(posts.createdAt, new Date(cursor.createdAt)),
                lt(posts.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1);
  // A topic lists replies next to posts; send the chain above each reply so
  // clients can show it in context instead of as a stray post.
  const ancestors = topic ? await loadAncestors(page, viewerId) : undefined;
  res.json({
    posts: page.map((row) =>
      ancestors
        ? { ...serializePost(row), ancestors: ancestors.get(row.id) ?? [] }
        : serializePost(row),
    ),
    nextCursor:
      rows.length > 20 && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            }),
          ).toString("base64url")
        : null,
    serverNow: new Date().toISOString(),
  });
};
router.get("/", listPosts);
router.get("/poll-results", async (req, res) => {
  const parsed = z.strictObject({
    ids: z.string().max(50 * 37).transform((value) => value.split(","))
      .pipe(z.array(z.uuid()).min(1).max(50)),
  }).safeParse(req.query);
  if (!parsed.success) throw new AuthError(400, "invalid_post_id");

  const viewerId = await readViewerId(req);
  const results = await db
    .select({ id: posts.id, poll: pollSelection(viewerId) })
    .from(posts)
    .where(and(inArray(posts.id, parsed.data.ids), sql`${posts.poll} is not null`));
  res.json({ viewerId, results });
});
router.post("/", async (req, res) => {
  const user = await requireUser(req);
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new AuthError(400, "invalid_content");
  res.status(201).json({
    post: await createPost({ userId: user.id, input: parsed.data }),
    serverNow: new Date().toISOString(),
  });
});
router.use("/:id", (req, _res, next) => {
  if (!z.uuid().safeParse(req.params.id).success)
    throw new AuthError(400, "invalid_post_id");
  next();
});
router.get("/:id", async (req, res) => {
  res.json({
    post: await findPost(req.params.id, await readViewerId(req)),
    serverNow: new Date().toISOString(),
  });
});
const THREAD_MAX_DEPTH = 12;
const THREAD_MAX_REPLIES = 300;
// Full conversation around a post: the chain above it (root first) and every
// nested reply below it (shallowest first, then oldest first), so clients can
// render a collapsible tree without one request per level.
router.get("/:id/thread", async (req, res) => {
  const id = req.params.id;
  const viewerId = await readViewerId(req);
  const post = await findPost(id, viewerId);
  const [ancestorRows, descendantRows] = await Promise.all([
    db.execute<{ id: string }>(sql`
      with recursive chain as (
        select id, parent_id, 0 as depth from posts where id = ${id}
        union all
        select p.id, p.parent_id, c.depth + 1
        from posts p join chain c on p.id = c.parent_id
        where c.depth < 100
      )
      select id from chain where depth > 0 order by depth desc
    `),
    db.execute<{ id: string }>(sql`
      with recursive tree as (
        select id, 1 as depth from posts where parent_id = ${id}
        union all
        select p.id, t.depth + 1
        from posts p join tree t on p.parent_id = t.id
        where t.depth < ${THREAD_MAX_DEPTH}
      )
      select t.id from tree t join posts p on p.id = t.id
      order by t.depth, p.created_at, p.id
      limit ${THREAD_MAX_REPLIES + 1}
    `),
  ]);
  const ancestorIds = ancestorRows.rows.map((row) => row.id);
  const truncated = descendantRows.rows.length > THREAD_MAX_REPLIES;
  const descendantIds = descendantRows.rows
    .slice(0, THREAD_MAX_REPLIES)
    .map((row) => row.id);
  const wanted = [...ancestorIds, ...descendantIds];
  const rows = wanted.length
    ? await db
        .select(postSelection(viewerId))
        .from(posts)
        .innerJoin(users, eq(users.id, posts.authorId))
        .where(inArray(posts.id, wanted))
    : [];
  const byId = new Map(rows.map((row) => [row.id, serializePost(row)]));
  const pick = (ids: string[]) =>
    ids.flatMap((postId) => {
      const found = byId.get(postId);
      return found ? [found] : [];
    });
  res.json({
    post,
    ancestors: pick(ancestorIds),
    replies: pick(descendantIds),
    truncated,
    serverNow: new Date().toISOString(),
  });
});
// Edit history, newest version first (the current text is the first entry).
router.get("/:id/edits", async (req, res) => {
  const post = await findPost(req.params.id);
  const earlier = await db
    .select({ content: postEdits.content, at: postEdits.versionAt })
    .from(postEdits)
    .where(eq(postEdits.postId, post.id))
    .orderBy(desc(postEdits.versionAt));
  res.json({
    versions: [
      { content: post.content, at: post.editedAt ?? post.createdAt },
      ...earlier,
    ],
  });
});
router.get("/:id/replies", listPosts);
const pollOptionSchema = z.number().int().min(0).max(5);
router.put("/:id/poll/vote", async (req, res) => {
  const user = await requireUser(req);
  const parsed = z.strictObject({ optionIndex: pollOptionSchema }).safeParse(req.body);
  if (!parsed.success) throw new AuthError(400, "invalid_poll_option");
  const postId = req.params.id;
  const { optionIndex } = parsed.data;
  const poll = await db.transaction(async (tx) => {
    const [post] = await tx
      .select({ poll: posts.poll })
      .from(posts)
      .where(eq(posts.id, postId))
      .for("update");
    if (!post?.poll) throw new AuthError(404, "poll_not_found");
    if (optionIndex >= post.poll.options.length)
      throw new AuthError(400, "invalid_poll_option");

    await tx
      .insert(pollVotes)
      .values({ postId, userId: user.id, optionIndex })
      .onConflictDoUpdate({
        target: [pollVotes.postId, pollVotes.userId],
        set: { optionIndex },
      });

    const [result] = await tx
      .select({ poll: pollSelection(user.id) })
      .from(posts)
      .where(eq(posts.id, postId));
    return result.poll;
  });
  res.json({ poll });
});
router.get("/:id/poll/voters", async (req, res) => {
  const parsed = z.strictObject({
    option: z.preprocess(
      (value) => typeof value === "string" ? [value] : value,
      z.array(z.string().regex(/^[0-5]$/).transform(Number)).min(1).max(6).optional(),
    ),
    cursor: z.uuid().optional(),
  }).safeParse(req.query);
  if (!parsed.success) throw new AuthError(400, "invalid_poll_option");
  const { option: selectedOptions, cursor } = parsed.data;
  const [post] = await db
    .select({ poll: posts.poll })
    .from(posts)
    .where(eq(posts.id, req.params.id));
  if (!post?.poll) throw new AuthError(404, "poll_not_found");
  if (post.poll.anonymous) throw new AuthError(403, "poll_is_anonymous");
  const { options } = post.poll;
  if (selectedOptions?.some((index) => index >= options.length))
    throw new AuthError(400, "invalid_poll_option");

  const rows = await db
    .select({ ...userSelection, optionIndex: pollVotes.optionIndex })
    .from(pollVotes)
    .innerJoin(users, eq(users.id, pollVotes.userId))
    .where(and(
      eq(pollVotes.postId, req.params.id),
      selectedOptions ? inArray(pollVotes.optionIndex, selectedOptions) : undefined,
      cursor ? gt(pollVotes.userId, cursor) : undefined,
    ))
    .orderBy(asc(pollVotes.userId))
    .limit(51);
  const page = rows.slice(0, 50);
  res.json({
    users: page.map(({ optionIndex, ...user }) => ({
      ...user,
      optionLabel: options[optionIndex],
    })),
    nextCursor: rows.length > 50 ? (page.at(-1)?.id ?? null) : null,
  });
});
router.get("/:id/activity", async (req, res) => {
  const query = z
    .object({
      type: z.enum(["likes", "reposts"]),
      cursor: z.uuid().optional(),
    })
    .safeParse(req.query);
  if (!query.success) throw new AuthError(400, "invalid_activity_query");
  await findPost(req.params.id);
  const activity = query.data.type === "likes" ? postLikes : postReposts;
  const rows = await db
    .select(userSelection)
    .from(activity)
    .innerJoin(users, eq(users.id, activity.userId))
    .where(
      and(
        eq(activity.postId, req.params.id),
        query.data.cursor ? gt(activity.userId, query.data.cursor) : undefined,
      ),
    )
    .orderBy(asc(activity.userId))
    .limit(51);
  const page = rows.slice(0, 50);
  res.json({
    users: page,
    nextCursor: rows.length > 50 ? (page.at(-1)?.id ?? null) : null,
  });
});
router.post("/:id/replies", async (req, res) => {
  const user = await requireUser(req);
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new AuthError(400, "invalid_content");
  res.status(201).json({
    post: await createPost({
      userId: user.id,
      input: parsed.data,
      parentId: req.params.id,
    }),
    serverNow: new Date().toISOString(),
  });
});
async function setLike(req: Request, liked: boolean) {
  const user = await requireUser(req);
  const parsedId = z.uuid().safeParse(req.params.id);
  if (!parsedId.success) throw new AuthError(400, "invalid_post_id");
  const id = parsedId.data;
  return db.transaction(async (tx) => {
    // Serialize writes to this post, so retries and concurrent likes return a consistent count.
    const [post] = await tx
      .select({ id: posts.id, authorId: posts.authorId })
      .from(posts)
      .where(eq(posts.id, id))
      .for("update");
    if (!post) throw new AuthError(404, "post_not_found");
    if (liked) {
      const [inserted] = await tx
        .insert(postLikes)
        .values({ postId: id, userId: user.id })
        .onConflictDoNothing()
        .returning();
      if (inserted)
        await recordNotification(tx, {
          recipientId: post.authorId,
          actorId: user.id,
          kind: "like",
          postId: id,
          subject: id,
        });
    } else {
      await tx
        .delete(postLikes)
        .where(and(eq(postLikes.postId, id), eq(postLikes.userId, user.id)));
    }
    const [state] = await tx
      .select(reactionSelection(user.id))
      .from(posts)
      .where(eq(posts.id, id));
    return state;
  });
}
router.put("/:id/like", async (req, res) => {
  res.json(await setLike(req, true));
});
router.delete("/:id/like", async (req, res) => {
  res.json(await setLike(req, false));
});
async function setRepost(req: Request, reposted: boolean) {
  const user = await requireUser(req);
  const parsedId = z.uuid().safeParse(req.params.id);
  if (!parsedId.success) throw new AuthError(400, "invalid_post_id");
  const id = parsedId.data;
  return db.transaction(async (tx) => {
    const [post] = await tx
      .select({ id: posts.id, authorId: posts.authorId })
      .from(posts)
      .where(eq(posts.id, id))
      .for("update");
    if (!post) throw new AuthError(404, "post_not_found");
    if (reposted) {
      const [inserted] = await tx
        .insert(postReposts)
        .values({ postId: id, userId: user.id })
        .onConflictDoNothing()
        .returning();
      if (inserted)
        await recordNotification(tx, {
          recipientId: post.authorId,
          actorId: user.id,
          kind: "repost",
          postId: id,
          subject: id,
        });
    } else {
      await tx
        .delete(postReposts)
        .where(
          and(eq(postReposts.postId, id), eq(postReposts.userId, user.id)),
        );
    }
    const [state] = await tx
      .select(repostSelection(user.id))
      .from(posts)
      .where(eq(posts.id, id));
    return state;
  });
}
router.put("/:id/repost", async (req, res) => {
  res.json(await setRepost(req, true));
});
router.delete("/:id/repost", async (req, res) => {
  res.json(await setRepost(req, false));
});
router.patch("/:id", async (req, res) => {
  const user = await requireUser(req);
  const parsed = contentSchema.safeParse(req.body);
  if (!parsed.success) throw new AuthError(400, "invalid_content");
  const updated = await db.transaction(async (tx) => {
    // Acquire the row before evaluating the clock, including waits for other writers.
    const [existing] = await tx
      .select({
        authorId: posts.authorId,
        content: posts.content,
        gif: posts.gif,
        poll: posts.poll,
        createdAt: posts.createdAt,
        editedAt: posts.editedAt,
      })
      .from(posts)
      .where(eq(posts.id, req.params.id))
      .for("update");
    if (!existing) throw new AuthError(404, "post_not_found");
    if (existing.authorId !== user.id)
      throw new AuthError(403, "not_post_author");
    if (!parsed.data.content && !existing.gif && !existing.poll)
      throw new AuthError(400, "invalid_content");
    const [saved] = await tx
      .update(posts)
      .set({ content: parsed.data.content, editedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(posts.id, req.params.id),
          sql`clock_timestamp() < ${posts.createdAt} + interval '15 minutes'`,
        ),
      )
      .returning(postFields);
    if (!saved) throw new AuthError(409, "edit_window_expired");
    await syncPostTopics(tx, req.params.id, parsed.data.content);
    if (existing.content !== parsed.data.content)
      await tx.insert(postEdits).values({
        postId: req.params.id,
        content: existing.content,
        versionAt: existing.editedAt ?? existing.createdAt,
      });
    await syncMentions(tx, saved.id, user.id, parsed.data.content);
    return saved;
  });
  res.json({
    post: await findPost(updated.id, user.id),
    serverNow: new Date().toISOString(),
  });
});
router.delete("/:id", async (req, res) => {
  const user = await requireUser(req);
  const [deleted] = await db
    .delete(posts)
    .where(and(eq(posts.id, req.params.id), eq(posts.authorId, user.id)))
    .returning({ id: posts.id });
  if (!deleted) {
    await findPost(req.params.id);
    throw new AuthError(403, "not_post_author");
  }
  res.status(204).end();
});
export default router;
