CREATE TABLE "artifact_capability_quotas" (
	"purpose" text NOT NULL,
	"audience" text NOT NULL,
	"nonce" text NOT NULL,
	"fingerprint" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"calls" bigint NOT NULL,
	"cumulative_bytes" bigint NOT NULL,
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
ALTER TABLE "artifacts" ADD COLUMN "deletion_state" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "write_lease_id" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "write_lease_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "artifacts" AS "artifact"
SET "manifest_version" = 'artifact-manifest-v1',
	"deletion_state" = CASE
		WHEN "artifact"."deleted_at" IS NULL THEN 'active'
		ELSE 'deleted'
	END
FROM "workflow_runs" AS "run"
WHERE "run"."id" = "artifact"."run_id"
	AND "artifact"."key" LIKE 'artifact-manifest/v1/%'
	AND "artifact"."uri" IS NOT NULL
	AND "artifact"."media_type" IS NOT NULL
	AND "artifact"."size_bytes" IS NOT NULL
	AND "artifact"."size_bytes" BETWEEN 0 AND 9007199254740991
	AND "artifact"."media_type" = lower(btrim("artifact"."media_type"))
	AND (
		split_part("artifact"."media_type", ';', 1) LIKE 'text/%'
			AND split_part("artifact"."media_type", ';', 1) NOT IN ('text/html', 'text/javascript')
		OR split_part("artifact"."media_type", ';', 1) IN (
			'application/json',
			'application/x-ndjson',
			'application/xml',
			'application/junit+xml',
			'application/vnd.agentos.patch+json',
			'application/octet-stream',
			'application/zip',
			'application/gzip',
			'application/x-tar'
		)
	)
	AND "artifact"."media_type" IN (
		split_part("artifact"."media_type", ';', 1),
		split_part("artifact"."media_type", ';', 1) || '; charset=utf-8'
	)
	AND "artifact"."cleanup_at" IS NOT NULL
	AND "artifact"."retention_class" IN ('source-bundle', 'cloud-session-upload', 'working')
	AND "artifact"."cleanup_at" > "artifact"."created_at"
	AND "artifact"."cleanup_at" <= "artifact"."created_at" + CASE "artifact"."retention_class"
		WHEN 'working' THEN interval '30 days'
		ELSE interval '23 hours 45 minutes'
	END
	AND "artifact"."digest" ~ '^[0-9a-f]{64}$'
	AND split_part("artifact"."key", '/', 3) ~ '^[A-Za-z0-9]([A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$'
	AND split_part("artifact"."key", '/', 3) NOT LIKE '%..%'
	AND split_part("artifact"."key", '/', 4) ~ '^[A-Za-z0-9]([A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$'
	AND split_part("artifact"."key", '/', 4) NOT LIKE '%..%'
	AND CASE
		WHEN split_part("artifact"."key", '/', 5) ~ '^[1-9][0-9]{0,9}$'
		THEN split_part("artifact"."key", '/', 5)::bigint BETWEEN 1 AND 2147483647
		ELSE false
	END
	AND "artifact"."key" = 'artifact-manifest/v1/'
		|| split_part("artifact"."key", '/', 3) || '/'
		|| split_part("artifact"."key", '/', 4) || '/'
		|| split_part("artifact"."key", '/', 5)
	AND "artifact"."uri" = 'artifacts/v1/'
		|| "run"."project_id" || '/'
		|| "artifact"."run_id" || '/'
		|| split_part("artifact"."key", '/', 3) || '/'
		|| split_part("artifact"."key", '/', 4) || '/'
		|| split_part("artifact"."key", '/', 5) || '/sha256/'
		|| "artifact"."digest"
	AND "artifact"."digest" = split_part("artifact"."uri", '/', 9);--> statement-breakpoint
CREATE INDEX "artifact_capability_quotas_expiry_idx" ON "artifact_capability_quotas" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "artifacts_cleanup_idx" ON "artifacts" USING btree ("cleanup_at") WHERE "artifacts"."cleanup_at" is not null and "artifacts"."deleted_at" is null and "artifacts"."manifest_version" = 'artifact-manifest-v1' and "artifacts"."deletion_state" in ('active', 'pending');
