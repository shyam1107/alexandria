/**
 * Seeds a demo workspace so the local UI has something to answer from.
 *
 * Goes through the REAL HTTP API — register, presign, PUT to object storage,
 * complete, poll for indexing — rather than inserting rows. A seeder that
 * writes straight to the database proves the database works; this proves the
 * ingestion path works, which is the thing being demonstrated.
 *
 * Prerequisites: `pnpm infra:up`, then the API and the worker running
 * (`pnpm start:dev` and `pnpm start:worker:dev`). The worker is what does the
 * chunking and embedding — without it, documents sit at 'uploaded' forever.
 *
 *   pnpm demo:seed
 *
 * Re-runnable: if the demo account already exists it logs in instead, and
 * documents whose content is unchanged are refused as duplicates by design,
 * which the script reports rather than treats as failure.
 */
import 'dotenv/config';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const API = process.env.DEMO_API_URL ?? 'http://localhost:3000/api/v1';
const EMAIL = process.env.DEMO_EMAIL ?? 'demo@northwind.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-1234';
const WORKSPACE_NAME = 'Northwind Systems';
const CORPUS = join(process.cwd(), 'demo', 'corpus');
const CONFIG_OUT = join(process.cwd(), 'demo', 'demo-config.json');

function fail(message: string): never {
  console.error(`\nseed-demo: ${message}\n`);
  process.exit(1);
}

async function api(path: string, init: RequestInit & { token?: string; workspaceId?: string } = {}) {
  const { token, workspaceId, ...rest } = init;
  const response = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
      ...rest.headers,
    },
  });
  const body = await response.text();
  const parsed = body ? JSON.parse(body) : undefined;
  return { ok: response.ok, status: response.status, body: parsed };
}

/**
 * The API has no way for a client to discover its own workspace: neither
 * register nor login returns one, and there is no list endpoint — but every
 * tenant route requires the x-workspace-id header. Until that gap is closed,
 * the seeder reads it from the database with the owner role, the same way the
 * integration suite does.
 */
async function findWorkspaceId(): Promise<string> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) fail('MIGRATION_DATABASE_URL must be set (copy .env.example to .env)');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(
      `select w.id from workspaces w
       join memberships m on m.workspace_id = w.id
       join users u on u.id = m.user_id
       where u.email = $1 order by w.created_at desc limit 1`,
      [EMAIL],
    );
    if (!rows[0]) fail(`no workspace found for ${EMAIL}`);
    return rows[0].id as string;
  } finally {
    await client.end();
  }
}

async function main() {
  console.log(`seed-demo: using ${API}`);

  // Login FIRST, register only if that fails. Re-runnability aside, this is
  // also a workaround: registering with an email that already exists returns
  // 500, not 409 — the unique-violation is not mapped — so "did this account
  // already exist?" cannot be answered from the register response.
  let session = (await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })).body;

  if (session?.accessToken) {
    console.log(`  signed in as ${EMAIL}`);
  } else {
    const registered = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, workspaceName: WORKSPACE_NAME }),
    });
    if (registered.status === 429) fail('rate limited; wait five minutes or set DEMO_EMAIL to something else');
    if (!registered.ok) fail(`register failed (${registered.status}): ${JSON.stringify(registered.body)}`);
    session = registered.body;
    console.log(`  created account ${EMAIL}`);
  }

  const token = session?.accessToken;
  if (!token) fail('could not obtain an access token — is the API running?');

  const workspaceId = await findWorkspaceId();
  console.log(`  workspace ${workspaceId}`);

  const files = readdirSync(CORPUS).filter((name) => name.endsWith('.txt')).sort();
  if (files.length === 0) fail(`no .txt files in ${CORPUS}`);

  const pending: Array<{ documentId: string; filename: string }> = [];
  for (const filename of files) {
    const content = readFileSync(join(CORPUS, filename));
    const created = await api('/documents', {
      method: 'POST',
      token,
      workspaceId,
      body: JSON.stringify({ filename, contentType: 'text/plain', byteSize: content.byteLength }),
    });
    if (!created.ok) fail(`presign failed for ${filename} (${created.status}): ${JSON.stringify(created.body)}`);

    // ContentLength is a signed header, so the body must be exactly the size
    // declared above — a mismatch fails the signature, not the size check.
    const put = await fetch(created.body.uploadUrl, {
      method: 'PUT',
      body: content,
      headers: { 'content-type': 'text/plain' },
    });
    if (!put.ok) fail(`upload failed for ${filename} (${put.status}) — check the declared byteSize matches the file`);

    const completed = await api(`/documents/${created.body.document.id}/complete`, {
      method: 'POST',
      token,
      workspaceId,
      body: JSON.stringify({ versionId: created.body.versionId }),
    });
    if (completed.status === 409) {
      console.log(`  ${filename}: identical content already indexed — skipping`);
      continue;
    }
    if (!completed.ok) fail(`complete failed for ${filename} (${completed.status}): ${JSON.stringify(completed.body)}`);
    pending.push({ documentId: created.body.document.id, filename });
    console.log(`  ${filename}: queued`);
  }

  if (pending.length) {
    console.log('  waiting for indexing (the worker must be running)...');
    const deadline = Date.now() + 180_000;
    while (pending.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      for (let i = pending.length - 1; i >= 0; i--) {
        const status = await api(`/documents/${pending[i].documentId}`, { token, workspaceId });
        if (status.body?.status === 'indexed') {
          console.log(`  ${pending[i].filename}: indexed`);
          pending.splice(i, 1);
        } else if (status.body?.status === 'failed') {
          fail(`${pending[i].filename} failed to index — check the worker log`);
        }
      }
    }
    if (pending.length) fail(`timed out waiting for: ${pending.map((p) => p.filename).join(', ')}. Is the worker running?`);
  }

  writeFileSync(CONFIG_OUT, `${JSON.stringify({ email: EMAIL, password: PASSWORD, workspaceId, workspaceName: WORKSPACE_NAME }, null, 2)}\n`);
  console.log(`\nseed-demo: ready. Wrote ${CONFIG_OUT}`);
  console.log('Open http://localhost:3000/ui\n');
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
