CREATE TABLE "app_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"run_model_id" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "app_settings_singleton" CHECK ("app_settings"."id" = 'global'),
	CONSTRAINT "app_settings_bounded_text" CHECK ("app_settings"."run_model_id" is null or length("app_settings"."run_model_id") between 1 and 255)
);
