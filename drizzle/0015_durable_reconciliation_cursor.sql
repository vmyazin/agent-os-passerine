CREATE TABLE "workflow_reconciliation_cursors" (
	"cursor_key" text PRIMARY KEY NOT NULL,
	"cursor_at" timestamp with time zone NOT NULL,
	"cursor_id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
