import { eq, inArray, sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import { posts, users } from "./db/schema.ts";
import { postSelection, serializePost } from "./post-data.ts";

type Listed = { id: string; parentId: string | null };

export async function attachSelfReplies<T extends Listed>(
  list: T[],
  viewerId: string | null,
) {
  const rootIds = list.filter((post) => post.parentId === null).map((post) => post.id);
  const byParent = new Map<string, ReturnType<typeof serializePost>>();
  if (rootIds.length) {
    const firsts = await db.execute<{ id: string; parent_id: string }>(sql`
      select distinct on (r.parent_id) r.id, r.parent_id
      from posts r join posts p on p.id = r.parent_id
      where r.parent_id in (${sql.join(
        rootIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) and r.author_id = p.author_id
      order by r.parent_id, r.created_at asc, r.id asc
    `);
    if (firsts.rows.length) {
      const rows = await db
        .select(postSelection(viewerId))
        .from(posts)
        .innerJoin(users, eq(users.id, posts.authorId))
        .where(inArray(posts.id, firsts.rows.map((row) => row.id)));
      const replies = new Map(rows.map((row) => [row.id, serializePost(row)]));
      for (const row of firsts.rows) {
        const reply = replies.get(row.id);
        if (reply) byParent.set(row.parent_id, reply);
      }
    }
  }
  return list.map((post) => ({ ...post, selfReply: byParent.get(post.id) ?? null }));
}
