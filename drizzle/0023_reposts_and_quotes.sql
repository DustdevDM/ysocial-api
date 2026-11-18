ALTER TYPE "public"."notification_kind" ADD VALUE 'quote';--> statement-breakpoint
ALTER TABLE "post_reposts" ADD COLUMN "audience" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "quoted_post_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "is_quote" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_quoted_post_id_posts_id_fk" FOREIGN KEY ("quoted_post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_reposts_post_idx" ON "post_reposts" USING btree ("post_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_quoted_idx" ON "posts" USING btree ("quoted_post_id") WHERE "posts"."quoted_post_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "post_reposts" ADD CONSTRAINT "post_reposts_audience_check" CHECK ("post_reposts"."audience" IN ('public', 'friends'));--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_quote_check" CHECK (("posts"."is_quote" OR "posts"."quoted_post_id" IS NULL) AND (NOT "posts"."is_quote" OR "posts"."parent_id" IS NULL));