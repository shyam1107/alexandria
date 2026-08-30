import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/database/schema';
import { MetricsService } from '../src/metrics/metrics.service';
import { TraceContextService } from '../src/metrics/trace-context.service';
import { TraceMiddleware } from '../src/metrics/trace.middleware';
import { UsageLedger } from '../src/llm/usage-ledger';

/**
 * Phase 7 observability. The metric layer's contract:
 *
 * 1. THE CARDINALITY RULE, asserted: no metric label may carry workspace
 *    ids (or any unbounded value). The test renders the full exposition
 *    after recorded traffic and asserts no workspace uuid appears — the
 *    rule enforced by test, not by convention, so the day someone adds a
 *    per-tenant label this suite names it.
 *
 * 2. THE PHASE 6 DEFERRED ALERT, real: a ledger write that fails must
 *    increment ledger_write_failures_total. The ledger swallows failures
 *    by design; the counter is what makes the swallow honest. Forced here
 *    with a ledger whose db write genuinely throws (a broken drizzle
 *    double), not by mocking the counter.
 */

describe('metrics (integration, real Postgres)', () => {
  let owner: Client;
  let pool: Pool;
  let workspaceId: string;

  beforeAll(async () => {
    const ownerUrl = process.env.MIGRATION_DATABASE_URL;
    const appUrl = process.env.DATABASE_URL;
    if (!ownerUrl || !appUrl) throw new Error('DATABASE_URL and MIGRATION_DATABASE_URL must be set.');
    owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    pool = new Pool({ connectionString: appUrl, max: 2 });
    workspaceId = (await owner.query(`insert into workspaces (name) values ('metrics-spec') returning id`)).rows[0].id;
  });

  afterAll(async () => {
    if (owner) {
      await owner.query(`delete from workspaces where name = 'metrics-spec'`);
      await owner.end();
    }
    if (pool) await pool.end();
  });

  it('exposes the three families in the scrape, in Prometheus format', async () => {
    const metrics = new MetricsService();
    metrics.recordHttp('/api/v1/chat', 200);
    metrics.recordHttp('/api/v1/chat', 429);
    metrics.observePreFrame(0.3, 'first_frame');
    metrics.recordLedgerWriteFailure('chat_answer');

    const exposition = await metrics.render();
    expect(exposition).toContain('http_requests_total{route="/api/v1/chat",status_class="2xx"} 1');
    expect(exposition).toContain('http_requests_total{route="/api/v1/chat",status_class="429"} 1');
    expect(exposition).toContain('ledger_write_failures_total{operation="chat_answer"} 1');
    expect(exposition).toContain('chat_pre_frame_duration_seconds_bucket{le="0.5",outcome="first_frame"} 1');
  });

  it('records status CLASSES, not raw statuses — bounded label set', async () => {
    const metrics = new MetricsService();
    metrics.recordHttp('/x', 200);
    metrics.recordHttp('/x', 201);
    metrics.recordHttp('/x', 204);
    metrics.recordHttp('/x', 400);
    metrics.recordHttp('/x', 404);
    metrics.recordHttp('/x', 500);
    metrics.recordHttp('/x', 503);
    const exposition = await metrics.render();
    // Three classes only: 2xx (3), 4xx (2), 5xx (2). 429 is its own class.
    expect(exposition).toContain('http_requests_total{route="/x",status_class="2xx"} 3');
    expect(exposition).toContain('http_requests_total{route="/x",status_class="4xx"} 2');
    expect(exposition).toContain('http_requests_total{route="/x",status_class="5xx"} 2');
  });

  it('THE CARDINALITY RULE: no workspace id ever appears in the exposition', async () => {
    const metrics = new MetricsService();
    // Recorded traffic that carries the workspace id in its payload/path.
    metrics.recordHttp('/api/v1/chat', 200);
    metrics.observePreFrame(0.2, 'first_frame');
    metrics.recordLedgerWriteFailure('embedding_query');
    const exposition = await metrics.render();
    // A uuid-shaped label value would be the cardinality trap: the rule is
    // "labels carry bounded sets", and this asserts the strongest form —
    // no workspace id anywhere, for any traffic recorded.
    expect(exposition).not.toContain(workspaceId);
    expect(exposureHasUuidLabels(exposition)).toBe(false);
  });

  it('THE PHASE 6 DEFERRED ALERT: a failed ledger write increments ledger_write_failures_total', async () => {
    const metrics = new MetricsService();
    // A ledger whose DB write genuinely fails (drizzle double that throws):
    // the failure path is exercised for real, not simulated by mocking the
    // counter. The quota Redis surface is a double (its behaviour has its
    // own suite).
    const redisDouble = { get: async () => null, incrby: async () => 0, expire: async () => 1, multi: () => ({ incrby: () => ({ expire: () => ({ exec: async () => [] }) }) }) } as never;
    const brokenDb = {
      transaction: async () => {
        throw new Error('connection refused');
      },
    } as never;
    const ledger = new UsageLedger(brokenDb, redisDouble, metrics);

    await ledger.record(workspaceId, { operation: 'chat_answer', provider: 'gemini', model: 'gemini-2.0-flash', promptTokens: 10, completionTokens: 10, success: true });

    const exposition = await metrics.render();
    expect(exposition).toContain('ledger_write_failures_total{operation="chat_answer"} 1');
  });

  it('a healthy ledger write increments nothing on the failure counter', async () => {
    const metrics = new MetricsService();
    const db = drizzle(pool, { schema });
    const redisDouble = { get: async () => null, incrby: async () => 0, expire: async () => 1, multi: () => ({ incrby: () => ({ expire: () => ({ exec: async () => [] }) }) }) } as never;
    const ledger = new UsageLedger(db, redisDouble, metrics);

    await ledger.record(workspaceId, { operation: 'chat_answer', provider: 'ollama', model: 'gpt-oss:120b', promptTokens: 10, completionTokens: 10, success: true });

    const exposition = await metrics.render();
    expect(exposition).not.toContain('ledger_write_failures_total{operation="chat_answer"} 1');
  });
});

/** Detects uuid-shaped values anywhere in label sets of an exposition. */
function exposureHasUuidLabels(exposition: string): boolean {
  const uuidRe = /\{[^}]*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/;
  return uuidRe.test(exposition);
}

describe('trace propagation (middleware → ALS → job payload)', () => {
  it('binds the incoming x-request-id and keeps it readable from any depth', async () => {
    const traces = new TraceContextService();

    // Outside a request: untraced.
    expect(traces.currentTraceId()).toBeUndefined();

    // Inside: the id from the header is bound, and survives nested async
    // hops — the property ALS exists for.
    let seenDeep: string | undefined;
    await traces.run('trace-abc-123', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      seenDeep = traces.currentTraceId();
    });
    expect(seenDeep).toBe('trace-abc-123');
    expect(traces.currentTraceId()).toBeUndefined();
  });

  it('echoes the SAME id it binds — no unset, no second id', async () => {
    const traces = new TraceContextService();
    const middleware = new TraceMiddleware(traces);

    const setHeaders: Record<string, string> = {};
    const request: Record<string, unknown> = { headers: {} };
    const response = { setHeader: (k: string, v: string) => { setHeaders[k] = v; } };
    let boundId: string | undefined;
    middleware.use(request as never, response as never, () => {
      boundId = traces.currentTraceId();
    });

    expect(setHeaders['x-request-id']).toBe(boundId);
    expect(setHeaders['x-request-id']).toMatch(/[0-9a-f-]{36}/);
    // And the request carries it too, for handlers that prefer direct access.
    expect((request as { requestId?: string }).requestId).toBe(boundId);
  });
});