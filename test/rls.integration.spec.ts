import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * These tests exist because Row Level Security shipped in Phase 2 and did
 * nothing at all: the policies were ENABLEd but never FORCEd, and the
 * application connected as the table owner, which is exempt. Nothing failed,
 * no query returned wrong data, and the gap was invisible from the outside.
 *
 * That is the category of bug that only a test can hold down. Every assertion
 * below is written against the *runtime* connection — the same credential the
 * API and worker use — because a guarantee that only holds for the role in
 * the test harness is not a guarantee.
 */

const appUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.MIGRATION_DATABASE_URL;

/**
 * Tables keyed by workspace_id that intentionally carry no policy.
 * `memberships` is the chicken-and-egg case: resolving which workspace a
 * request belongs to *is* a membership lookup, so it cannot itself be gated
 * on app.workspace_id. Adding to this list should be a deliberate act.
 */
const TENANCY_EXEMPT_TABLES = ['memberships'];

describe('row level security', () => {
  let app: Client;
  let owner: Client;
  let workspaceA: string;
  let workspaceB: string;

  /** Runs `work` in a transaction that has declared its tenant, mirroring withWorkspace(). */
  async function asWorkspace<T>(workspaceId: string | null, work: () => Promise<T>): Promise<T> {
    await app.query('begin');
    try {
      if (workspaceId !== null) await app.query(`select set_config('app.workspace_id', $1, true)`, [workspaceId]);
      const result = await work();
      await app.query('commit');
      return result;
    } catch (error) {
      await app.query('rollback');
      throw error;
    }
  }

  beforeAll(async () => {
    if (!appUrl || !ownerUrl) throw new Error('DATABASE_URL and MIGRATION_DATABASE_URL must be set. Copy .env.example to .env.');
    app = new Client({ connectionString: appUrl });
    owner = new Client({ connectionString: ownerUrl });
    await app.connect();
    await owner.connect();

    // workspaces has no policy, so these are visible to both roles.
    workspaceA = (await owner.query(`insert into workspaces (name) values ('rls-spec-a') returning id`)).rows[0].id;
    workspaceB = (await owner.query(`insert into workspaces (name) values ('rls-spec-b') returning id`)).rows[0].id;
    for (const [workspaceId, title] of [[workspaceA, 'doc-a'], [workspaceB, 'doc-b']]) {
      await owner.query(`insert into documents (workspace_id, title) values ($1, $2)`, [workspaceId, title]);
    }
  });

  afterAll(async () => {
    // The owner is a superuser locally, so it can clean up regardless of policy.
    if (owner) {
      await owner.query(`delete from workspaces where name in ('rls-spec-a', 'rls-spec-b')`);
      await owner.end();
    }
    if (app) await app.end();
  });

  it('runs the application as a role that cannot bypass policies', async () => {
    const { rows } = await app.query(`
      select rolname, rolsuper, rolbypassrls
      from pg_roles where rolname = current_user
    `);
    expect(rows[0].rolsuper, 'a superuser ignores every RLS policy').toBe(false);
    expect(rows[0].rolbypassrls, 'BYPASSRLS ignores every RLS policy').toBe(false);
  });

  it('does not own the tables it queries', async () => {
    // Owners are exempt from RLS unless the table is FORCEd; not owning the
    // tables at all removes the exemption and the ability to drop policies.
    const { rows } = await app.query(`
      select count(*)::int as owned
      from pg_tables
      where schemaname = 'public' and tableowner = current_user
    `);
    expect(rows[0].owned).toBe(0);
  });

  it('enables and forces RLS on every workspace-keyed table', async () => {
    // Deliberately a rule rather than a hardcoded list: a table added in a
    // later phase with a workspace_id column is covered the moment it exists.
    const { rows } = await app.query(
      `
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and not (c.relname = any($1::text[]))
        and exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = c.relname and column_name = 'workspace_id'
        )
      order by c.relname
    `,
      [TENANCY_EXEMPT_TABLES],
    );

    expect(rows.length, 'expected to find workspace-keyed tables').toBeGreaterThan(0);
    for (const table of rows) {
      expect(table.relrowsecurity, `${table.relname} has RLS disabled`).toBe(true);
      expect(table.relforcerowsecurity, `${table.relname} is not FORCEd, so its owner bypasses it`).toBe(true);
    }
  });

  it('cascades every workspace-keyed table from workspaces', async () => {
    // RLS hides rows whose tenant is gone; it does not delete them. Without
    // this FK a deleted workspace leaves its documents, versions and vector
    // rows behind permanently, unreachable and unbilled-for. Unlike the RLS
    // rule above, there is no exemption list: every table carrying a
    // workspace_id must die with its workspace.
    const { rows } = await app.query(`
      select t.table_name,
             (select confdeltype::text
                from pg_constraint c
               where c.contype = 'f'
                 and c.conrelid = ('public.' || t.table_name)::regclass
                 and c.confrelid = 'public.workspaces'::regclass) as on_delete
      from information_schema.columns t
      where t.table_schema = 'public' and t.column_name = 'workspace_id'
      order by t.table_name
    `);

    expect(rows.length).toBeGreaterThan(0);
    for (const table of rows) {
      expect(table.on_delete, `${table.table_name}.workspace_id has no foreign key to workspaces`).not.toBeNull();
      expect(table.on_delete, `${table.table_name} does not cascade on workspace deletion`).toBe('c');
    }
  });

  it('returns nothing when no workspace context is set', async () => {
    // The failure mode that matters: forgetting to scope must yield zero rows,
    // never every tenant's rows.
    const { rows } = await app.query('select count(*)::int as visible from documents');
    expect(rows[0].visible).toBe(0);
  });

  it('shows a workspace only its own documents', async () => {
    const seenFromA = await asWorkspace(workspaceA, async () => (await app.query('select title from documents')).rows.map((r) => r.title));
    const seenFromB = await asWorkspace(workspaceB, async () => (await app.query('select title from documents')).rows.map((r) => r.title));
    expect(seenFromA).toEqual(['doc-a']);
    expect(seenFromB).toEqual(['doc-b']);
  });

  it('cannot read another workspace even when the id is known', async () => {
    // The attacker-supplied-id case: knowing workspace B's UUID is not enough,
    // because the policy compares against the session's declared tenant.
    const rows = await asWorkspace(workspaceA, async () => (await app.query('select id from documents where workspace_id = $1', [workspaceB])).rows);
    expect(rows).toHaveLength(0);
  });

  it('cannot write a row into another workspace', async () => {
    // A policy with USING and no WITH CHECK applies USING to writes too, so
    // the insert is rejected rather than silently landing where it cannot be read.
    await expect(
      asWorkspace(workspaceA, () => app.query(`insert into documents (workspace_id, title) values ($1, 'smuggled')`, [workspaceB])),
    ).rejects.toThrow(/row-level security/i);

    const { rows } = await owner.query('select count(*)::int as smuggled from documents where title = $1', ['smuggled']);
    expect(rows[0].smuggled).toBe(0);
  });

  it('discards the workspace context when the transaction ends', async () => {
    // set_config(..., true) is transaction-local. This is what makes RLS safe
    // on a pooled connection: the next checkout cannot inherit a tenant.
    await asWorkspace(workspaceA, async () => {
      expect((await app.query('select count(*)::int as visible from documents')).rows[0].visible).toBe(1);
    });

    // Note the representation: once a custom GUC has been set in a session it
    // stays "known" and reverts to its reset value, which is '' rather than
    // NULL. So "no tenant declared" has two shapes — unset (NULL) and reset
    // ('') — and both must fail closed. Asserting on visibility rather than on
    // the string keeps the test aimed at the guarantee, not the encoding.
    const { rows } = await app.query(`select current_setting('app.workspace_id', true) as context`);
    expect(rows[0].context).not.toBe(workspaceA);

    const after = await app.query('select count(*)::int as visible from documents');
    expect(after.rows[0].visible).toBe(0);
  });
});
