ALTER TABLE "posts" DROP CONSTRAINT "posts_content_check";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "voice" jsonb;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_content_check" CHECK (char_length("posts"."content") <= 2000 AND ("posts"."content" ~ '[^[:space:]]' OR ("posts"."content" = '' AND ("posts"."gif" IS NOT NULL OR "posts"."poll" IS NOT NULL OR "posts"."voice" IS NOT NULL))));
--> statement-breakpoint
CREATE INDEX posts_voice_key_idx ON posts ((voice->>'key')) WHERE voice IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION queue_deleted_post_voice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.voice IS NOT NULL THEN
    INSERT INTO media_deletions (key) VALUES (OLD.voice->>'key')
    ON CONFLICT (key) DO UPDATE SET available_at = now();
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER posts_voice_cleanup AFTER DELETE ON posts
FOR EACH ROW EXECUTE FUNCTION queue_deleted_post_voice();
