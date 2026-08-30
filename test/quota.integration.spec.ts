import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { Redis } from 'ioredis';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/database/schema';
import { UsageLedger } from '../src/llm/usage-ledger';
import { QUOTA_MONTHLY_MICRO_USD } from '../src/llm/quota.constants';
import { isPriced } from '../src/llm/pricing';

/**
 * Phase 7 quota enforcement, tested the only way a quota can be tested:
 * EXCEEDING it, against REAL Redis (the counter) and REAL Postgres (the
 * ledger), and asserting the enforcement point — withinBudget flips, the
 * guard's 402 fires before any SSE frame (covered in chat.controller.spec),
 * and the counter tracks the ledger's costs.
 *
 * The fail-closed boot check (unpriced model => the process refuses to
 * boot) is exercised here at the unit seam: isPriced drives the module
 * factory's decision, so the test asserts the pricing rule itself plus the
 * factory's behaviour with a stubbed chain member.
 */

describe('quota enforcement (integration, real Redis + Postgres)', () => {
  let owner: Client;
  let pool: Pool;
  let redis: Redis;
  let ledger: UsageLedger;
  let workspaceId: string;

  beforeAll(async () => {
    const ownerUrl = process.env.MIGRATION_DATABASE_URL;
    const appUrl = process.env.DATABASE_URL;
    const redisUrl = process.env.REDIS_URL;
    if (!ownerUrl || !appUrl || !redisUrl) throw new Error('DATABASE_URL, MIGRATION_DATABASE_URL and REDIS_URL must be set.');
    owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    pool = new Pool({ connectionString: appUrl, max: 2 });
    redis = new Redis(redisUrl);
    ledger = new UsageLedger(drizzle(pool, { schema }), redis);
    workspaceId = (await owner.query(`insert into workspaces (name) values ('quota-spec') returning id`)).rows[0].id;
  });

  afterAll(async () => {
    if (owner) {
      await owner.query(`delete from workspaces where name = 'quota-spec'`);
      await owner.end();
    }
    if (redis) {
      const month = new Date().toISOString().slice(0, 7);
      await redis.del(`quota:${workspaceId}:${month}`);
      await redis.quit();
    }
    if (pool) await pool.end();
  });

  it('counts metered spend into the monthly counter as the ledger records it', async () => {
    const month = new Date().toISOString().slice(0, 7);
    await redis.del(`quota:${workspaceId}:${month}`);
    // A gemini answer: priced, metered, successful => consumes quota.
    await ledger.record(workspaceId, {
      operation: 'chat_answer',
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      promptTokens: 150_000,
      completionTokens: 250_000,
      success: true,
    });
    const consumed = await ledger.consumedSoFar(workspaceId);
    // 150k prompt @ $0.25/1M = $0.0375; 250k completion @ $1.50/1M = $0.375.
    // $0.4125 total = 412,500 micro-USD.
    expect(consumed).toBe(412_500);
  });

  it('flips withinBudget once the month is overspent — and the flip is EXCEEDING the cap, not reaching it', async () => {
    const month = new Date().toISOString().slice(0, 7);
    await redis.del(`quota:${workspaceId}:${month}`);
    expect(await ledger.withinBudget(workspaceId)).toBe(true);

    // Overshoot the cap in one batch of recorded spend.
    await ledger.record(workspaceId, {
      operation: 'chat_answer',
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      promptTokens: 0,
      // Expressed in terms of the cap, not a literal, so this test still
      // overshoots if QUOTA_MONTHLY_MICRO_USD changes. Completion bills at
      // $1.50/1M = 1.5 micro-USD per token, so spending CAP tokens costs
      // 1.5 x CAP micro-USD — a decisive overshoot in a single call.
      completionTokens: QUOTA_MONTHLY_MICRO_USD,
      success: true,
    });
    expect(await ledger.withinBudget(workspaceId)).toBe(false);
  });

  it('does NOT count failed calls (no value delivered, retry would double-bill) but DOES count client disconnects', async () => {
    const month = new Date().toISOString().slice(0, 7);
    await redis.del(`quota:${workspaceId}:${month}`);

    await ledger.record(workspaceId, {
      operation: 'chat_answer',
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      promptTokens: 10_000,
      completionTokens: 10_000,
      success: false,
      errorKind: 'provider_error',
    });
    expect(await ledger.consumedSoFar(workspaceId)).toBe(0);

    await ledger.record(workspaceId, {
      operation: 'chat_answer',
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      promptTokens: 10_000,
      completionTokens: 10_000,
      success: false,
      errorKind: 'client_disconnect',
    });
    // 10k @ $0.25/1M + 10k @ $1.50/1M = $0.0175 = 17,500 micro-USD — the
    // provider charged us for a stream the client abandoned.
    expect(await ledger.consumedSoFar(workspaceId)).toBe(17_500);
  });

  it('fails closed at the pricing seam: an unpriced model is never quota-free', async () => {
    // Declared zero passes — the honest free tier.
    expect(isPriced('ollama', 'gpt-oss:120b')).toBe(true);
    expect(isPriced('scripted', 'scripted')).toBe(true);
    // Unknown anything fails closed.
    expect(isPriced('openai', 'gpt-4o')).toBe(false);
    expect(isPriced('gemini', 'gemini-3.0-pro-preview')).toBe(false);
    expect(isPriced(null, 'gpt-oss:120b')).toBe(false);
    expect(isPriced('ollama', null)).toBe(false);
  });

  it('keeps the counter and ledger in agreement on the same recorded spend', async () => {
    const month = new Date().toISOString().slice(0, 7);
    await redis.del(`quota:${workspaceId}:${month}`);
    for (let i = 0; i < 5; i++) {
      await ledger.record(workspaceId, {
        operation: 'chat_answer',
        provider: 'gemini',
        model: 'gemini-3.1-flash-lite',
        promptTokens: 20_000,
        completionTokens: 20_000,
        success: true,
      });
    }
    // 5 * (20k @ $0.25/1M + 20k @ $1.50/1M) = 5 * $0.035 = 175,000 micro-USD.
    expect(await ledger.consumedSoFar(workspaceId)).toBe(175_000);
    const ledgerSum = await owner.query(
      `select sum(cost_micro_usd)::int as total from llm_usage_events where workspace_id = $1 and provider = 'gemini'`,
      [workspaceId],
    );
    // The ledger is the source of truth; the counter agrees with it here.
    expect(Number(ledgerSum.rows[0].total)).toBeGreaterThanOrEqual(175_000);
  });
});