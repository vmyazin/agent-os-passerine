DROP INDEX "artifacts_cleanup_idx";--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "retention_class" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
CREATE INDEX "artifacts_run_key_scan_idx" ON "artifacts" USING btree ("run_id","key" collate "C");--> statement-breakpoint
CREATE INDEX "artifacts_cleanup_idx" ON "artifacts" USING btree ("cleanup_at") WHERE "artifacts"."cleanup_at" is not null and "artifacts"."deleted_at" is null;