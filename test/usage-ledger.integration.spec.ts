import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { ConfigService } from '@nestjs/config';
import * as schema from '../src/database/schema';
import type { Env } from '../src/config/env.schema';
import type { Db } from '../src/database/database.module';
import { withWorkspace } from '../src/database/tenant';
import { llmUsageEvents } from '../src/database/schema';
import { UsageLedger } from '../src/llm/usage-ledger';
import { EmbeddingService } from '../src/ingestion/embedding.service';

/**
 * The cost ledger against the real database AS THE RUNTIME ROLE — RLS live.
 * Chat-answer and rewrite rows are asserted by the chat integration suite
 * end to end; this spec covers what that one can't: embedding operations
 * through the real EmbeddingService (fetch stubbed), direct ledger writes,
 * integer money, the unknown-model NULL rule, and cross-tenant reads.
 */

const VECTOR = Array.from({ length: 768 }, (_, i) => i / 768);

describe('usage ledger (integration)', () => {
  let owner: Client;
  let pool: Pool;
  let db: Db;
  let ledger: UsageLedger;
  let workspaceA: string;
  let workspaceB: string;

  function embeddingService(): EmbeddingService {
    const values = {
      EMBEDDING_BASE_URL: 'http://embeddings.test',
      EMBEDDING_MODEL: 'nomic-embed-text',
      EMBEDDING_DIMENSIONS: 768,
      EMBEDDING_TIMEOUT_MS: 5_000,
      EMBEDDING_MAX_RETRIES: 0,
    } as Partial<Env>;
    return new EmbeddingService({ get: (key: keyof Env) => values[key] } as unknown as ConfigService<Env, true>, ledger);
  }

  beforeAll(async () => {
    const ownerUrl = process.env.MIGRATION_DATABASE_URL;
    const appUrl = process.env.DATABASE_URL;
    if (!ownerUrl || !appUrl) throw new Error('DATABASE_URL and MIGRATION_DATABASE_URL must be set.');
    owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    pool = new Pool({ connectionString: appUrl, max: 2 });
    db = drizzle(pool, { schema });
    ledger = new UsageLedger(db);

    workspaceA = (await owner.query(`insert into workspaces (name) values ('ledger-spec-a') returning id`)).rows[0].id;
    workspaceB = (await owner.query(`insert into workspaces (name) values ('ledger-spec-b') returning id`)).rows[0].id;
  });

  afterAll(async () => {
    if (owner) {
      await owner.query(`delete from workspaces where name in ('ledger-spec-a', 'ledger-spec-b')`);
      await owner.end();
    }
    if (pool) await pool.end();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('writes a row for every embedding call — index and query are LLM spend too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ embedding: VECTOR }) })));
    const embeddings = embeddingService();

    await embeddings.embed('chunk of a document', { workspaceId: workspaceA, operation: 'embedding_index' });
    await embeddings.embed('a search query', { workspaceId: workspaceA, operation: 'embedding_query' });

    const rows = (await owner.query(`select operation, provider, model, success, cost_micro_usd from llm_usage_events where workspace_id = $1 order by created_at`, [workspaceA])).rows;
    expect(rows.map((r) => r.operation)).toEqual(['embedding_index', 'embedding_query']);
    for (const row of rows) {
      expect(row).toMatchObject({ provider: 'ollama', model: 'nomic-embed-text', success: true });
      // Ollama embeddings report no usage; the DECLARED flat price computes
      // to an integer zero anyway. pg returns bigint as a string.
      expect(row.cost_micro_usd).toBe('0');
    }
  });

  it('records failed calls with the tokens unknown, not estimated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, headers: new Headers(), text: async () => 'bad' })));
    await expect(embeddingService().embed('x', { workspaceId: workspaceA, operation: 'embedding_query' })).rejects.toThrow(/400/);

    const rows = (await owner.query(
      `select success, error_kind, prompt_tokens, cost_micro_usd from llm_usage_events where workspace_id = $1 and success = false`,
      [workspaceA],
    )).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ error_kind: 'provider_error', prompt_tokens: null });
  });

  it('stores cost as integer micro-USD and NULL for an undeclared model — never a silent zero', async () => {
    await ledger.record(workspaceA, {
      operation: 'chat_answer',
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      promptTokens: 2_000_000,
      completionTokens: 500_000,
      success: true,
    });
    await ledger.record(workspaceA, { operation: 'chat_answer', provider: 'gemini', model: 'gemini-9-unpriced', promptTokens: 10, completionTokens: 10, success: true });

    const rows = (await owner.query(
      `select model, cost_micro_usd from llm_usage_events where workspace_id = $1 and provider = 'gemini' order by created_at`,
      [workspaceA],
    )).rows;
    // $0.10/1M prompt + $0.40/1M completion: 2M/500k = $0.40 = 400_000 micro-USD.
    expect(rows[0]).toEqual({ model: 'gemini-2.0-flash', cost_micro_usd: '400000' });
    expect(rows[1]).toEqual({ model: 'gemini-9-unpriced', cost_micro_usd: null });
  });

  it('cannot read another workspace’s ledger rows — RLS applies here like everywhere else', async () => {
    await ledger.record(workspaceA, { operation: 'chat_answer', provider: 'scripted', model: 'scripted', promptTokens: 1, completionTokens: 1, success: true });

    const visible = await withWorkspace(db, workspaceB, async (tx) => tx.select().from(llmUsageEvents));
    expect(visible.every((row) => row.workspaceId === workspaceB)).toBe(true);

    const ownRows = await withWorkspace(db, workspaceA, async (tx) => tx.select().from(llmUsageEvents));
    expect(ownRows.length).toBeGreaterThan(0);
    expect(ownRows.every((row) => row.workspaceId === workspaceA)).toBe(true);
  });
});
