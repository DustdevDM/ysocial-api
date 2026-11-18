import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../config.ts";
import { AuthError } from "../auth/provider.ts";

export const voiceSchema = z.object({
  key: z.string().regex(/^voices\/[a-f0-9-]{36}\.m4a$/),
  url: z.string(),
  durationMs: z.number().int().min(2000).max(120000),
  bytes: z.number().int().positive(),
  waveform: z.array(z.number().int().min(0).max(100)).length(48).optional(),
});
export type Voice = z.infer<typeof voiceSchema>;
export const voiceDraftLifetimeMs = 30 * 60 * 1000;
const selectionSchema = z.object({
  voice: voiceSchema,
  userId: z.uuid(),
  expires: z.number(),
});
function signature(payload: string) {
  if (!env.SESSION_ENCRYPTION_KEY)
    throw new AuthError(503, "voice_not_configured");
  return createHmac("sha256", env.SESSION_ENCRYPTION_KEY)
    .update(`voice:${payload}`)
    .digest();
}
export function signVoice(voice: Voice, userId: string, expires = Date.now() + voiceDraftLifetimeMs) {
  const payload = Buffer.from(
    JSON.stringify({ voice, userId, expires }),
  ).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}
export function readVoiceSelection(token: string, userId: string) {
  const [payload, signed, extra] = token.split(".");
  if (!payload || !signed || extra !== undefined)
    throw new AuthError(400, "invalid_voice_selection");
  const expected = signature(payload),
    actual = Buffer.from(signed, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new AuthError(400, "invalid_voice_selection");
  try {
    const data = selectionSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    );
    if (data.userId !== userId) throw new Error();
    return data;
  } catch {
    throw new AuthError(400, "invalid_voice_selection");
  }
}
