ALTER TABLE "posts" DROP CONSTRAINT "posts_content_check";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "gif" jsonb;--> statement-breakpoint
-- Preserve legacy blank posts while enforcing the new rule on inserts and updates.
ALTER TABLE "posts" ADD CONSTRAINT "posts_content_check" CHECK (char_length("posts"."content") <= 2000 AND ("posts"."content" ~ '[^[:space:]]' OR ("posts"."content" = '' AND "posts"."gif" IS NOT NULL))) NOT VALID;
