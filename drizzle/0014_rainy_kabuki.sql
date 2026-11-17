ALTER TABLE "push_subscriptions" ADD COLUMN "muted_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "muted_forever" boolean DEFAULT false NOT NULL;