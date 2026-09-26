// One-shot: register/login, re-upload the dossier, drive it to indexed.
// Run: node scripts/reingest-dossier.mjs
const API = 'http://localhost:3000/api/v1';
const FILE = '/home/shyam/Documents/saas-opportunity-dossier.md';
const EMAIL = 'reingest-test@alexandria.local';
const PASSWORD = 'test-password-123';

import fs from 'node:fs';

const post = async (path, body, token, ws) => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(ws ? { 'x-workspace-id': ws } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
};

// register or login (register 500s on existing email — known bug, noted)
let auth;
try {
  auth = await post('/auth/register', { email: EMAIL, password: PASSWORD, workspaceName: 'reingest-test' });
} catch {
  auth = await post('/auth/login', { email: EMAIL, password: PASSWORD });
}
const token = auth.accessToken;
// ponytail: no workspace-discovery endpoint exists (known API gap, see
// demo-ui controller); read the id from the DB via docker psql. Goes away
// when the gap is closed with a /me or workspaces-list endpoint.
const { execSync } = await import('node:child_process');
const workspaceId = execSync(
  `docker compose exec -T postgres psql -U alexandria -d alexandria -t -A -c "select w.id from workspaces w join memberships m on m.workspace_id = w.id join users u on u.id = m.user_id where u.email = '${EMAIL}' limit 1"`,
  { cwd: '/home/shyam/Documents/Github/alexandria' },
).toString().trim();
console.log('auth ok, workspace:', workspaceId);

const buffer = fs.readFileSync(FILE);
const contentType = 'text/markdown';
const filename = 'saas-opportunity-dossier.md';

// create upload
const created = await post('/documents', { filename, contentType, byteSize: buffer.length }, token, workspaceId);
console.log('upload created, version:', created.versionId);

// PUT to presigned URL
const put = await fetch(created.uploadUrl, { method: 'PUT', headers: { 'content-type': contentType }, body: buffer });
if (!put.ok) throw new Error(`PUT failed: ${put.status}`);
console.log('object uploaded');

// complete
await post(`/documents/${created.document.id}/complete`, { versionId: created.versionId }, token, workspaceId);
console.log('complete accepted, waiting for worker...');

// poll status
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const res = await fetch(`${API}/documents/${created.document.id}`, { headers: { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId } });
  const doc = await res.json();
  console.log(`poll ${i}: status=${doc.status}`);
  if (doc.status === 'indexed' || doc.status === 'failed') {
    if (doc.status === 'failed') {
      console.log('FAILURE:', doc.versions?.[0]?.failureMessage);
      process.exit(1);
    }
    console.log('INDEXED. versions:', doc.versions?.length, 'chunks expected ~29');
    process.exit(0);
  }
}
console.log('timeout waiting for indexed');
process.exit(1);