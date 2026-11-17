CREATE TABLE "post_topics" (
	"post_id" uuid NOT NULL,
	"topic" text NOT NULL,
	CONSTRAINT "post_topics_post_id_topic_pk" PRIMARY KEY("post_id","topic"),
	CONSTRAINT "post_topics_topic_check" CHECK (char_length("post_topics"."topic") BETWEEN 1 AND 32)
);
--> statement-breakpoint
ALTER TABLE "post_topics" ADD CONSTRAINT "post_topics_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_topics_topic_idx" ON "post_topics" USING btree ("topic","post_id");--> statement-breakpoint
-- Carry existing #hashtags in top-level posts over as topics. Same grammar as
-- src/topics-text.ts: "#" after a non-word character, a letter first, up to 32
-- characters, lowercase, at most 10 distinct topics per post.
INSERT INTO "post_topics" ("post_id", "topic")
SELECT "post_id", "topic" FROM (
	SELECT "post_id", "topic", row_number() OVER (PARTITION BY "post_id" ORDER BY "first_use") AS "rank"
	FROM (
		SELECT p."id" AS "post_id", lower(m."groups"[1]) AS "topic", min(m."n") AS "first_use"
		FROM "posts" p,
			regexp_matches(p."content", '(?<![[:alnum:]_&/#])#([[:alpha:]][[:alnum:]_]{0,31})(?![[:alnum:]_#])', 'g') WITH ORDINALITY AS m("groups", "n")
		WHERE p."parent_id" IS NULL
		GROUP BY p."id", lower(m."groups"[1])
	) found
) ranked
WHERE "rank" <= 10;
