CREATE TYPE "public"."backlog_status" AS ENUM('active', 'paused', 'completed');--> statement-breakpoint
CREATE TYPE "public"."backlog_item_status" AS ENUM('pending', 'running', 'succeeded', 'skipped', 'failed');--> statement-breakpoint
CREATE TABLE "backlogs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"status" "backlog_status" NOT NULL,
	"paused_reason" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);--> statement-breakpoint
CREATE TABLE "backlog_items" (
	"id" text PRIMARY KEY NOT NULL,
	"backlog_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" "backlog_item_status" NOT NULL,
	"run_id" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "backlog_items_backlog_ordinal_unique" UNIQUE("backlog_id","ordinal"),
	CONSTRAINT "backlog_items_run_unique" UNIQUE("run_id"),
	CONSTRAINT "backlog_items_ordinal_positive" CHECK ("backlog_items"."ordinal" >= 1)
);--> statement-breakpoint
ALTER TABLE "backlogs" ADD CONSTRAINT "backlogs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_items" ADD CONSTRAINT "backlog_items_backlog_id_backlogs_id_fk" FOREIGN KEY ("backlog_id") REFERENCES "public"."backlogs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_items" ADD CONSTRAINT "backlog_items_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backlogs_project_order_idx" ON "backlogs" USING btree ("project_id","created_at","id" collate "C");
