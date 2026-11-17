import type { BannerCrop } from "../storage/banner-crop.ts";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  boolean,
  pgEnum,
  integer,
  jsonb,
  index,
  unique,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid().defaultRandom().primaryKey(),
    handle: text().notNull().unique("users_handle_unique"),
    displayName: text("display_name").notNull().default(""),
    bio: text().notNull().default(""),
    notificationPromptDismissed: boolean("notification_prompt_dismissed").notNull().default(false),
    avatarKey: text("avatar_key"),
    bannerKey: text("banner_key"),
    bannerCrop: jsonb("banner_crop").$type<BannerCrop>(),
    bannerExternalUrl: text("banner_external_url"),
    colour: text().notNull().default("#808080"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("users_handle_check", sql`${table.handle} ~ '^[a-z0-9_]{3,32}$'`),
    check(
      "users_display_name_check",
      sql`char_length(${table.displayName}) <= 80`,
    ),
    check("users_bio_check", sql`char_length(${table.bio}) <= 2000`),
    check("users_colour_check", sql`${table.colour} ~ '^#[0-9A-Fa-f]{6}$'`),
  ],
);

export const oauthTransactions = pgTable("oauth_transactions", {
  state: text().primaryKey(),
  browserHash: text("browser_hash").notNull(),
  verifier: text().notNull(),
  nonce: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid().defaultRandom().primaryKey(),
    issuer: text().notNull(),
    subject: text().notNull(),
    userId: uuid("user_id")
      .unique()
      .references(() => users.id, { onDelete: "set null" }),
    username: text().notNull().default(""),
    displayName: text("display_name").notNull().default(""),
    picture: text(),
    profileSyncedAt: timestamp("profile_synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    unique("auth_identity_subject_unique").on(table.issuer, table.subject),
  ],
);

export const authSessions = pgTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  identityId: uuid("identity_id")
    .notNull()
    .references(() => authIdentities.id, { onDelete: "cascade" }),
  encryptedTokens: text("encrypted_tokens").notNull(),
  refreshAfter: timestamp("refresh_after", { withTimezone: true }).notNull(),
  retryAfter: timestamp("retry_after", { withTimezone: true }),
  refreshFailures: integer("refresh_failures").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const posts = pgTable(
  "posts",
  {
    id: uuid().defaultRandom().primaryKey(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => posts.id, {
      onDelete: "cascade",
    }),
    content: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true, precision: 3 }),
  },
  (table) => [
    index("posts_parent_idx").on(
      table.parentId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("posts_feed_idx").on(table.createdAt.desc(), table.id.desc()),
    check(
      "posts_content_check",
      sql`char_length(${table.content}) BETWEEN 1 AND 2000 AND ${table.content} ~ '[^[:space:]]'`,
    ),
  ],
);

// Topics (#name) used by posts and replies. A topic exists while a post uses it;
// the primary key counts a topic once per post however often the text repeats it.
export const postTopics = pgTable(
  "post_topics",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    topic: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.topic] }),
    index("post_topics_topic_idx").on(table.topic, table.postId),
    check(
      "post_topics_topic_check",
      sql`char_length(${table.topic}) BETWEEN 1 AND 32`,
    ),
  ],
);

// Earlier versions of edited posts, saved when an edit replaces them.
export const postEdits = pgTable(
  "post_edits",
  {
    id: uuid().defaultRandom().primaryKey(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    content: text().notNull(),
    // When this version was written: the post's creation or its previous edit.
    versionAt: timestamp("version_at", { withTimezone: true, precision: 3 }).notNull(),
  },
  (table) => [index("post_edits_post_idx").on(table.postId, table.versionAt.desc())],
);

export const postLikes = pgTable(
  "post_likes",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.userId] }),
    index("post_likes_user_idx").on(table.userId),
  ],
);

export const postReposts = pgTable(
  "post_reposts",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.userId] }),
    index("post_reposts_user_idx").on(
      table.userId,
      table.createdAt.desc(),
      table.postId.desc(),
    ),
  ],
);

export const userFollows = pgTable(
  "user_follows",
  {
    followerId: uuid("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followingId: uuid("following_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.followerId, table.followingId] }),
    index("user_follows_following_idx").on(table.followingId),
    check(
      "user_follows_not_self",
      sql`${table.followerId} <> ${table.followingId}`,
    ),
  ],
);

// Durable outbox for replacements, removals, and unfinished uploads.
export const mediaDeletions = pgTable(
  "media_deletions",
  {
    key: text().primaryKey(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attempts: integer().notNull().default(0),
  },
  (table) => [index("media_deletions_due_idx").on(table.availableAt)],
);

export const postMentions = pgTable("post_mentions", {
  postId: uuid("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  handle: text().notNull(),
}, (table) => [primaryKey({ columns: [table.postId, table.userId, table.handle] })]);

export const notificationKind = pgEnum("notification_kind", [
  "like",
  "repost",
  "reply",
  "follow",
  "mention",
]);
export const notifications = pgTable(
  "notifications",
  {
    id: uuid().defaultRandom().primaryKey(),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: notificationKind().notNull(),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
    // Stable event identity also deduplicates an unlike/re-like or unfollow/re-follow.
    subject: text().notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("notifications_event_unique").on(
      table.recipientId,
      table.actorId,
      table.kind,
      table.subject,
    ),
    index("notifications_inbox_idx").on(
      table.recipientId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("notifications_unread_idx")
      .on(table.recipientId)
      .where(sql`${table.readAt} is null`),
    check(
      "notifications_not_self",
      sql`${table.recipientId} <> ${table.actorId}`,
    ),
    check(
      "notifications_subject_check",
      sql`(${table.kind} = 'follow' AND ${table.postId} IS NULL) OR (${table.kind} <> 'follow' AND ${table.postId} IS NOT NULL)`,
    ),
  ],
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionHash: text("session_hash")
      .notNull()
      .references(() => authSessions.tokenHash, { onDelete: "cascade" }),
    endpoint: text().notNull().unique(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    mutedUntil: timestamp("muted_until", { withTimezone: true }),
    mutedForever: boolean("muted_forever").notNull().default(false),
  },
  (table) => [index("push_subscriptions_user_idx").on(table.userId)],
);

export const pushDeliveries = pgTable(
  "push_deliveries",
  {
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => pushSubscriptions.id, { onDelete: "cascade" }),
    attempts: integer().notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.notificationId, table.subscriptionId] }),
    index("push_deliveries_due_idx").on(table.availableAt),
  ],
);
