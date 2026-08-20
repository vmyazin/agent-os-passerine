-- drizzle/0019_project_session_leases.sql
-- Scope the agent session lease per project so parallel projects no longer
-- share one global concurrency fence.

-- Carry any in-flight fence across the rescoping. A lease still parked under
-- the old global key must become its project's lease rather than vanish:
-- dropping it outright would let a second paid session start for that project
-- while the first one is still live, which is exactly what 0014 forbids.
INSERT INTO "workflow_session_leases" ("lease_key", "run_id", "step_key", "expires_at", "updated_at")
SELECT 'agent-session:' || r."project_id", l."run_id", l."step_key", l."expires_at", l."updated_at"
  FROM "workflow_session_leases" l
  JOIN "workflow_runs" r ON r."id" = l."run_id"
 WHERE l."lease_key" = 'global-agent-session'
ON CONFLICT ("lease_key") DO NOTHING;
--> statement-breakpoint
DELETE FROM "workflow_session_leases" WHERE "lease_key" = 'global-agent-session';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "agentos_admit_workflow_session"(
  p_run_id text, p_project_id text, p_step_key text, p_reservation_key text,
  p_estimated bigint, p_workflow_limit bigint, p_daily_limit bigint,
  p_admission_numerator integer, p_admission_denominator integer,
  p_now timestamptz, p_lease_expires_at timestamptz
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  -- v_ prefix is load-bearing: a plpgsql local named lease_key would collide
  -- with the workflow_session_leases.lease_key column, and plpgsql's default
  -- variable_conflict=error turns every reference into a runtime failure.
  v_lease_key text := 'agent-session:' || p_project_id;
  existing "workflow_budget_reservations"%ROWTYPE;
  current_lease "workflow_session_leases"%ROWTYPE;
  workflow_spent bigint;
  daily_spent bigint;
  workflow_reserved bigint;
  daily_reserved bigint;
  workflow_threshold numeric;
  daily_threshold numeric;
BEGIN
  IF p_estimated <= 0 OR p_workflow_limit < 0 OR p_daily_limit < 0 OR
     p_admission_numerator <= 0 OR p_admission_denominator <= 0 OR
     p_admission_numerator > p_admission_denominator OR
     p_lease_expires_at <= p_now THEN
    RAISE EXCEPTION 'invalid workflow admission request';
  END IF;
  -- Lock on the lease key, not the bare project id: the bare id is already the
  -- advisory namespace used by the configuration-apply CAS, and sharing it
  -- would make config applies and session admissions block each other.
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
  SELECT COALESCE(SUM("estimated_microdollars"), 0)::bigint INTO workflow_reserved
    FROM "workflow_budget_reservations" WHERE "run_id" = p_run_id;
  SELECT COALESCE(SUM("estimated_microdollars"), 0)::bigint INTO daily_reserved
    FROM "workflow_budget_reservations" WHERE "project_id" = p_project_id;
  workflow_threshold := floor(p_workflow_limit::numeric * p_admission_numerator / p_admission_denominator);
  daily_threshold := floor(p_daily_limit::numeric * p_admission_numerator / p_admission_denominator);
  IF workflow_spent + workflow_reserved + p_estimated >= workflow_threshold OR
     workflow_spent + workflow_reserved + p_estimated > p_workflow_limit THEN RETURN 'workflow_budget'; END IF;
  IF daily_spent + daily_reserved + p_estimated >= daily_threshold OR
     daily_spent + daily_reserved + p_estimated > p_daily_limit THEN RETURN 'daily_budget'; END IF;
  SELECT * INTO current_lease FROM "workflow_session_leases"
   WHERE "lease_key" = v_lease_key FOR UPDATE;
  -- An expired lease may still own a paid remote session. Only explicit
  -- reconciliation may settle and release it; wall-clock expiry never admits a
  -- second session.
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "agentos_settle_workflow_session"(
  p_reservation_key text, p_run_id text, p_step_key text, p_actual bigint,
  p_workflow_limit bigint, p_daily_limit bigint, p_now timestamptz
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  reservation "workflow_budget_reservations"%ROWTYPE;
  workflow_spent bigint;
  daily_spent bigint;
  v_lease_key text;
  reservation_project_id text;
BEGIN
  IF p_actual < 0 THEN RAISE EXCEPTION 'invalid workflow settlement'; END IF;
  -- Resolve the owning project WITHOUT locking the row, so the advisory lock is
  -- always taken before any reservation row lock -- the same order
  -- agentos_admit_workflow_session uses. Locking the row first (to read
  -- project_id) and the advisory lock second would let a concurrent admit and
  -- settle for one reservation deadlock against each other.
  SELECT "project_id" INTO reservation_project_id
    FROM "workflow_budget_reservations" WHERE "reservation_key" = p_reservation_key;
  IF NOT FOUND THEN RETURN 'settled'; END IF;
  v_lease_key := 'agent-session:' || reservation_project_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_lease_key, 0));
  SELECT * INTO reservation FROM "workflow_budget_reservations"
   WHERE "reservation_key" = p_reservation_key FOR UPDATE;
  IF NOT FOUND THEN RETURN 'settled'; END IF;
  IF reservation."run_id" <> p_run_id OR reservation."step_key" <> p_step_key OR
     reservation."project_id" <> reservation_project_id THEN
    RAISE EXCEPTION 'workflow reservation conflicts';
  END IF;
  SELECT COALESCE(SUM("microdollars"),0)::bigint INTO workflow_spent FROM "usage_records" WHERE "run_id"=p_run_id;
  SELECT COALESCE(SUM(u."microdollars"),0)::bigint INTO daily_spent
    FROM "usage_records" u JOIN "workflow_runs" r ON r."id"=u."run_id"
   WHERE r."project_id"=reservation."project_id" AND u."recorded_at" >= p_now - interval '24 hours' AND u."recorded_at" <= p_now;
  DELETE FROM "workflow_budget_reservations" WHERE "reservation_key"=p_reservation_key;
  DELETE FROM "workflow_session_leases" WHERE "lease_key"=v_lease_key AND "run_id"=p_run_id AND "step_key"=p_step_key;
  IF workflow_spent > p_workflow_limit THEN RETURN 'workflow_budget'; END IF;
  IF daily_spent > p_daily_limit THEN RETURN 'daily_budget'; END IF;
  RETURN 'settled';
END;
$$;
