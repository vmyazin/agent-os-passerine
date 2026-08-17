ALTER TABLE "goal_criteria" ADD COLUMN "definition" jsonb;--> statement-breakpoint
UPDATE "goal_criteria"
SET "definition" = jsonb_build_object(
	'id', "id",
	'type', 'command',
	'description', "description",
	'command', 'false'
)
WHERE "definition" IS NULL;--> statement-breakpoint
ALTER TABLE "goal_criteria" ALTER COLUMN "definition" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goal_progress" ADD COLUMN "step" integer;--> statement-breakpoint
UPDATE "goal_progress" SET "step" = 1 WHERE "step" IS NULL;--> statement-breakpoint
ALTER TABLE "goal_progress" ALTER COLUMN "step" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goal_progress" ADD CONSTRAINT "goal_progress_step_between_1_and_3" CHECK ("goal_progress"."step" between 1 and 3);
