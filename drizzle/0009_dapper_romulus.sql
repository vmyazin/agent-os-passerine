CREATE TABLE "publication_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"publication_key" text NOT NULL,
	"phase" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publication_records" (
	"publication_key" text PRIMARY KEY NOT NULL,
	"binding_key" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"repository_id" bigint NOT NULL,
	"manifest_digest" text NOT NULL,
	"policy_digest" text NOT NULL,
	"base_sha" text NOT NULL,
	"branch" text NOT NULL,
	"phase" text NOT NULL,
	"blob_shas" jsonb,
	"tree_sha" text,
	"commit_sha" text,
	"pull_request_number" bigint,
	"pull_request_url" text,
	"draft" boolean,
	"error_code" text,
	"revision" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "publication_records_binding_key_unique" UNIQUE("binding_key"),
	CONSTRAINT "publication_records_repository_id_positive" CHECK ("publication_records"."repository_id" > 0),
	CONSTRAINT "publication_records_repository_id_safe" CHECK ("publication_records"."repository_id" <= 9007199254740991),
	CONSTRAINT "publication_records_revision_positive" CHECK ("publication_records"."revision" > 0),
	CONSTRAINT "publication_records_revision_safe" CHECK ("publication_records"."revision" <= 9007199254740991),
	CONSTRAINT "publication_records_phase_valid" CHECK ("publication_records"."phase" in ('claimed','blobs_created','tree_created','commit_created','ref_created','pr_created','succeeded','cancelled','failed'))
);
--> statement-breakpoint
ALTER TABLE "publication_events" ADD CONSTRAINT "publication_events_publication_key_publication_records_publication_key_fk" FOREIGN KEY ("publication_key") REFERENCES "public"."publication_records"("publication_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_records" ADD CONSTRAINT "publication_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_records" ADD CONSTRAINT "publication_records_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publication_events_order_idx" ON "publication_events" USING btree ("publication_key","sequence");--> statement-breakpoint
CREATE INDEX "publication_records_run_idx" ON "publication_records" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "agentos_claim_publication"(
	p_publication_key text,
	p_binding_key text,
	p_project_id text,
	p_run_id text,
	p_repository_id bigint,
	p_manifest_digest text,
	p_policy_digest text,
	p_base_sha text,
	p_branch text,
	p_now timestamp with time zone
) RETURNS "publication_records"
LANGUAGE plpgsql
AS $$
DECLARE
	stored "publication_records"%rowtype;
	inserted boolean := false;
BEGIN
	PERFORM pg_advisory_xact_lock(hashtextextended(p_binding_key, 0));
	BEGIN
		INSERT INTO "publication_records" (
			"publication_key", "binding_key", "project_id", "run_id",
			"repository_id", "manifest_digest", "policy_digest", "base_sha",
			"branch", "phase", "revision", "created_at", "updated_at"
		) VALUES (
			p_publication_key, p_binding_key, p_project_id, p_run_id,
			p_repository_id, p_manifest_digest, p_policy_digest, p_base_sha,
			p_branch, 'claimed', 1, p_now, p_now
		)
		ON CONFLICT ("publication_key") DO NOTHING
		RETURNING * INTO stored;
		inserted := found;
	EXCEPTION WHEN unique_violation THEN
		SELECT * INTO stored FROM "publication_records"
		WHERE "binding_key" = p_binding_key;
	END;

	IF NOT inserted AND stored."publication_key" IS NULL THEN
		SELECT * INTO stored FROM "publication_records"
		WHERE "publication_key" = p_publication_key;
	END IF;
	IF stored."publication_key" IS NULL
		OR stored."publication_key" <> p_publication_key
		OR stored."binding_key" <> p_binding_key
		OR stored."project_id" <> p_project_id
		OR stored."run_id" <> p_run_id
		OR stored."repository_id" <> p_repository_id
		OR stored."manifest_digest" <> p_manifest_digest
		OR stored."policy_digest" <> p_policy_digest
		OR stored."base_sha" <> p_base_sha
		OR stored."branch" <> p_branch THEN
		RAISE EXCEPTION 'agentos_publication_conflict' USING ERRCODE = 'P0001';
	END IF;
	IF inserted THEN
		INSERT INTO "publication_events" ("publication_key", "phase", "at", "details")
		VALUES (p_publication_key, 'claimed', p_now, '{}'::jsonb);
	END IF;
	RETURN stored;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "agentos_save_publication"(
	p_publication_key text,
	p_expected_revision bigint,
	p_phase text,
	p_patch jsonb,
	p_at timestamp with time zone,
	p_details jsonb
) RETURNS "publication_records"
LANGUAGE plpgsql
AS $$
DECLARE
	stored "publication_records"%rowtype;
	unknown_key text;
BEGIN
	PERFORM pg_advisory_xact_lock(hashtextextended(p_publication_key, 0));
	IF p_patch IS NULL OR p_details IS NULL
		OR jsonb_typeof(p_patch) <> 'object'
		OR jsonb_typeof(p_details) <> 'object' THEN
		RAISE EXCEPTION 'agentos_publication_conflict' USING ERRCODE = 'P0001';
	END IF;
	SELECT key_name INTO unknown_key
	FROM jsonb_object_keys(p_patch) AS patch_key(key_name)
	WHERE key_name NOT IN (
		'blobShas', 'treeSha', 'commitSha', 'pullRequestNumber',
		'pullRequestUrl', 'draft', 'errorCode'
	)
	LIMIT 1;
	IF unknown_key IS NOT NULL THEN
		RAISE EXCEPTION 'agentos_publication_conflict' USING ERRCODE = 'P0001';
	END IF;
	IF p_patch ? 'pullRequestNumber'
		AND p_patch->>'pullRequestNumber' !~ '^[1-9][0-9]{0,15}$' THEN
		RAISE EXCEPTION 'agentos_publication_conflict' USING ERRCODE = 'P0001';
	END IF;
	IF p_patch ? 'draft' AND p_patch->>'draft' <> 'true' THEN
		RAISE EXCEPTION 'agentos_publication_conflict' USING ERRCODE = 'P0001';
	END IF;
	IF p_phase = 'blobs_created' AND (
		NOT (p_patch ? 'blobShas')
		OR jsonb_typeof(p_patch->'blobShas') <> 'object'
		OR EXISTS (
			SELECT 1 FROM jsonb_each(p_patch->'blobShas') AS blob_entry(path, value)
			WHERE jsonb_typeof(value) <> 'string'
				OR trim(both '"' from value::text) !~ '^[0-9a-f]{40}$'
		)
	) THEN
		RAISE EXCEPTION 'agentos_publication_conflict' USING ERRCODE = 'P0001';
	END IF;
	IF p_phase = 'tree_created' AND (
		NOT (p_patch ? 'treeSha') OR p_patch->>'treeSha' !~ '^[0-9a-f]{40}$'
	) THEN
		RAISE EXCEPTION 'agentos_publication_conflict' USING ERRCODE = 'P0001';
	END IF;
	IF p_phase IN ('commit_created', 'ref_created') AND (
		NOT (p_patch ? 'commitSha') OR p_patch->>'commitSha' !~ '^[0-9a-f]{40}$'
	) THEN
		RAISE EXCEPTION 'agentos_publication_conflict' USING ERRCODE = 'P0001';
	END IF;
	IF p_phase = 'pr_created' AND (
		NOT (p_patch ? 'pullRequestNumber')
		OR NOT (p_patch ? 'pullRequestUrl')
		OR NOT (p_patch ? 'draft')
	) THEN
		RAISE EXCEPTION 'agentos_publication_conflict' USING ERRCODE = 'P0001';
	END IF;
	UPDATE "publication_records"
	SET
		"phase" = p_phase,
		"blob_shas" = CASE WHEN p_patch ? 'blobShas' THEN p_patch->'blobShas' ELSE "blob_shas" END,
		"tree_sha" = CASE WHEN p_patch ? 'treeSha' THEN p_patch->>'treeSha' ELSE "tree_sha" END,
		"commit_sha" = CASE WHEN p_patch ? 'commitSha' THEN p_patch->>'commitSha' ELSE "commit_sha" END,
		"pull_request_number" = CASE
			WHEN p_patch ? 'pullRequestNumber' AND p_patch->>'pullRequestNumber' ~ '^[1-9][0-9]{0,15}$'
			THEN (p_patch->>'pullRequestNumber')::bigint
			ELSE "pull_request_number"
		END,
		"pull_request_url" = CASE WHEN p_patch ? 'pullRequestUrl' THEN p_patch->>'pullRequestUrl' ELSE "pull_request_url" END,
		"draft" = CASE WHEN p_patch ? 'draft' THEN (p_patch->>'draft')::boolean ELSE "draft" END,
		"error_code" = CASE WHEN p_patch ? 'errorCode' THEN p_patch->>'errorCode' ELSE "error_code" END,
		"revision" = "revision" + 1,
		"updated_at" = p_at
	WHERE "publication_key" = p_publication_key
		AND "revision" = p_expected_revision
		AND CASE "phase"
			WHEN 'claimed' THEN p_phase IN ('blobs_created', 'failed', 'cancelled')
			WHEN 'failed' THEN p_phase IN ('blobs_created', 'cancelled')
			WHEN 'blobs_created' THEN p_phase IN ('tree_created', 'failed', 'cancelled')
			WHEN 'tree_created' THEN p_phase IN ('commit_created', 'failed', 'cancelled')
			WHEN 'commit_created' THEN p_phase IN ('ref_created', 'failed', 'cancelled')
			WHEN 'ref_created' THEN p_phase IN ('pr_created', 'failed', 'cancelled')
			WHEN 'pr_created' THEN p_phase IN ('succeeded', 'failed', 'cancelled')
			WHEN 'cancelled' THEN p_phase = 'cancelled'
				AND "pull_request_number" IS NULL
				AND p_patch ? 'pullRequestNumber'
				AND p_patch ? 'pullRequestUrl'
				AND p_patch->>'draft' = 'true'
			ELSE false
		END
	RETURNING * INTO stored;
	IF NOT found THEN
		RAISE EXCEPTION 'agentos_publication_conflict' USING ERRCODE = 'P0001';
	END IF;
	INSERT INTO "publication_events" ("publication_key", "phase", "at", "details")
	VALUES (p_publication_key, p_phase, p_at, p_details);
	RETURN stored;
END;
$$;
