import { Router } from "express";
import { z } from "zod";
import { AuthError } from "./auth/provider.ts";
import { env } from "./config.ts";
import { findPost } from "./posts.ts";
import { avatarDataUri, renderPostCard } from "./og/post-card.ts";
import { metaPage, postMeta, postSummary, type OgPost } from "./og/text.ts";
import { getAvatar } from "./storage/r2.ts";

const router = Router();

const cache = new Map<string, { png: Buffer; at: number }>();
const cacheMs = 5 * 60_000;

router.use("/posts/:id", (req, _res, next) => {
  const id = req.params.id.replace(/\.png$/, "");
  if (!z.uuid().safeParse(id).success) throw new AuthError(404, "post_not_found");
  next();
});

async function avatarFor(avatarUrl: string | null) {
  const key = /^\/api\/(avatars\/[a-f0-9-]{36}\.(?:avif|png))$/.exec(avatarUrl ?? "")?.[1];
  if (!key) return null;
  try {
    return await avatarDataUri(await getAvatar(key));
  } catch {
    return null;
  }
}

router.get("/posts/:id.png", async (req, res) => {
  const id = req.params.id;
  const hit = cache.get(id);
  let png = hit && Date.now() - hit.at < cacheMs ? hit.png : undefined;
  if (!png) {
    const post = await findPost(id);
    png = await renderPostCard(post, await avatarFor(post.author.avatarUrl));
    if (cache.size >= 300) cache.delete(cache.keys().next().value!);
    cache.set(id, { png, at: Date.now() });
  }
  res
    .set({
      "Cache-Control": "public, max-age=300, s-maxage=3600",
      "X-Content-Type-Options": "nosniff",
    })
    .type("image/png")
    .send(png);
});

router.get("/posts/:id", async (req, res) => {
  const post: OgPost = await findPost(req.params.id);
  res
    .set("Cache-Control", "public, max-age=60")
    .type("html")
    .send(metaPage(postMeta(post, env.APP_ORIGIN), postSummary(post)));
});

export default router;
