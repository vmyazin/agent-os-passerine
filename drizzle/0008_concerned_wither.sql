CREATE TABLE "artifact_capability_quotas" (
	"purpose" text NOT NULL,
	"audience" text NOT NULL,
	"nonce" text NOT NULL,
	"fingerprint" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"calls" bigint NOT NULL,
	"cumulative_bytes" bigint NOT NULL,
	"operation_ids" text[] NOT NULL,
	"last_operation_replayed" boolean NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "artifact_capability_quotas_purpose_audience_nonce_pk" PRIMARY KEY("purpose","audience","nonce"),
	CONSTRAINT "artifact_capability_quota_calls_positive" CHECK ("artifact_capability_quotas"."calls" > 0),
	CONSTRAINT "artifact_capability_quota_calls_safe_integer" CHECK ("artifact_capability_quotas"."calls" <= 9007199254740991),
	CONSTRAINT "artifact_capability_quota_bytes_nonnegative" CHECK ("artifact_capability_quotas"."cumulative_bytes" >= 0),
	CONSTRAINT "artifact_capability_quota_bytes_safe_integer" CHECK ("artifact_capability_quotas"."cumulative_bytes" <= 9007199254740991),
	CONSTRAINT "artifact_capability_quota_window" CHECK ("artifact_capability_quotas"."expires_at" > "artifact_capability_quotas"."not_before")
);
--> statement-breakpoint
CREATE TABLE "artifact_cleanup_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP INDEX "artifacts_cleanup_idx";--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "manifest_version" text;--> statement-breakpoint
CREATE INDEX "artifact_capability_quotas_expiry_idx" ON "artifact_capability_quotas" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "artifacts_cleanup_idx" ON "artifacts" USING btree ("cleanup_at") WHERE "artifacts"."cleanup_at" is not null and "artifacts"."deleted_at" is null and "artifacts"."manifest_version" = 'artifact-manifest-v1';