// One-shot check: chunk the failing dossier at CHUNK_SIZE=900 and embed every
// chunk against the live provider. Run: node scripts/check-chunk-embed.mjs
import fs from 'node:fs';

const text = fs.readFileSync('/home/shyam/Documents/saas-opportunity-dossier.md', 'utf8');

// Replicate ChunkerService.normalize
const chars = [];
let i = 0;
while (i < text.length) {
  const c = text[i];
  if (c === '\r' && text[i + 1] === '\n') { chars.push('\n'); i += 2; }
  else if (c === ' ' || c === '\t') { let j = i; while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++; chars.push(' '); i = j; }
  else { chars.push(c); i++; }
}
const normalized = chars.join('');

// Replicate ChunkerService.split
const size = 900, overlap = 200;
let start = 0;
const chunks = [];
while (start < normalized.length) {
  let end = Math.min(start + size, normalized.length);
  if (end < normalized.length) {
    const boundary = normalized.lastIndexOf('\n', end);
    const space = normalized.lastIndexOf(' ', end);
    end = Math.max(boundary, space, start + Math.floor(size * 0.7));
  }
  chunks.push(normalized.slice(start, end));
  if (end >= normalized.length) break;
  let next = Math.max(end - overlap, start + 1);
  const b = /\s/.exec(normalized.slice(next, end));
  if (b) next += b.index + 1;
  start = next;
}

let fail = 0;
for (const c of chunks) {
  const res = await fetch('http://localhost:11434/api/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'snowflake-arctic-embed:110m', prompt: c }),
  });
  if (res.status !== 200) { fail++; console.log('FAIL', c.length, await res.text()); }
}
console.log('chunks:', chunks.length, 'failures:', fail);
if (fail > 0) process.exit(1);