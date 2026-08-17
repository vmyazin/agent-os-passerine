CREATE TABLE "workflow_budget_reservations" (
	"reservation_key" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"step_key" text NOT NULL,
	"estimated_microdollars" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_effects" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "workflow_effects" ADD COLUMN "lease_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_effects" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_budget_reservations" ADD CONSTRAINT "workflow_budget_reservations_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_budget_reservations" ADD CONSTRAINT "workflow_budget_reservations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_budget_reservations_run_idx" ON "workflow_budget_reservations" USING btree ("run_id","expires_at","reservation_key" collate "C");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "agentos_admit_workflow_session"(
  p_run_id text, p_project_id text, p_step_key text, p_reservation_key text,
  p_estimated bigint, p_workflow_limit bigint, p_daily_limit bigint,
  p_admission_numerator integer, p_admission_denominator integer,
  p_now timestamptz, p_lease_expires_at timestamptz
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
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
  PERFORM pg_advisory_xact_lock(hashtext('agentos-global-agent-session-v2'));
  SELECT * INTO existing FROM "workflow_budget_reservations"
   WHERE "reservation_key" = p_reservation_key FOR UPDATE;
  IF FOUND THEN
    IF existing."run_id" <> p_run_id OR existing."project_id" <> p_project_id OR
       existing."step_key" <> p_step_key OR existing."estimated_microdollars" <> p_estimated THEN
      RAISE EXCEPTION 'workflow reservation conflicts';
    END IF;
    SELECT * INTO current_lease FROM "workflow_session_leases"
     WHERE "lease_key" = 'global-agent-session' FOR UPDATE;
    IF FOUND AND current_lease."expires_at" > p_now AND
       (current_lease."run_id" <> p_run_id OR current_lease."step_key" <> p_step_key)
    THEN RETURN 'concurrency'; END IF;
    INSERT INTO "workflow_session_leases" ("lease_key", "run_id", "step_key", "expires_at", "updated_at")
    VALUES ('global-agent-session', p_run_id, p_step_key, p_lease_expires_at, p_now)
    ON CONFLICT ("lease_key") DO UPDATE SET "run_id"=EXCLUDED."run_id", "step_key"=EXCLUDED."step_key",
      "expires_at"=EXCLUDED."expires_at", "updated_at"=EXCLUDED."updated_at";
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
   WHERE "lease_key" = 'global-agent-session' FOR UPDATE;
  IF FOUND AND current_lease."expires_at" > p_now AND
     (current_lease."run_id" <> p_run_id OR current_lease."step_key" <> p_step_key)
  THEN RETURN 'concurrency'; END IF;
  INSERT INTO "workflow_session_leases" ("lease_key", "run_id", "step_key", "expires_at", "updated_at")
  VALUES ('global-agent-session', p_run_id, p_step_key, p_lease_expires_at, p_now)
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
DECLARE reservation "workflow_budget_reservations"%ROWTYPE; workflow_spent bigint; daily_spent bigint;
BEGIN
  IF p_actual < 0 THEN RAISE EXCEPTION 'invalid workflow settlement'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('agentos-global-agent-session-v2'));
  SELECT * INTO reservation FROM "workflow_budget_reservations"
   WHERE "reservation_key" = p_reservation_key FOR UPDATE;
  IF NOT FOUND THEN RETURN 'settled'; END IF;
  IF reservation."run_id" <> p_run_id OR reservation."step_key" <> p_step_key THEN
    RAISE EXCEPTION 'workflow reservation conflicts';
  END IF;
  SELECT COALESCE(SUM("microdollars"),0)::bigint INTO workflow_spent FROM "usage_records" WHERE "run_id"=p_run_id;
  SELECT COALESCE(SUM(u."microdollars"),0)::bigint INTO daily_spent
    FROM "usage_records" u JOIN "workflow_runs" r ON r."id"=u."run_id"
   WHERE r."project_id"=reservation."project_id" AND u."recorded_at" >= p_now - interval '24 hours' AND u."recorded_at" <= p_now;
  DELETE FROM "workflow_budget_reservations" WHERE "reservation_key"=p_reservation_key;
  DELETE FROM "workflow_session_leases" WHERE "lease_key"='global-agent-session' AND "run_id"=p_run_id AND "step_key"=p_step_key;
  IF workflow_spent > p_workflow_limit THEN RETURN 'workflow_budget'; END IF;
  IF daily_spent > p_daily_limit THEN RETURN 'daily_budget'; END IF;
  RETURN 'settled';
END;
$$;
