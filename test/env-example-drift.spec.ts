import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../src/config/env.schema';

/**
 * CLAUDE.md: "Env vars: add to src/config/env.schema.ts (zod, fail-fast) AND
 * .env.example." This asserts it, in both directions.
 *
 * It exists because the file has now drifted twice. Most recently an
 * unescaped `sed` capture group replaced the `HNSW_EF_SEARCH=80` line with a
 * literal `\1`, which no signal caught: the schema default silently applied,
 * so nothing failed — a developer copying .env.example simply lost a
 * documented tuning knob, and gained a stray token of unexplained provenance.
 *
 * A COMMENTED entry (`# GEMINI_API_KEY=`) counts as documented. That is the
 * right convention for optional secrets: the key is discoverable, and an
 * empty value would be indistinguishable from a deliberately blank one.
 */

/** Vars consumed outside the app process, so deliberately absent from its schema. */
const NOT_APP_CONFIG: Record<string, string> = {
  MIGRATION_DATABASE_URL: 'owner-role URL used by drizzle-kit and the integration suite, never by the app',
  APP_DATABASE_ROLE: 'consumed by scripts/bootstrap-db-role.mts when provisioning the runtime role',
  APP_DATABASE_PASSWORD: 'consumed by scripts/bootstrap-db-role.mts when provisioning the runtime role',
};

function documentedKeys(): Set<string> {
  const text = readFileSync('.env.example', 'utf8');
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) keys.add(match[1]);
  }
  return keys;
}

describe('.env.example matches the env schema', () => {
  const documented = documentedKeys();
  const declared = new Set(Object.keys(envSchema.shape));

  it('documents every var the schema declares', () => {
    const missing = [...declared].filter((key) => !documented.has(key)).sort();
    expect(missing, 'These are in env.schema.ts but not .env.example — a fresh clone cannot discover them').toEqual([]);
  });

  it('declares every var .env.example documents, or explains why not', () => {
    const undeclared = [...documented].filter((key) => !declared.has(key) && !(key in NOT_APP_CONFIG)).sort();
    expect(undeclared, 'These are in .env.example but not the schema. Add them to the schema, or to NOT_APP_CONFIG with the reason').toEqual([]);
  });

  it('contains no residue from a botched search-and-replace', () => {
    const text = readFileSync('.env.example', 'utf8');
    const suspicious = text.split('\n').map((line, i) => [i + 1, line] as const).filter(([, line]) => /^\s*\\\d/.test(line));
    expect(suspicious, 'lines that look like an unescaped regex capture group').toEqual([]);
  });
});
