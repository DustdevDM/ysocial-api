import {
  stageMediaUpload,
  replaceProfileMedia,
  removeRecentAvatar,
  recentAvatarLimit,
} from "./storage/media-lifecycle.ts";
import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { readViewerId, requireUser } from "./auth/request.ts";
import { AuthError } from "./auth/provider.ts";
import { db } from "./db/index.ts";
import { avatarHistory, users } from "./db/schema.ts";
import { avatarUploadLimit, normalizeAvatar } from "./storage/avatar-image.ts";
import { getAvatar, requireAvatarStorage } from "./storage/r2.ts";

const router = Router();
router.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  next();
});
router.put("/me", async (req, res) => {
  // Authenticate and check the origin before buffering any upload.
  const viewer = await requireUser(req);
  requireAvatarStorage();
  if (!req.is("image/png")) throw new AuthError(415, "avatar_png_required");
  await new Promise<void>((resolve, reject) => {
    express.raw({ type: "image/png", limit: avatarUploadLimit })(
      req,
      res,
      (error) => (error ? reject(error) : resolve()),
    );
  });
  if (!Buffer.isBuffer(req.body)) throw new AuthError(400, "invalid_avatar");
  const image = await normalizeAvatar(req.body);
  const key = `avatars/${randomUUID()}.avif`;
  // Store first. Failed writes never replace the currently saved avatar.
  await stageMediaUpload(key, image);
  await replaceProfileMedia(viewer.id, { kind: "avatar", key });
  res.json({ avatarUrl: `/api/${key}` });
});
function avatarFile(value: unknown) {
  const file = z
    .string()
    .regex(/^[a-f0-9-]{36}\.(avif|png)$/)
    .safeParse(value);
  if (
    !file.success ||
    !z.string().uuid().safeParse(file.data.split(".")[0]).success
  )
    throw new AuthError(404, "avatar_not_found");
  return file.data;
}
router.get("/recent", async (req, res) => {
  const viewerId = await readViewerId(req);
  if (!viewerId) throw new AuthError(401, "sign_in_required");
  const rows = await db
    .select({ key: avatarHistory.key })
    .from(avatarHistory)
    .innerJoin(users, eq(users.id, avatarHistory.userId))
    .where(
      and(
        eq(avatarHistory.userId, viewerId),
        sql`${avatarHistory.key} is distinct from ${users.avatarKey}`,
      ),
    )
    .orderBy(desc(avatarHistory.usedAt))
    .limit(recentAvatarLimit);
  res.json({
    avatars: rows.map(({ key }) => ({
      id: key.slice("avatars/".length),
      avatarUrl: `/api/${key}`,
    })),
  });
});
router.post("/recent/:file", async (req, res) => {
  const viewer = await requireUser(req);
  const key = `avatars/${avatarFile(req.params.file)}`;
  await replaceProfileMedia(viewer.id, { kind: "avatar", key, fromRecent: true });
  res.json({ avatarUrl: `/api/${key}` });
});
router.delete("/recent/:file", async (req, res) => {
  const viewer = await requireUser(req);
  await removeRecentAvatar(viewer.id, `avatars/${avatarFile(req.params.file)}`);
  res.sendStatus(204);
});
router.get("/:file", async (req, res) => {
  // Keep previously uploaded PNG avatars readable.
  const key = `avatars/${avatarFile(req.params.file)}`;
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.avatarKey, key))
    .limit(1);
  if (!user) {
    const viewerId = await readViewerId(req);
    const [recent] = viewerId
      ? await db
          .select({ key: avatarHistory.key })
          .from(avatarHistory)
          .where(
            and(eq(avatarHistory.key, key), eq(avatarHistory.userId, viewerId)),
          )
          .limit(1)
      : [];
    if (!recent) throw new AuthError(404, "avatar_not_found");
    res.set("Cache-Control", "private, max-age=3600");
  }
  const body = await getAvatar(key);
  res
    .type(key.endsWith(".avif") ? "image/avif" : "image/png")
    .send(Buffer.from(body));
});
export default router;
