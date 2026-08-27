CREATE TABLE "user_preferences" (
	"login" text PRIMARY KEY NOT NULL,
	"time_zone" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_preferences_required_text" CHECK (length("user_preferences"."login") between 1 and 255 and length("user_preferences"."time_zone") between 1 and 255)
);
