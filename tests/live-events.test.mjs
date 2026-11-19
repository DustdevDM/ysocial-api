import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { config } from "dotenv";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";

config({ path: new URL("../.env", import.meta.url), quiet: true });

function reader(response) {
  const decoder = new TextDecoder();
  const source = response.body.getReader();
  let buffer = "";
  return {
    async frame(timeout = 5000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          return frame;
        }
        const chunk = await Promise.race([
          source.read(),
          new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, deadline - Date.now()), "timeout"),
          ),
        ]);
        if (chunk === "timeout") throw new Error("Timed out waiting for a frame");
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async event(name) {
      for (;;) {
        const frame = await this.frame();
        if (frame === null) return null;
        const lines = frame.split("\n");
        if (lines.includes(`event: ${name}`)) {
          const data = lines.find((line) => line.startsWith("data: "));
          return JSON.parse(data.slice(6));
        }
      }
    },
  };
}

test("live post stream", async (t) => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const name = `ysocial_live_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  let pool, server, stop;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      NODE_ENV: "test",
      KLIPY_API_KEY: "live-tests-key",
      LIVE_MAX_STREAMS: "3",
    });
    const { app } = await import("../src/app.ts");
    const database = await import("../src/db/index.ts");
    pool = database.pool;
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const { env } = await import("../src/config.ts");
    const { hash } = await import("../src/auth/secrets.ts");
    const { startLiveEvents, publishLivePost } = await import("../src/live-events.ts");
    const { rows: [user] } = await pool.query(
      "INSERT INTO users (handle, approved_at) VALUES ('live_author', now()) RETURNING id",
    );
    const { rows: [identity] } = await pool.query(
      "INSERT INTO auth_identities (issuer, subject, user_id) VALUES ('https://test.invalid', 'live-author', $1) RETURNING id",
      [user.id],
    );
    const token = randomUUID();
    await pool.query(
      "INSERT INTO auth_sessions (token_hash, identity_id, encrypted_tokens, refresh_after, expires_at) VALUES ($1, $2, 'unused', now() + interval '1 day', now() + interval '2 days')",
      [hash(token), identity.id],
    );
    stop = startLiveEvents();
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (path, method = "GET", body) =>
      fetch(base + path, {
        method,
        headers: {
          Origin: env.APP_ORIGIN,
          Cookie: `session=${token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    async function create(content, parentId, clientId = randomUUID()) {
      const response = await request(
        parentId ? `/api/posts/${parentId}/replies` : "/api/posts",
        "POST",
        { content, clientId },
      );
      assert.equal(response.status, 201);
      return (await response.json()).post;
    }
    async function open() {
      const controller = new AbortController();
      const response = await fetch(`${base}/api/live`, { signal: controller.signal });
      assert.equal(response.status, 200);
      const stream = reader(response);
      assert.equal(await stream.frame(), "retry: 3000");
      return { response, stream, controller };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    await t.test("sends event stream headers", async () => {
      const { response, controller } = await open();
      assert.match(response.headers.get("content-type"), /^text\/event-stream/);
      assert.match(response.headers.get("cache-control"), /no-cache/);
      assert.equal(response.headers.get("x-accel-buffering"), "no");
      controller.abort();
    });

    await t.test("announces new posts and replies with their topics", async () => {
      const { stream, controller } = await open();
      const post = await create("Hello #Live world");
      assert.deepEqual(await stream.event("post"), {
        id: post.id,
        parentId: null,
        authorId: user.id,
        topics: ["live"],
      });
      const reply = await create("An answer", post.id);
      assert.deepEqual(await stream.event("post"), {
        id: reply.id,
        parentId: post.id,
        authorId: user.id,
        topics: [],
      });
      controller.abort();
    });

    await t.test("retried writes and rolled back transactions stay silent", async () => {
      const { stream, controller } = await open();
      const clientId = randomUUID();
      const first = await create("Once only", undefined, clientId);
      await create("Once only", undefined, clientId);
      await assert.rejects(
        database.db.transaction(async (tx) => {
          await publishLivePost(tx, {
            id: randomUUID(),
            parentId: null,
            authorId: user.id,
            topics: [],
          });
          throw new Error("rollback");
        }),
        /rollback/,
      );
      const marker = await create("Marker");
      assert.equal((await stream.event("post")).id, first.id);
      assert.equal((await stream.event("post")).id, marker.id);
      controller.abort();
    });

    await t.test("serves every open stream and caps their number", async () => {
      const streams = [await open(), await open(), await open()];
      const refused = await fetch(`${base}/api/live`);
      assert.equal(refused.status, 503);
      assert.equal((await refused.json()).error, "live_unavailable");
      const post = await create("Fan out");
      for (const { stream } of streams) assert.equal((await stream.event("post")).id, post.id);
      for (const { controller } of streams) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const again = await open();
      again.controller.abort();
    });

    await t.test("announces reactions, edits and deletions with the posts they touch", async () => {
      const root = await create("Root");
      const reply = await create("Reply", root.id);
      const nested = await create("Nested", reply.id);
      const { stream, controller } = await open();
      assert.equal((await request(`/api/posts/${nested.id}/like`, "PUT")).status, 200);
      assert.deepEqual(await stream.event("change"), { ids: [nested.id] });
      assert.equal((await request(`/api/posts/${nested.id}/like`, "DELETE")).status, 200);
      assert.deepEqual(await stream.event("change"), { ids: [nested.id] });
      assert.equal((await request(`/api/posts/${root.id}/repost`, "PUT", {})).status, 200);
      assert.deepEqual(await stream.event("change"), { ids: [root.id] });
      assert.deepEqual(await stream.event("post"), {
        id: root.id,
        parentId: null,
        authorId: user.id,
        topics: [],
        reposted: true,
      });
      const deeper = await create("Deeper", nested.id);
      assert.equal((await stream.event("post")).id, deeper.id);
      assert.deepEqual(
        new Set((await stream.event("change")).ids),
        new Set([deeper.id, nested.id, reply.id, root.id]),
      );
      assert.equal((await request(`/api/posts/${deeper.id}`, "PATCH", { content: "Deeper edit" })).status, 200);
      assert.deepEqual(
        new Set((await stream.event("change")).ids),
        new Set([deeper.id, nested.id, reply.id, root.id]),
      );
      assert.equal((await request(`/api/posts/${deeper.id}`, "DELETE")).status, 204);
      assert.deepEqual(
        new Set((await stream.event("change")).ids),
        new Set([deeper.id, nested.id, reply.id, root.id]),
      );
      controller.abort();
    });

    await t.test("returns fresh state for the posts asked about", async () => {
      const post = await create("State check");
      await request(`/api/posts/${post.id}/like`, "PUT");
      const gone = randomUUID();
      const response = await request(`/api/posts/states?ids=${post.id},${gone}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.viewerId, user.id);
      assert.equal(body.posts.length, 1);
      assert.equal(body.posts[0].id, post.id);
      assert.equal(body.posts[0].likes, 1);
      assert.equal(body.posts[0].liked, true);
      assert.equal((await request("/api/posts/states?ids=nope")).status, 400);
    });

    await t.test("ends open streams when live events stop", async () => {
      const { stream } = await open();
      stop();
      stop = undefined;
      assert.equal(await stream.frame(), null);
    });
  } finally {
    stop?.();
    server?.closeAllConnections();
    server?.close();
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
