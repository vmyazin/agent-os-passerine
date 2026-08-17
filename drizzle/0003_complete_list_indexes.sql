DROP INDEX "goal_progress_order_idx";--> statement-breakpoint
DROP INDEX "inbox_messages_pending_idx";--> statement-breakpoint
DROP INDEX "workflow_runs_status_idx";--> statement-breakpoint
CREATE INDEX "inbox_messages_run_status_created_idx" ON "inbox_messages" USING btree ("run_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "workflow_runs_project_created_idx" ON "workflow_runs" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_created_idx" ON "workflow_runs" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "goal_progress_order_idx" ON "goal_progress" USING btree ("run_id","recorded_at","id");--> statement-breakpoint
CREATE INDEX "inbox_messages_pending_idx" ON "inbox_messages" USING btree ("run_id","created_at","id") WHERE "inbox_messages"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs" USING btree ("project_id","status","created_at","id");