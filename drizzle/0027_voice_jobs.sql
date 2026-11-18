CREATE TABLE "voice_jobs" (
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"input" "bytea",
	"voice" jsonb,
	"error" text,
	"lease" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "voice_jobs_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "voice_jobs_one_state" CHECK (num_nonnulls("voice_jobs"."input", "voice_jobs"."voice", "voice_jobs"."error") = 1)
);
--> statement-breakpoint
ALTER TABLE "voice_jobs" ADD CONSTRAINT "voice_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_jobs_user_pending_idx" ON "voice_jobs" USING btree ("user_id") WHERE "voice_jobs"."input" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "voice_jobs_due_idx" ON "voice_jobs" USING btree ("next_attempt_at") WHERE "voice_jobs"."input" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "voice_jobs_expiry_idx" ON "voice_jobs" USING btree ("expires_at");