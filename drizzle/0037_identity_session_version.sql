ALTER TABLE "auth_identities" ADD COLUMN "session_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "auth_identities" AS identity
SET "session_version" = account."session_version"
FROM "users" AS account
WHERE account."id" = identity."user_id";--> statement-breakpoint
-- Sessions issued before an account was removed must stay invalid when its identity is reused.
UPDATE "auth_identities" AS identity
SET "session_version" = COALESCE((
  SELECT max(session."session_version") FROM "auth_sessions" AS session
  WHERE session."identity_id" = identity."id"
), 0) + 1
WHERE identity."deleted_at" IS NOT NULL;
