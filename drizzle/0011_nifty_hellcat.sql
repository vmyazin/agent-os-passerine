CREATE TYPE "public"."workflow_effect_status" AS ENUM('pending', 'started', 'succeeded', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TABLE "workflow_effects" (
	"effect_key" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"input_fingerprint" text NOT NULL,
	"status" "workflow_effect_status" NOT NULL,
	"external_ref" text,
	"output" jsonb,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_session_leases" (
	"lease_key" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_effects" ADD CONSTRAINT "workflow_effects_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_session_leases" ADD CONSTRAINT "workflow_session_leases_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_effects_run_status_idx" ON "workflow_effects" USING btree ("run_id","status","created_at","effect_key" collate "C");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "agentos_admit_workflow_session"(
  p_run_id text,
  p_step_key text,
  p_workflow_limit bigint,
  p_daily_limit bigint,
  p_admission_numerator integer,
  p_admission_denominator integer,
  p_now timestamptz,
  p_lease_expires_at timestamptz
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  workflow_spent bigint;
  daily_spent bigint;
  workflow_threshold numeric;
  daily_threshold numeric;
  current_lease "workflow_session_leases"%ROWTYPE;
BEGIN
  IF p_workflow_limit < 0 OR p_daily_limit < 0 OR
     p_admission_numerator <= 0 OR p_admission_denominator <= 0 OR
     p_admission_numerator > p_admission_denominator OR
     p_lease_expires_at <= p_now THEN
    RAISE EXCEPTION 'invalid workflow admission request';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('agentos-global-agent-session-v1'));

  SELECT COALESCE(SUM("microdollars"), 0)::bigint INTO workflow_spent
    FROM "usage_records" WHERE "run_id" = p_run_id;

  SELECT COALESCE(SUM(u."microdollars"), 0)::bigint INTO daily_spent
    FROM "usage_records" u
    JOIN "workflow_runs" used_run ON used_run."id" = u."run_id"
    JOIN "workflow_runs" requested_run ON requested_run."id" = p_run_id
   WHERE used_run."project_id" = requested_run."project_id"
     AND u."recorded_at" >= p_now - interval '24 hours'
     AND u."recorded_at" <= p_now;

  workflow_threshold := floor(
    (p_workflow_limit::numeric * p_admission_numerator::numeric) /
    p_admission_denominator::numeric
  );
  daily_threshold := floor(
    (p_daily_limit::numeric * p_admission_numerator::numeric) /
    p_admission_denominator::numeric
  );

  IF workflow_spent >= workflow_threshold THEN RETURN 'workflow_budget'; END IF;
  IF daily_spent >= daily_threshold THEN RETURN 'daily_budget'; END IF;

  SELECT * INTO current_lease FROM "workflow_session_leases"
   WHERE "lease_key" = 'global-agent-session' FOR UPDATE;
  IF FOUND AND current_lease."expires_at" > p_now AND
     (current_lease."run_id" <> p_run_id OR current_lease."step_key" <> p_step_key)
  THEN
    RETURN 'concurrency';
  END IF;

  INSERT INTO "workflow_session_leases"
    ("lease_key", "run_id", "step_key", "expires_at", "updated_at")
  VALUES
    ('global-agent-session', p_run_id, p_step_key, p_lease_expires_at, p_now)
  ON CONFLICT ("lease_key") DO UPDATE SET
    "run_id" = EXCLUDED."run_id",
    "step_key" = EXCLUDED."step_key",
    "expires_at" = EXCLUDED."expires_at",
    "updated_at" = EXCLUDED."updated_at";
  RETURN 'admitted';
END;
$$;
