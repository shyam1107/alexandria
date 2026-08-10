CREATE EXTENSION IF NOT EXISTS "vector";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('pending', 'uploaded', 'processing', 'indexed', 'failed');--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_version_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_count" integer,
	"embedding" vector(768),
	"embedding_model" varchar(128),
	"search_vector" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"content_type" varchar(127) NOT NULL,
	"byte_size" integer NOT NULL,
	"content_hash" varchar(64),
	"status" "document_status" DEFAULT 'pending' NOT NULL,
	"failure_message" text,
	"parser_version" varchar(32),
	"embedding_model" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"status" "document_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_chunks_version_index_idx" ON "document_chunks" USING btree ("document_version_id","chunk_index");--> statement-breakpoint
CREATE INDEX "document_chunks_workspace_idx" ON "document_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "document_versions_document_idx" ON "document_versions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_versions_workspace_idx" ON "document_versions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_hash_idx" ON "document_versions" USING btree ("workspace_id","content_hash");--> statement-breakpoint
CREATE INDEX "documents_workspace_idx" ON "documents" USING btree ("workspace_id");