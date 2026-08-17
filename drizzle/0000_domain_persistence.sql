CREATE TYPE "public"."approval_status" AS ENUM('pending', 'consumed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."external_session_status" AS ENUM('active', 'completed', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('pending', 'satisfied', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inbox_status" AS ENUM('pending', 'replied');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"scope" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" "approval_status" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_run_id" text,
	"key" text NOT NULL,
	"media_type" text,
	"size_bytes" bigint,
	"digest" text NOT NULL,
	"uri" text,
	"created_at" timestamp with time zone NOT NULL,
	"cleanup_at" timestamp with time zone,
	CONSTRAINT "artifacts_run_key_unique" UNIQUE("run_id","key"),
	CONSTRAINT "artifacts_size_nonnegative" CHECK ("artifacts"."size_bytes" is null or "artifacts"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "config_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"revision" integer NOT NULL,
	"config" jsonb NOT NULL,
	"config_digest" text NOT NULL,
	"model_digest" text NOT NULL,
	"prompt_digest" text NOT NULL,
	"environment_digest" text NOT NULL,
	"policy_digest" text NOT NULL,
	"repository_sha" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "config_revisions_project_revision_unique" UNIQUE("project_id","revision"),
	CONSTRAINT "config_revisions_revision_positive" CHECK ("config_revisions"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "config_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"config_revision_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"config_digest" text NOT NULL,
	"model_digest" text NOT NULL,
	"prompt_digest" text NOT NULL,
	"environment_digest" text NOT NULL,
	"policy_digest" text NOT NULL,
	"repository_sha" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"run_id" text NOT NULL,
	"event_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"sequence" bigint NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "domain_events_run_id_event_id_pk" PRIMARY KEY("run_id","event_id"),
	CONSTRAINT "domain_events_run_sequence_unique" UNIQUE("run_id","sequence"),
	CONSTRAINT "domain_events_sequence_nonnegative" CHECK ("domain_events"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "external_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_run_id" text,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"status" "external_session_status" NOT NULL,
	"state" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"cleanup_at" timestamp with time zone,
	CONSTRAINT "external_sessions_provider_external_unique" UNIQUE("provider","external_id")
);
--> statement-breakpoint
CREATE TABLE "goal_criteria" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"description" text NOT NULL,
	"status" "goal_status" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "goal_criteria_run_ordinal_unique" UNIQUE("run_id","ordinal"),
	CONSTRAINT "goal_criteria_ordinal_nonnegative" CHECK ("goal_criteria"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "goal_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"criterion_id" text,
	"status" "goal_status" NOT NULL,
	"detail" text,
	"payload" jsonb,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_run_id" text,
	"status" "inbox_status" NOT NULL,
	"body" jsonb NOT NULL,
	"reply" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"replied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"repository" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "step_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_key" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" "run_status" NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" jsonb,
	"external_session_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cleanup_at" timestamp with time zone,
	CONSTRAINT "step_runs_run_step_attempt_unique" UNIQUE("run_id","step_key","attempt"),
	CONSTRAINT "step_runs_attempt_positive" CHECK ("step_runs"."attempt" > 0)
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"idempotency_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_run_id" text,
	"model" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"runtime_ms" bigint NOT NULL,
	"microdollars" bigint NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "usage_input_nonnegative" CHECK ("usage_records"."input_tokens" >= 0),
	CONSTRAINT "usage_output_nonnegative" CHECK ("usage_records"."output_tokens" >= 0),
	CONSTRAINT "usage_runtime_nonnegative" CHECK ("usage_records"."runtime_ms" >= 0),
	CONSTRAINT "usage_cost_nonnegative" CHECK ("usage_records"."microdollars" >= 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_receipts" (
	"source" text NOT NULL,
	"delivery_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "webhook_receipts_source_delivery_id_pk" PRIMARY KEY("source","delivery_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"config_revision_id" text,
	"pipeline" text NOT NULL,
	"status" "run_status" NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cleanup_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_revisions" ADD CONSTRAINT "config_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_snapshots" ADD CONSTRAINT "config_snapshots_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_snapshots" ADD CONSTRAINT "config_snapshots_config_revision_id_config_revisions_id_fk" FOREIGN KEY ("config_revision_id") REFERENCES "public"."config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_sessions" ADD CONSTRAINT "external_sessions_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_sessions" ADD CONSTRAINT "external_sessions_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_criteria" ADD CONSTRAINT "goal_criteria_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_progress" ADD CONSTRAINT "goal_progress_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_progress" ADD CONSTRAINT "goal_progress_criterion_id_goal_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."goal_criteria"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_config_revision_id_config_revisions_id_fk" FOREIGN KEY ("config_revision_id") REFERENCES "public"."config_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_cleanup_idx" ON "artifacts" USING btree ("cleanup_at") WHERE "artifacts"."cleanup_at" is not null;--> statement-breakpoint
CREATE INDEX "domain_events_order_idx" ON "domain_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "external_sessions_cleanup_idx" ON "external_sessions" USING btree ("cleanup_at") WHERE "external_sessions"."cleanup_at" is not null;--> statement-breakpoint
CREATE INDEX "goal_progress_order_idx" ON "goal_progress" USING btree ("run_id","recorded_at");--> statement-breakpoint
CREATE INDEX "inbox_messages_pending_idx" ON "inbox_messages" USING btree ("run_id","created_at") WHERE "inbox_messages"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "step_runs_cleanup_idx" ON "step_runs" USING btree ("cleanup_at") WHERE "step_runs"."cleanup_at" is not null;--> statement-breakpoint
CREATE INDEX "webhook_receipts_expiry_idx" ON "webhook_receipts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs" USING btree ("project_id","status","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_cleanup_idx" ON "workflow_runs" USING btree ("cleanup_at") WHERE "workflow_runs"."cleanup_at" is not null;