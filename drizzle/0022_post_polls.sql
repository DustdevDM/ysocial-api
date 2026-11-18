CREATE TABLE "poll_votes" (
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"option_index" integer NOT NULL,
	CONSTRAINT "poll_votes_post_id_user_id_pk" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "posts" DROP CONSTRAINT "posts_content_check";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "poll" jsonb;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "poll_votes_option_idx" ON "poll_votes" USING btree ("post_id","option_index","user_id");--> statement-breakpoint
CREATE INDEX "poll_votes_user_idx" ON "poll_votes" USING btree ("user_id");--> statement-breakpoint
-- Preserve legacy blank posts while enforcing the rule on inserts and updates.
ALTER TABLE "posts" ADD CONSTRAINT "posts_content_check" CHECK (char_length("posts"."content") <= 2000 AND ("posts"."content" ~ '[^[:space:]]' OR ("posts"."content" = '' AND ("posts"."gif" IS NOT NULL OR "posts"."poll" IS NOT NULL)))) NOT VALID;
