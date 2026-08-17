ALTER TABLE "publication_records" ADD CONSTRAINT "publication_records_key_digest" CHECK ("publication_records"."publication_key" ~ '^[0-9a-f]{64}$' and "publication_records"."binding_key" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "publication_records" ADD CONSTRAINT "publication_records_manifest_policy_digests" CHECK ("publication_records"."manifest_digest" ~ '^[0-9a-f]{64}$' and "publication_records"."policy_digest" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "publication_records" ADD CONSTRAINT "publication_records_git_shas" CHECK ("publication_records"."base_sha" ~ '^[0-9a-f]{40}$' and ("publication_records"."tree_sha" is null or "publication_records"."tree_sha" ~ '^[0-9a-f]{40}$') and ("publication_records"."commit_sha" is null or "publication_records"."commit_sha" ~ '^[0-9a-f]{40}$'));--> statement-breakpoint
ALTER TABLE "publication_records" ADD CONSTRAINT "publication_records_branch_namespace" CHECK ("publication_records"."branch" ~ '^agentos/[a-z0-9._-]{1,100}-[0-9a-f]{8}$');--> statement-breakpoint
ALTER TABLE "publication_records" ADD CONSTRAINT "publication_records_pull_request_shape" CHECK (("publication_records"."pull_request_number" is null or "publication_records"."pull_request_number" > 0) and ("publication_records"."draft" is null or "publication_records"."draft" is true) and ("publication_records"."pull_request_url" is null or "publication_records"."pull_request_url" like 'https://github.com/%'));
--> statement-breakpoint
ALTER TABLE "publication_records" ADD CONSTRAINT "publication_records_phase_checkpoint_shape" CHECK (
	("phase" NOT IN ('blobs_created','tree_created','commit_created','ref_created','pr_created','succeeded') OR "blob_shas" IS NOT NULL)
	AND ("phase" NOT IN ('tree_created','commit_created','ref_created','pr_created','succeeded') OR "tree_sha" IS NOT NULL)
	AND ("phase" NOT IN ('commit_created','ref_created','pr_created','succeeded') OR "commit_sha" IS NOT NULL)
	AND ("phase" NOT IN ('pr_created','succeeded') OR ("pull_request_number" IS NOT NULL AND "pull_request_url" IS NOT NULL AND "draft" IS true))
);
