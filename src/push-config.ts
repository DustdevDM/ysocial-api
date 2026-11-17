import { z } from "zod";
import { createECDH, ECDH } from "node:crypto";

const optional = (schema: z.ZodString) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );
export const pushConfigSchema = z
  .object({
    VAPID_PUBLIC_KEY: optional(z.string().regex(/^[A-Za-z0-9_-]{87}$/)),
    VAPID_PRIVATE_KEY: optional(z.string().regex(/^[A-Za-z0-9_-]{43}$/)),
    VAPID_SUBJECT: optional(
      z.string().refine((value) => {
        try {
          return ["mailto:", "https:"].includes(new URL(value).protocol);
        } catch {
          return false;
        }
      }),
    ),
  })
  .transform((value, ctx) => {
    const {
      VAPID_PUBLIC_KEY: publicKey,
      VAPID_PRIVATE_KEY: privateKey,
      VAPID_SUBJECT: subject,
    } = value;
    if (!publicKey && !privateKey && !subject) return null;
    if (!publicKey || !privateKey || !subject) {
      ctx.addIssue({
        code: "custom",
        message:
          "Set all three VAPID values together, or leave them empty to disable push",
      });
      return z.NEVER;
    }
    try {
      const pair = createECDH("prime256v1");
      pair.setPrivateKey(Buffer.from(privateKey, "base64url"));
      if (!pair.getPublicKey().equals(Buffer.from(publicKey, "base64url")))
        throw new Error();
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "VAPID keys must be a matching P-256 key pair",
      });
      return z.NEVER;
    }
    return { publicKey, privateKey, subject };
  });

// Push endpoints are server-side destinations supplied by a browser. Restrict
// them to browser push services so this route cannot reach arbitrary hosts.
export const endpointSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    const host = url.hostname;
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (host === "fcm.googleapis.com" ||
        host === "updates.push.services.mozilla.com" ||
        host === "web.push.apple.com" ||
        host.endsWith(".push.apple.com") ||
        host.endsWith(".notify.windows.com"))
    );
  });
export const subscriptionSchema = z.object({
  endpoint: endpointSchema,
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({
    p256dh: z
      .string()
      .regex(/^[A-Za-z0-9_-]{87}={0,1}$/)
      .refine((value) => {
        try {
          const key = Buffer.from(value, "base64url");
          return (
            key[0] === 4 && ECDH.convertKey(key, "prime256v1").length === 65
          );
        } catch {
          return false;
        }
      }),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}={0,2}$/),
  }),
});
