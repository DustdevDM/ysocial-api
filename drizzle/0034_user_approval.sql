ALTER TABLE "users" ADD COLUMN "approved_at" timestamp (3) with time zone;--> statement-breakpoint
UPDATE "users" SET "approved_at" = now();--> statement-breakpoint
CREATE INDEX "users_waitlist_idx" ON "users" USING btree ("created_at","id") WHERE "users"."approved_at" is null;
