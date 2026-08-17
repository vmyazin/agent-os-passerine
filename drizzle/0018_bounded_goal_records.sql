DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "goal_criteria")
		OR EXISTS (SELECT 1 FROM "goal_progress") THEN
		RAISE EXCEPTION 'cannot infer bounded goal history from legacy goal records';
	END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "goal_criteria" ADD COLUMN "definition" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "goal_progress" ADD COLUMN "step" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "goal_progress" ADD CONSTRAINT "goal_progress_step_between_1_and_3" CHECK ("goal_progress"."step" between 1 and 3);
