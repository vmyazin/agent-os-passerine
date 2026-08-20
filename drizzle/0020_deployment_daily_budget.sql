-- drizzle/0020_deployment_daily_budget.sql
-- Optional deployment-wide daily spend cap checked before per-project limits.

CREATE OR REPLACE FUNCTION "agentos_admit_workflow_session"(
  p_run_id text, p_project_id text, p_step_key text, p_reservation_key text,
  p_estimated bigint, p_workflow_limit bigint, p_daily_limit bigint,
  p_admission_numerator integer, p_admission_denominator integer,
  p_now timestamptz, p_lease_expires_at timestamptz,
  p_deployment_daily_limit bigint DEFAULT 0
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_lease_key text := 'agent-session:' || p_project_id;
  existing "workflow_budget_reservations"%ROWTYPE;
  current_lease "workflow_session_leases"%ROWTYPE;
  workflow_spent bigint;
  daily_spent bigint;
  deployment_spent bigint;
  workflow_reserved bigint;
  daily_reserved bigint;
  deployment_reserved bigint;
  workflow_threshold numeric;
  daily_threshold numeric;
  deployment_threshold numeric;
BEGIN
  IF p_estimated <= 0 OR p_workflow_limit < 0 OR p_daily_limit < 0 OR
     p_admission_numerator <= 0 OR p_admission_denominator <= 0 OR
     p_admission_numerator > p_admission_denominator OR
     p_lease_expires_at <= p_now THEN
    RAISE EXCEPTION 'invalid workflow admission request';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_lease_key, 0));
  SELECT * INTO existing FROM "workflow_budget_reservations"
   WHERE "reservation_key" = p_reservation_key FOR UPDATE;
  IF FOUND THEN
    IF existing."run_id" <> p_run_id OR existing."project_id" <> p_project_id OR
       existing."step_key" <> p_step_key OR existing."estimated_microdollars" <> p_estimated THEN
      RAISE EXCEPTION 'workflow reservation conflicts';
    END IF;
    SELECT * INTO current_lease FROM "workflow_session_leases"
     WHERE "lease_key" = v_lease_key FOR UPDATE;
    IF FOUND AND
       (current_lease."run_id" <> p_run_id OR current_lease."step_key" <> p_step_key)
    THEN RETURN 'concurrency'; END IF;
    INSERT INTO "workflow_session_leases" ("lease_key", "run_id", "step_key", "expires_at", "updated_at")
    VALUES (v_lease_key, p_run_id, p_step_key, p_lease_expires_at, p_now)
    ON CONFLICT ("lease_key") DO UPDATE SET "expires_at"=EXCLUDED."expires_at", "updated_at"=EXCLUDED."updated_at";
    RETURN 'admitted';
  END IF;
  SELECT COALESCE(SUM("microdollars"), 0)::bigint INTO workflow_spent
    FROM "usage_records" WHERE "run_id" = p_run_id;
  SELECT COALESCE(SUM(u."microdollars"), 0)::bigint INTO daily_spent
    FROM "usage_records" u JOIN "workflow_runs" r ON r."id" = u."run_id"
   WHERE r."project_id" = p_project_id
     AND u."recorded_at" >= p_now - interval '24 hours' AND u."recorded_at" <= p_now;
  SELECT COALESCE(SUM(u."microdollars"), 0)::bigint INTO deployment_spent
    FROM "usage_records" u
   WHERE u."recorded_at" >= p_now - interval '24 hours' AND u."recorded_at" <= p_now;
  SELECT COALESCE(SUM("estimated_microdollars"), 0)::bigint INTO workflow_reserved
    FROM "workflow_budget_reservations" WHERE "run_id" = p_run_id;
  SELECT COALESCE(SUM("estimated_microdollars"), 0)::bigint INTO daily_reserved
    FROM "workflow_budget_reservations" WHERE "project_id" = p_project_id;
  SELECT COALESCE(SUM("estimated_microdollars"), 0)::bigint INTO deployment_reserved
    FROM "workflow_budget_reservations";
  workflow_threshold := floor(p_workflow_limit::numeric * p_admission_numerator / p_admission_denominator);
  daily_threshold := floor(p_daily_limit::numeric * p_admission_numerator / p_admission_denominator);
  IF p_deployment_daily_limit > 0 THEN
    deployment_threshold := floor(p_deployment_daily_limit::numeric * p_admission_numerator / p_admission_denominator);
    IF deployment_spent + deployment_reserved + p_estimated >= deployment_threshold OR
       deployment_spent + deployment_reserved + p_estimated > p_deployment_daily_limit THEN
      RETURN 'daily_budget';
    END IF;
  END IF;
  IF workflow_spent + workflow_reserved + p_estimated >= workflow_threshold OR
     workflow_spent + workflow_reserved + p_estimated > p_workflow_limit THEN RETURN 'workflow_budget'; END IF;
  IF daily_spent + daily_reserved + p_estimated >= daily_threshold OR
     daily_spent + daily_reserved + p_estimated > p_daily_limit THEN RETURN 'daily_budget'; END IF;
  SELECT * INTO current_lease FROM "workflow_session_leases"
   WHERE "lease_key" = v_lease_key FOR UPDATE;
  IF FOUND AND
     (current_lease."run_id" <> p_run_id OR current_lease."step_key" <> p_step_key)
  THEN RETURN 'concurrency'; END IF;
  INSERT INTO "workflow_session_leases" ("lease_key", "run_id", "step_key", "expires_at", "updated_at")
  VALUES (v_lease_key, p_run_id, p_step_key, p_lease_expires_at, p_now)
  ON CONFLICT ("lease_key") DO UPDATE SET "run_id"=EXCLUDED."run_id", "step_key"=EXCLUDED."step_key",
    "expires_at"=EXCLUDED."expires_at", "updated_at"=EXCLUDED."updated_at";
  INSERT INTO "workflow_budget_reservations"
    ("reservation_key", "run_id", "project_id", "step_key", "estimated_microdollars", "expires_at", "created_at")
  VALUES (p_reservation_key, p_run_id, p_project_id, p_step_key, p_estimated, p_lease_expires_at, p_now);
  RETURN 'admitted';
END;
$$;
