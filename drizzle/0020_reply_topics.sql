-- Backfill hashtags in existing replies using the same rules as post topics.
INSERT INTO "post_topics" ("post_id", "topic")
SELECT "post_id", "topic" FROM (
	SELECT "post_id", "topic", row_number() OVER (PARTITION BY "post_id" ORDER BY "first_use") AS "rank"
	FROM (
		SELECT p."id" AS "post_id", lower(m."groups"[1]) AS "topic", min(m."n") AS "first_use"
		FROM "posts" p,
			regexp_matches(p."content", '(?<![[:alnum:]_&/#])#([[:alpha:]][[:alnum:]_]{0,31})(?![[:alnum:]_#])', 'g') WITH ORDINALITY AS m("groups", "n")
		WHERE p."parent_id" IS NOT NULL
		GROUP BY p."id", lower(m."groups"[1])
	) found
) ranked
WHERE "rank" <= 10
ON CONFLICT DO NOTHING;
