CREATE TABLE "post_mentions" (
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"handle" text NOT NULL,
	CONSTRAINT "post_mentions_post_id_user_id_handle_pk" PRIMARY KEY("post_id","user_id","handle")
);
--> statement-breakpoint
ALTER TABLE "post_mentions" ADD CONSTRAINT "post_mentions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_mentions" ADD CONSTRAINT "post_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Resolve existing text once, keeping the user ID even if their handle later changes.
INSERT INTO post_mentions (post_id, user_id, handle)
SELECT DISTINCT p.id, u.id, lower(m.parts[1])
FROM posts p
CROSS JOIN LATERAL regexp_matches(p.content,
  '(?<![[:alnum:]_@/.])@([a-zA-Z0-9_]{3,32})(?![[:alnum:]_])', 'g') AS m(parts)
JOIN users u ON u.handle = lower(m.parts[1])
ON CONFLICT DO NOTHING;
