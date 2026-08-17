DROP INDEX "approvals_run_created_idx";--> statement-breakpoint
DROP INDEX "approvals_run_status_created_idx";--> statement-breakpoint
DROP INDEX "artifacts_run_created_idx";--> statement-breakpoint
DROP INDEX "config_revisions_project_created_idx";--> statement-breakpoint
DROP INDEX "config_snapshots_run_created_idx";--> statement-breakpoint
DROP INDEX "external_sessions_run_created_idx";--> statement-breakpoint
DROP INDEX "external_sessions_run_provider_created_idx";--> statement-breakpoint
DROP INDEX "goal_progress_order_idx";--> statement-breakpoint
DROP INDEX "inbox_messages_pending_idx";--> statement-breakpoint
DROP INDEX "inbox_messages_run_created_idx";--> statement-breakpoint
DROP INDEX "inbox_messages_run_status_created_idx";--> statement-breakpoint
DROP INDEX "projects_created_idx";--> statement-breakpoint
DROP INDEX "usage_records_run_recorded_idx";--> statement-breakpoint
DROP INDEX "workflow_runs_status_idx";--> statement-breakpoint
DROP INDEX "workflow_runs_created_idx";--> statement-breakpoint
DROP INDEX "workflow_runs_project_created_idx";--> statement-breakpoint
DROP INDEX "workflow_runs_status_created_idx";--> statement-breakpoint
CREATE INDEX "step_runs_run_order_idx" ON "step_runs" USING btree ("run_id","step_key" collate "C","attempt");--> statement-breakpoint
CREATE INDEX "approvals_run_created_idx" ON "approvals" USING btree ("run_id","created_at","id" collate "C");--> statement-breakpoint
CREATE INDEX "approvals_run_status_created_idx" ON "approvals" USING btree ("run_id","status","created_at","id" collate "C");--> statement-breakpoint
CREATE INDEX "artifacts_run_created_idx" ON "artifacts" USING btree ("run_id","created_at","id" collate "C");--> statement-breakpoint
CREATE INDEX "config_revisions_project_created_idx" ON "config_revisions" USING btree ("project_id","created_at","id" collate "C");--> statement-breakpoint
CREATE INDEX "config_snapshots_run_created_idx" ON "config_snapshots" USING btree ("run_id","created_at","id" collate "C");--> statement-breakpoint
CREATE INDEX "external_sessions_run_created_idx" ON "external_sessions" USING btree ("run_id","created_at","id" collate "C");--> statement-breakpoint
CREATE INDEX "external_sessions_run_provider_created_idx" ON "external_sessions" USING btree ("run_id","provider","created_at","id" collate "C");--> statement-breakpoint
CREATE INDEX "goal_progress_order_idx" ON "goal_progress" USING btree ("run_id","recorded_at","id" collate "C");--> statement-breakpoint
CREATE INDEX "inbox_messages_pending_idx" ON "inbox_messages" USING btree ("run_id","created_at","id" collate "C") WHERE "inbox_messages"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "inbox_messages_run_created_idx" ON "inbox_messages" USING btree ("run_id","created_at","id" collate "C");--> statement-breakpoint
CREATE INDEX "inbox_messages_run_status_created_idx" ON "inbox_messages" USING btree ("run_id","status","created_at","id" collate "C");--> statement-breakpoint
CREATE INDEX "projects_created_idx" ON "projects" USING btree ("created_at","id" collate "C");--> statement-breakpoint
CREATE INDEX "usage_records_run_recorded_idx" ON "usage_records" USING btree ("run_id","recorded_at","idempotency_id" collate "C");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs" USING btree ("project_id","status","created_at","id" collate "C");--> statement-breakpoint
CREATE INDEX "workflow_runs_created_idx" ON "workflow_runs" USING btree ("created_at","id" collate "C");--> statement-breakpoint
CREATE INDEX "workflow_runs_project_created_idx" ON "workflow_runs" USING btree ("project_id","created_at","id" collate "C");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_created_idx" ON "workflow_runs" USING btree ("status","created_at","id" collate "C");