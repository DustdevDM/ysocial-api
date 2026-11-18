CREATE TABLE "avatar_history" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "avatar_history" ADD CONSTRAINT "avatar_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "avatar_history_user_idx" ON "avatar_history" USING btree ("user_id","used_at" DESC NULLS LAST);