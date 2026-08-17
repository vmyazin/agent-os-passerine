CREATE TABLE "run_event_sequences" (
	"run_id" text PRIMARY KEY NOT NULL,
	"next_sequence" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "run_event_sequences_next_positive" CHECK ("run_event_sequences"."next_sequence" > 0),
	CONSTRAINT "run_event_sequences_next_safe_integer" CHECK ("run_event_sequences"."next_sequence" <= 9007199254740992)
);
--> statement-breakpoint
ALTER TABLE "run_event_sequences" ADD CONSTRAINT "run_event_sequences_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "run_event_sequences" ("run_id", "next_sequence")
SELECT "run_id", MAX("sequence") + 1
FROM "domain_events"
GROUP BY "run_id";
