import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { config } from "dotenv";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";

config({ path: new URL("../.env", import.meta.url), quiet: true });

test("post and reply flows", async (t) => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_replies_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  let pool, server;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      NODE_ENV: "test",
      KLIPY_API_KEY: "reply-tests-key",
      R2_ACCOUNT_ID: "a".repeat(32),
      R2_BUCKET: "reply-tests",
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
      "INSERT INTO users (handle) VALUES ('reply_author') RETURNING id",
    );
    const { rows: [identity] } = await pool.query(
      "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', 'reply-author', $1) RETURNING id",
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
    async function request(path, method = "GET", body) {
      return fetch(base + path, {
        method,
        headers: {
          Origin: env.APP_ORIGIN,
          Cookie: `session=${token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    async function get(path) {
      const response = await request(path);
      assert.equal(response.status, 200);
      return response.json();
    }
    async function create(parentId, clientId = randomUUID()) {
      const response = await request(
        parentId ? `/api/posts/${parentId}/replies` : "/api/posts",
        "POST",
        { content: "Reply count regression", clientId },
      );
      assert.equal(response.status, 201);
      return (await response.json()).post;
    }
    async function count(id, expected) {
      assert.equal((await get(`/api/posts/${id}`)).post.replies, expected);
    }

    await t.test("reply totals include every descendant and track subtree deletion", async () => {
      const root = await create();
      const unrelated = await create();
      await create(unrelated.id);
      await count(root.id, 0);
      const comment = await create(root.id);
      await count(root.id, 1);
      const replyId = randomUUID();
      const reply = await create(comment.id, replyId);
      await count(root.id, 2);
      await count(comment.id, 1);
      // Retrying the same write must not inflate any ancestor's total.
      assert.equal((await create(comment.id, replyId)).id, reply.id);
      await create(reply.id);
      const sibling = await create(root.id);
      await count(root.id, 4);
      await count(comment.id, 2);
      await count(reply.id, 1);
      await count(sibling.id, 0);
      await count(unrelated.id, 1);

      const feed = await get("/api/posts");
      assert.equal(feed.posts.find((post) => post.id === root.id).replies, 4);
      const children = await get(`/api/posts/${root.id}/replies`);
      assert.deepEqual(new Set(children.posts.map((post) => post.id)), new Set([comment.id, sibling.id]));
      assert.equal(children.posts.find((post) => post.id === comment.id).replies, 2);
      const profile = await get("/api/profiles/reply_author");
      assert.equal(profile.posts.find((post) => post.id === root.id).replies, 4);
      assert.equal(profile.replies.find(({ post }) => post.id === reply.id).thread[0].replies, 4);

      assert.equal((await request(`/api/posts/${reply.id}`, "DELETE")).status, 204);
      await count(root.id, 2);
      await count(comment.id, 0);
      assert.equal((await request(`/api/posts/${comment.id}`, "DELETE")).status, 204);
      await count(root.id, 1);
      assert.equal((await request(`/api/posts/${sibling.id}`, "DELETE")).status, 204);
      await count(root.id, 0);
      await count(unrelated.id, 1);
    });

    await t.test("KLIPY GIFs survive publishing, retries, and caption edits", async () => {
      const url = "https://static.klipy.com/test/wave.gif";
      const title = "Waving hello";
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, options) => {
        const target = new URL(input);
        if (target.hostname !== "api.klipy.com") return originalFetch(input, options);
        assert.equal(target.pathname, `/api/v1/${env.KLIPY_API_KEY}/gifs/search`);
        assert.equal(target.searchParams.get("q"), "wave");
        return Promise.resolve(Response.json({
          result: true,
          data: { data: [{
            slug: "wave",
            title,
            type: "gif",
            file: { hd: { gif: { url } }, sm: { gif: { url } } },
          }] },
        }));
      };
      let gifToken;
      try {
        const response = await request("/api/banners/gifs/search", "POST", { query: "wave" });
        assert.equal(response.status, 200);
        gifToken = (await response.json()).items[0].token;
      } finally {
        globalThis.fetch = originalFetch;
      }

      const clientId = randomUUID();
      const send = (body) => request("/api/posts", "POST", body);
      assert.equal((await send({ content: " " })).status, 400);
      assert.equal((await send({ gifToken: `${gifToken}tampered` })).status, 400);
      const response = await send({ clientId, gifToken });
      assert.equal(response.status, 201);
      const { post } = await response.json();
      assert.equal(post.content, "");
      assert.deepEqual(post.gif, { url, title });
      assert.equal((await send({ clientId, gifToken })).status, 201);
      assert.equal((await send({ clientId, content: "Different post" })).status, 409);

      const [payload] = gifToken.split(".");
      const expired = Buffer.from(JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        expires: Date.now() - 1000,
      })).toString("base64url");
      const signature = createHmac("sha256", env.KLIPY_API_KEY).update(expired).digest("base64url");
      const expiredToken = `${expired}.${signature}`;
      assert.equal((await send({ clientId, gifToken: expiredToken })).status, 201);
      assert.equal((await send({ clientId: randomUUID(), gifToken: expiredToken })).status, 400);

      const path = `/api/posts/${post.id}`;
      const reply = await request(`${path}/replies`, "POST", { content: " #hello ", gifToken });
      assert.equal(reply.status, 201);
      const { post: child } = await reply.json();
      assert.equal(child.content, "#hello");
      assert.deepEqual(child.gif, post.gif);

      for (const content of ["Caption", ""]) {
        const edited = await request(path, "PATCH", { content });
        assert.equal(edited.status, 200);
        const result = (await edited.json()).post;
        assert.equal(result.content, content);
        assert.deepEqual(result.gif, post.gif);
      }
      const textOnly = await create();
      assert.equal(textOnly.gif, null);
      assert.equal((await request(`/api/posts/${textOnly.id}`, "PATCH", { content: "" })).status, 400);

      const feed = await get("/api/posts");
      assert.deepEqual(feed.posts.find((row) => row.id === post.id).gif, post.gif);
      const thread = await get(`${path}/thread`);
      assert.deepEqual(thread.post.gif, post.gif);
      assert.deepEqual(thread.replies[0].gif, child.gif);
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
