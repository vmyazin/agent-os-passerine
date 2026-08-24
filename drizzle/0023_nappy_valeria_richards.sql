CREATE TABLE "project_source_import_requests" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"source_key" text NOT NULL,
	"project_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_source_import_requests_required_text" CHECK (length("project_source_import_requests"."idempotency_key") between 1 and 200 and length("project_source_import_requests"."fingerprint") between 1 and 512 and length("project_source_import_requests"."source_key") between 1 and 4096)
);
--> statement-breakpoint
ALTER TABLE "project_source_import_requests" ADD CONSTRAINT "project_source_import_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;