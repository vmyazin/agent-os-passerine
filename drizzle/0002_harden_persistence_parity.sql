ALTER TABLE "webhook_receipts" ADD COLUMN "claim_token" text;--> statement-breakpoint
UPDATE "webhook_receipts"
SET "claim_token" = 'legacy:' || "source" || ':' || "delivery_id";--> statement-breakpoint
ALTER TABLE "webhook_receipts" ALTER COLUMN "claim_token" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "approvals_run_created_idx" ON "approvals" USING btree ("run_id","created_at","id");--> statement-breakpoint
CREATE INDEX "approvals_run_status_created_idx" ON "approvals" USING btree ("run_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "artifacts_run_created_idx" ON "artifacts" USING btree ("run_id","created_at","id");--> statement-breakpoint
CREATE INDEX "config_revisions_project_created_idx" ON "config_revisions" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "config_snapshots_run_created_idx" ON "config_snapshots" USING btree ("run_id","created_at","id");--> statement-breakpoint
CREATE INDEX "external_sessions_run_created_idx" ON "external_sessions" USING btree ("run_id","created_at","id");--> statement-breakpoint
CREATE INDEX "external_sessions_run_provider_created_idx" ON "external_sessions" USING btree ("run_id","provider","created_at","id");--> statement-breakpoint
CREATE INDEX "inbox_messages_run_created_idx" ON "inbox_messages" USING btree ("run_id","created_at","id");--> statement-breakpoint
CREATE INDEX "projects_created_idx" ON "projects" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "usage_records_run_recorded_idx" ON "usage_records" USING btree ("run_id","recorded_at","idempotency_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_created_idx" ON "workflow_runs" USING btree ("created_at","id");--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_size_safe_integer" CHECK ("artifacts"."size_bytes" is null or "artifacts"."size_bytes" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_sequence_safe_integer" CHECK ("domain_events"."sequence" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_input_safe_integer" CHECK ("usage_records"."input_tokens" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_output_safe_integer" CHECK ("usage_records"."output_tokens" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_runtime_safe_integer" CHECK ("usage_records"."runtime_ms" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_cost_safe_integer" CHECK ("usage_records"."microdollars" <= 9007199254740991);
