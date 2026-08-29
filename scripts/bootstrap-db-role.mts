/**
 * Creates the least-privilege database role that the API and worker connect as.
 *
 * Why this is a separate step from migrations: roles are *infrastructure*, not
 * schema. In production they are provisioned once by IaC (Terraform, an RDS
 * master bootstrap, a platform team) with credentials the application deploy
 * never sees. This script is the local-development stand-in for that step, and
 * doubles as executable documentation of exactly what the role needs.
 *
 * The role deliberately has neither SUPERUSER nor BYPASSRLS. Both of those
 * exempt a role from Row Level Security, which would make every policy in
 * `drizzle/0002_force_rls.sql` decorative — the precise bug this fixes.
 *
 *   pnpm db:bootstrap
 */
import 'dotenv/config';
import { Client } from 'pg';

const migrationUrl = process.env.MIGRATION_DATABASE_URL;
const role = process.env.APP_DATABASE_ROLE ?? 'alexandria_app';
const password = process.env.APP_DATABASE_PASSWORD;

function fail(message: string): never {
  console.error(`bootstrap-db-role: ${message}`);
  process.exit(1);
}

if (!migrationUrl) fail('MIGRATION_DATABASE_URL is required — the owner connection that may create roles.');
if (!password) fail('APP_DATABASE_PASSWORD is required.');
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) fail(`APP_DATABASE_ROLE ${JSON.stringify(role)} is not a valid identifier.`);

/**
 * Role name and password arrive as bound parameters and are quoted server-side
 * by format() %I / %L. CREATE ROLE cannot take placeholders directly, so the
 * values are handed to the DO block through transaction-local settings rather
 * than concatenated into SQL text.
 */
const bindValues = `select set_config('bootstrap.role', $1, true), set_config('bootstrap.password', $2, true)`;

const createRole = `
  do $$
  declare
    role_name     text := current_setting('bootstrap.role');
    role_password text := current_setting('bootstrap.password');
  begin
    if exists (select 1 from pg_roles where rolname = role_name and (rolsuper or rolbypassrls)) then
      raise exception 'Role % holds SUPERUSER or BYPASSRLS and would bypass Row Level Security', role_name;
    end if;

    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('alter role %I login password %L', role_name, role_password);
      raise notice 'role % already existed; password updated', role_name;
    else
      execute format('create role %I login password %L', role_name, role_password);
      raise notice 'created role %', role_name;
    end if;

    execute format('grant connect on database %I to %I', current_database(), role_name);
    execute format('grant usage on schema public to %I', role_name);
  end
  $$;
`;

const client = new Client({ connectionString: migrationUrl });
client.on('notice', (notice) => console.log(`  postgres: ${notice.message}`));

try {
  await client.connect();
  // One transaction: the settings written by `bindValues` are transaction-local,
  // so `createRole` must read them before the COMMIT discards them.
  await client.query('begin');
  await client.query(bindValues, [role, password]);
  await client.query(createRole);
  await client.query('commit');
  console.log(`bootstrap-db-role: ${role} is ready. Run 'pnpm db:migrate' next to grant table privileges.`);
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await client.end();
}
