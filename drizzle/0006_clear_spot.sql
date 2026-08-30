CREATE TYPE "public"."llm_operation" AS ENUM('chat_answer', 'query_rewrite', 'embedding_index', 'embedding_query');--> statement-breakpoint
CREATE TABLE "llm_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"operation" "llm_operation" NOT NULL,
	"provider" varchar(64),
	"model" varchar(128),
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cost_micro_usd" bigint,
	"success" boolean NOT NULL,
	"error_kind" varchar(32),
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_usage_events_workspace_created_idx" ON "llm_usage_events" USING btree ("workspace_id","created_at");--> statement-breakpoint

-- Phase 6 tenancy: the ledger is workspace-keyed, so it gets the same
-- treatment as every other tenant table — ENABLE, FORCE (the owner-exemption
-- lesson from 0002), and a policy on app.workspace_id. DML grants come from
-- the ALTER DEFAULT PRIVILEGES set in 0002, which apply to tables created by
-- the migration role from that point on. The RLS integration test enforces
-- this rule-based: any table with a workspace_id column must show up here,
-- or the test suite fails. The ingestion worker writes ledger rows outside
-- any HTTP request; it connects as alexandria_app and goes through
-- withWorkspace() like everything else.
ALTER TABLE "llm_usage_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "llm_usage_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "llm_usage_events_workspace_isolation" ON "llm_usage_events" USING (workspace_id::text = current_setting('app.workspace_id', true));