UPDATE "workflow_runs"
SET
	"status" = 'failed',
	"error" = '{"code":"legacy_goal_unverifiable"}'::jsonb,
	"updated_at" = now()
WHERE "pipeline" = 'goal'
	AND "status" IN ('pending', 'running', 'waiting');--> statement-breakpoint
DELETE FROM "goal_progress";--> statement-breakpoint
DELETE FROM "goal_criteria";--> statement-breakpoint
ALTER TABLE "goal_criteria" ADD COLUMN "definition" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "goal_progress" ADD COLUMN "step" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "goal_progress" ADD CONSTRAINT "goal_progress_step_between_1_and_3" CHECK ("goal_progress"."step" between 1 and 3);
