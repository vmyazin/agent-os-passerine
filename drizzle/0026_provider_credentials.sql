CREATE TABLE "provider_credentials" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"sealed_api_key" text NOT NULL,
	"hint" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "provider_credentials_bounded_text" CHECK (length("provider_credentials"."provider_id") between 1 and 64 and length("provider_credentials"."sealed_api_key") between 1 and 32768 and length("provider_credentials"."hint") between 0 and 8)
);
