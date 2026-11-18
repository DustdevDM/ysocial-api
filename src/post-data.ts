import { sql } from "drizzle-orm";
import { postLikes, postReposts, posts } from "./db/schema.ts";
import { userSelection } from "./user-data.ts";
import type { PollDefinition } from "./poll-schema.ts";

export const postFields = {
  id: posts.id,
  parentId: posts.parentId,
  content: posts.content,
  gif: posts.gif,
  createdAt: posts.createdAt,
  editedAt: posts.editedAt,
};
export function reactionSelection(viewerId: string | null) {
  return {
    likes: sql<number>`(select count(*)::int from ${postLikes} where ${postLikes.postId} = ${posts.id})`,
    liked:
      viewerId === null
        ? sql<boolean>`false`
        : sql<boolean>`exists(select 1 from ${postLikes} where ${postLikes.postId} = ${posts.id} and ${postLikes.userId} = ${viewerId})`,
  };
}
export function repostSelection(viewerId: string | null) {
  return {
    reposts: sql<number>`(select count(*)::int from ${postReposts} where ${postReposts.postId} = ${posts.id})`,
    reposted:
      viewerId === null
        ? sql<boolean>`false`
        : sql<boolean>`exists(select 1 from ${postReposts} where ${postReposts.postId} = ${posts.id} and ${postReposts.userId} = ${viewerId})`,
  };
}
type PollResult = Omit<PollDefinition, "options"> & {
  allowRevote: true;
  options: { label: string; votes: number }[];
  selectedOption: number | null;
};

export function pollSelection(viewerId: string | null) {
  const selectedOption = viewerId === null ? sql`null` : sql`(
    select option_index from poll_votes where post_id = ${posts.id} and user_id = ${viewerId}
  )`;
  return sql<PollResult | null>`case when ${posts.poll} is not null then
    ${posts.poll} || jsonb_build_object('allowRevote', true, 'selectedOption', ${selectedOption}, 'options', (
      select jsonb_agg(jsonb_build_object(
        'label', option.label, 'votes', coalesce(tally.votes, 0)
      ) order by option.position)
      from jsonb_array_elements_text(${posts.poll}->'options') with ordinality as option(label, position)
      left join (
        select option_index, count(*)::int as votes
        from poll_votes where post_id = ${posts.id} group by option_index
      ) tally on tally.option_index = option.position - 1
    ))
  end`;
}
// "Friends" are mutual follows. Friends who liked a post are surfaced under it.
const friendLikeFilter = (viewerId: string) => sql`
  pl.post_id = ${posts.id}
  and exists (select 1 from user_follows a where a.follower_id = ${viewerId} and a.following_id = pl.user_id)
  and exists (select 1 from user_follows b where b.follower_id = pl.user_id and b.following_id = ${viewerId})`;
export function friendLikeSelection(viewerId: string | null) {
  return {
    friendLikes:
      viewerId === null
        ? sql<number>`0`
        : sql<number>`(select count(*)::int from post_likes pl where ${friendLikeFilter(viewerId)})`,
    friendLikers:
      viewerId === null
        ? sql<{ id: string; handle: string; displayName: string; avatarUrl: string | null }[]>`'[]'::json`
        : sql<{ id: string; handle: string; displayName: string; avatarUrl: string | null }[]>`(
            select coalesce(json_agg(t), '[]'::json) from (
              select u.id, u.handle, u.display_name as "displayName",
                coalesce('/api/' || u.avatar_key, (select ai.picture from auth_identities ai where ai.user_id = u.id and ai.deleted_at is null)) as "avatarUrl"
              from post_likes pl join users u on u.id = pl.user_id
              where ${friendLikeFilter(viewerId)}
              order by u.handle
              limit 4
            ) t
          )`,
  };
}
export const postSelection = (viewerId: string | null) => ({
  ...reactionSelection(viewerId),
  ...friendLikeSelection(viewerId),
  ...repostSelection(viewerId),
  ...postFields,
  poll: pollSelection(viewerId),
  mentions: sql<{ id: string; handle: string; username: string }[]>`(
    select coalesce(json_agg(json_build_object('id', u.id, 'handle', u.handle, 'username', m.handle)), '[]'::json)
    from post_mentions m join users u on u.id = m.user_id where m.post_id = ${posts.id}
  )`,
  topics: sql<string[]>`coalesce((select array_agg(pt.topic order by pt.topic) from post_topics pt where pt.post_id = ${posts.id}), '{}')`,
  replies: sql<number>`(
    with recursive descendants(id) as (
      select reply.id from posts reply
      where reply.parent_id = ${posts}.${sql.identifier(posts.id.name)}
      union all
      select reply.id from posts reply
      join descendants on reply.parent_id = descendants.id
    )
    select count(*)::int from descendants
  )`,
  author: userSelection,
});
type PostRow = { createdAt: Date };
export function serializePost<T extends PostRow>(post: T) {
  return {
    ...post,
    editExpiresAt: new Date(
      post.createdAt.getTime() + 15 * 60000,
    ).toISOString(),
  };
}
