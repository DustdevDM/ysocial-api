CREATE TABLE "moderation_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_handle" text NOT NULL,
	"target_id" uuid NOT NULL,
	"target_handle" text NOT NULL,
	"action" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "moderation_activity_created_idx" ON "moderation_activity" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);