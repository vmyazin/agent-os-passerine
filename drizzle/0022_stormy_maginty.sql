CREATE TABLE "project_sources" (
	"project_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source_key" text NOT NULL,
	"default_branch" text NOT NULL,
	"repository_url" text,
	"github_owner" text,
	"github_name" text,
	"repository_id" bigint,
	"reader_installation_id" bigint,
	"publisher_installation_id" bigint,
	"local_path" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_sources_source_key_unique" UNIQUE("source_key"),
	CONSTRAINT "project_sources_repository_id_unique" UNIQUE("repository_id"),
	CONSTRAINT "project_sources_kind_valid" CHECK ("project_sources"."kind" in ('github','local')),
	CONSTRAINT "project_sources_provider_shape" CHECK (("project_sources"."kind" = 'github' and "project_sources"."repository_url" is not null and "project_sources"."github_owner" is not null and "project_sources"."github_name" is not null and "project_sources"."repository_id" is not null and "project_sources"."reader_installation_id" is not null and "project_sources"."local_path" is null) or ("project_sources"."kind" = 'local' and "project_sources"."repository_url" is null and "project_sources"."github_owner" is null and "project_sources"."github_name" is null and "project_sources"."repository_id" is null and "project_sources"."reader_installation_id" is null and "project_sources"."publisher_installation_id" is null and "project_sources"."local_path" is not null)),
	CONSTRAINT "project_sources_repository_id_safe" CHECK ("project_sources"."repository_id" is null or ("project_sources"."repository_id" > 0 and "project_sources"."repository_id" <= 9007199254740991)),
	CONSTRAINT "project_sources_reader_installation_id_safe" CHECK ("project_sources"."reader_installation_id" is null or ("project_sources"."reader_installation_id" > 0 and "project_sources"."reader_installation_id" <= 9007199254740991)),
	CONSTRAINT "project_sources_publisher_installation_id_safe" CHECK ("project_sources"."publisher_installation_id" is null or ("project_sources"."publisher_installation_id" > 0 and "project_sources"."publisher_installation_id" <= 9007199254740991)),
	CONSTRAINT "project_sources_required_text" CHECK (length("project_sources"."source_key") between 1 and 4096 and length("project_sources"."default_branch") between 1 and 255)
);
--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
