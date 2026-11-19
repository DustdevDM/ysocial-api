import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { config } from "dotenv";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";

config({ path: new URL("../.env", import.meta.url), quiet: true });

const CASES = [
  ["#news", ["news"]],
  ["Hello #World and #world again #WORLD", ["world"]],
  ["#one #two\n#three", ["one", "two", "three"]],
  ["(#paren) \"#quoted\" #end.", ["paren", "quoted", "end"]],
  ["a#b mail@x.de/page#anchor https://x.test/#frag &#39;", []],
  ["#1 #123 #_x # #", []],
  ["##double #ok", ["ok"]],
  ["#tag#other #fine", ["fine"]],
  ["#snake_case_9 #a1", ["snake_case_9", "a1"]],
  ["#Größe #ÄÖÜ #naïve", ["größe", "äöü", "naïve"]],
  ["#" + "a".repeat(32), ["a".repeat(32)]],
  ["#" + "a".repeat(33), []],
  [Array.from({ length: 12 }, (_, i) => `#t${i}`).join(" "), Array.from({ length: 10 }, (_, i) => `t${i}`)],
  ["no topics here", []],
];

test("topic grammar: the JS parser and the migration backfill agree", async () => {
  const { extractTopics } = await import("../src/topics-text.ts");
  for (const [text, expected] of CASES)
    assert.deepEqual(extractTopics(text), expected, JSON.stringify(text));

  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_topics_grammar_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  let pool;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    pool = new pg.Pool({ connectionString: url.href });
    const folder = fileURLToPath(new URL("../drizzle", import.meta.url));
    const { drizzle } = await import("drizzle-orm/node-postgres");
    await migrate(drizzle(pool), { migrationsFolder: folder });
    const file = (await readdir(folder)).find((entry) => /^\d{4}_post_topics\.sql$/.test(entry));
    const statements = (await readFile(`${folder}/${file}`, "utf8")).split("--> statement-breakpoint");
    const backfill = statements.at(-1);
    assert.match(backfill, /INSERT INTO "post_topics"/);

    const { rows: [user] } = await pool.query("INSERT INTO users (handle) VALUES ('grammar') RETURNING id");
    const ids = [];
    for (const [text] of CASES) {
      const { rows: [post] } = await pool.query(
        "INSERT INTO posts (author_id, content) VALUES ($1, $2) RETURNING id",
        [user.id, text],
      );
      ids.push(post.id);
    }
    // The reply migration indexes replies that predate topic support.
    await pool.query("INSERT INTO posts (author_id, parent_id, content) VALUES ($1, $2, '#reply')", [user.id, ids[0]]);
    await pool.query("DELETE FROM post_topics");
    await pool.query(backfill);
    await pool.query(await readFile(`${folder}/0020_reply_topics.sql`, "utf8"));
    for (const [index, [text, expected]] of CASES.entries()) {
      const { rows } = await pool.query("SELECT topic FROM post_topics WHERE post_id = $1", [ids[index]]);
      assert.deepEqual(rows.map((row) => row.topic).sort(), [...expected].sort(), `backfill ${JSON.stringify(text)}`);
    }
    const { rows: replies } = await pool.query("SELECT 1 FROM post_topics WHERE topic = 'reply'");
    assert.equal(replies.length, 1);
  } finally {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});

test("topics: tagging, feeds, trending and suggestions", async () => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_topics_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  let pool, server;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      NODE_ENV: "test",
      R2_ACCOUNT_ID: "a".repeat(32),
      R2_BUCKET: "topic-tests",
      R2_ACCESS_KEY_ID: "test",
      R2_SECRET_ACCESS_KEY: "test",
    });
    const { app } = await import("../src/app.ts");
    const database = await import("../src/db/index.ts");
    pool = database.pool;
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const { env } = await import("../src/config.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    const { rows: [user] } = await pool.query(
      "INSERT INTO users (handle, approved_at) VALUES ('topic_author', now()) RETURNING id",
    );
    const { rows: [identity] } = await pool.query(
      "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', 'topic-author', $1) RETURNING id",
      [user.id],
    );
    const token = randomUUID();
    await pool.query(
      "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
      [hash(token), identity.id],
    );
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (path, method = "GET", body, signedIn = true) =>
      fetch(base + path, {
        method,
        headers: {
          Origin: env.APP_ORIGIN,
          ...(signedIn ? { Cookie: `session=${token}` } : {}),
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    async function get(path) {
      const response = await request(path, "GET", undefined, false);
      assert.equal(response.status, 200, path);
      return response.json();
    }
    async function create(content, parentId) {
      const response = await request(
        parentId ? `/api/posts/${parentId}/replies` : "/api/posts",
        "POST",
        { content },
      );
      assert.equal(response.status, 201);
      return (await response.json()).post;
    }
    const trending = async () => (await get("/api/topics")).topics;

    // A topic repeated inside one post counts once, whatever the casing.
    const first = await create("Launch day #Launch #launch #LAUNCH #party");
    assert.deepEqual(first.topics, ["launch", "party"]);
    const second = await create("Second look at #launch");
    await create("Nothing tagged here");
    assert.deepEqual(await trending(), [
      { name: "launch", count: 2 },
      { name: "party", count: 1 },
    ]);
    assert.equal((await get("/api/topics")).windowHours, 24);

    const reply = await create("agreed #launch", first.id);
    assert.deepEqual(reply.topics, ["launch"]);
    assert.ok((await get("/api/posts")).posts.every((post) => post.id !== reply.id));
    assert.deepEqual(await trending(), [
      { name: "launch", count: 3 },
      { name: "party", count: 1 },
    ]);

    // Only the last 24 hours count towards trending; the feed total is all-time.
    const old = await create("Old news #ancient #launch");
    await pool.query("UPDATE posts SET created_at = now() - interval '25 hours' WHERE id = $1", [old.id]);
    assert.deepEqual(await trending(), [
      { name: "launch", count: 3 },
      { name: "party", count: 1 },
    ]);
    assert.deepEqual((await get("/api/topics/launch")).topic, { name: "launch", posts: 4 });
    assert.deepEqual((await get("/api/topics/LAUNCH")).topic, { name: "launch", posts: 4 });
    assert.deepEqual((await get("/api/topics/unused")).topic, { name: "unused", posts: 0 });

    // Only the three most used topics are returned, ties broken by recency.
    await create("#alpha #beta");
    const top = await trending();
    assert.equal(top.length, 3);
    assert.deepEqual(top[0], { name: "launch", count: 3 });
    assert.deepEqual(top.slice(1).map((topic) => topic.count), [1, 1]);

    // The topic feed includes posts and replies, newest first.
    const feed = await get("/api/posts?topic=launch");
    assert.deepEqual(feed.posts.map((post) => post.id), [reply.id, second.id, first.id, old.id]);
    assert.equal((await get("/api/posts?topic=Launch")).posts.length, 4);
    assert.equal((await get("/api/posts?topic=unused")).posts.length, 0);
    assert.ok(feed.posts.every((post) => post.topics.includes("launch")));

    // Replies come with the thread above them, root first; posts have none.
    assert.deepEqual(feed.posts.find((post) => post.id === reply.id).ancestors.map((post) => post.id), [first.id]);
    assert.ok(feed.posts.filter((post) => post.id !== reply.id).every((post) => post.ancestors.length === 0));
    const middle = await create("no tags here", reply.id);
    const deep = await create("deep #threaded", middle.id);
    const threaded = (await get("/api/posts?topic=threaded")).posts;
    assert.deepEqual(threaded.map((post) => post.id), [deep.id]);
    assert.deepEqual(threaded[0].ancestors.map((post) => post.id), [first.id, reply.id, middle.id]);
    assert.equal(threaded[0].ancestors[0].author.handle, "topic_author");
    // The home feed and reply lists keep their shape.
    assert.ok((await get("/api/posts")).posts.every((post) => !("ancestors" in post)));
    assert.equal((await request(`/api/posts/${deep.id}`, "DELETE")).status, 204);
    assert.equal((await request(`/api/posts/${middle.id}`, "DELETE")).status, 204);
    for (let index = 0; index < 22; index++) await create("paged #paging");
    const page = await get("/api/posts?topic=paging");
    assert.equal(page.posts.length, 20);
    assert.ok(page.nextCursor);
    const rest = await get(`/api/posts?topic=paging&cursor=${page.nextCursor}`);
    assert.equal(rest.posts.length, 2);
    assert.equal(rest.nextCursor, null);
    assert.equal(new Set([...page.posts, ...rest.posts].map((post) => post.id)).size, 22);

    // Suggestions are existing topics by prefix, most used first.
    assert.deepEqual((await get("/api/topics?prefix=la")).topics, [{ name: "launch", count: 4 }]);
    assert.deepEqual((await get("/api/topics?prefix=LA")).topics, [{ name: "launch", count: 4 }]);
    assert.deepEqual((await get("/api/topics?prefix=zzz")).topics, []);
    assert.deepEqual((await get("/api/topics?prefix=pa")).topics.map((topic) => topic.name), ["paging", "party"]);
    // "_" is not a wildcard.
    assert.deepEqual((await get("/api/topics?prefix=a_")).topics, []);

    for (const path of ["/api/topics?prefix=", "/api/topics?prefix=1a", "/api/topics?prefix=a-b", "/api/topics/9lives", "/api/posts?topic=%23x", "/api/posts?topic="]) {
      const response = await request(path, "GET", undefined, false);
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), { error: "invalid_topic" });
    }

    // Editing re-derives the topics; dropping every hashtag clears them.
    const edited = await request(`/api/posts/${first.id}`, "PATCH", { content: "Edited #party #fresh" });
    assert.equal(edited.status, 200);
    assert.deepEqual((await edited.json()).post.topics, ["fresh", "party"]);
    assert.deepEqual((await get(`/api/posts/${first.id}`)).post.topics, ["fresh", "party"]);
    assert.equal((await get("/api/posts?topic=launch")).posts.some((post) => post.id === first.id), false);
    await request(`/api/posts/${first.id}`, "PATCH", { content: "No hashtags left" });
    assert.deepEqual((await get(`/api/posts/${first.id}`)).post.topics, []);

    // Deleting a post (and its topics) lowers the counts.
    assert.equal((await request(`/api/posts/${second.id}`, "DELETE")).status, 204);
    assert.deepEqual((await get("/api/topics/launch")).topic, { name: "launch", posts: 2 });
    assert.equal((await get("/api/topics?prefix=launch")).topics[0].count, 2);

    // Replies in a thread and profile posts expose topics too.
    const profile = await get("/api/profiles/topic_author");
    assert.ok(profile.posts.every((post) => Array.isArray(post.topics)));
    assert.deepEqual((await get(`/api/posts/${first.id}/thread`)).replies[0].topics, ["launch"]);
    const replyEdit = await request(`/api/posts/${reply.id}`, "PATCH", { content: "Edited #newthing" });
    assert.equal(replyEdit.status, 200);
    assert.deepEqual((await replyEdit.json()).post.topics, ["newthing"]);
    assert.deepEqual((await get("/api/posts?topic=newthing")).posts.map((post) => post.id), [reply.id]);
    assert.deepEqual((await get("/api/posts?topic=launch")).posts.map((post) => post.id), [old.id]);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
