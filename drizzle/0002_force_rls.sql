-- Make Row Level Security actually enforce.
--
-- Migration 0001 enabled RLS and wrote the isolation policies, but two
-- Postgres exemptions meant they never ran:
--
--   1. The table OWNER is exempt from RLS unless the table is also FORCEd.
--   2. A SUPERUSER is exempt always, even with FORCE.
--
-- The application connected as the same role that owns the tables, and in the
-- docker image that role is the initdb superuser -- so it hit both. Every
-- tenant-isolation policy was decorative, and the only thing separating
-- workspaces was the application's own WHERE clauses.
--
-- The fix has two halves. FORCE (below) closes the owner exemption. The other
-- half is operational: the API and worker now connect as `alexandria_app`,
-- a role that owns nothing and is neither SUPERUSER nor BYPASSRLS.
-- See scripts/bootstrap-db-role.ts.

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alexandria_app') THEN
		RAISE EXCEPTION 'Role alexandria_app does not exist. Run: pnpm db:bootstrap';
	END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_chunks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The app role owns nothing, so every privilege it has is granted explicitly.
-- No DDL, no TRUNCATE, no REFERENCES: a compromised application credential
-- cannot drop a table or disable a policy.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "alexandria_app";--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "alexandria_app";--> statement-breakpoint

-- Tables created by later migrations inherit the same grants automatically,
-- so a future phase cannot ship a table the application silently cannot read.
-- FOR ROLE is omitted deliberately: it defaults to the role running this
-- migration, which is whichever role owns the schema in this environment.
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "alexandria_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT USAGE, SELECT ON SEQUENCES TO "alexandria_app";

-- Note on the tables that deliberately have NO policy:
--   users, workspaces, memberships, refresh_tokens
-- Authentication runs before a workspace is known -- the membership lookup is
-- what *determines* the tenant -- so those reads cannot be gated on
-- app.workspace_id without a chicken-and-egg deadlock. They stay guarded in
-- application code. Everything workspace-keyed is gated in the database.
