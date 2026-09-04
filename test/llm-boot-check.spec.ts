import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module';
import { validateEnv } from '../src/config/env.schema';
import { assertPricedModels } from '../src/llm/llm.module';

/**
 * Item [4]: the fail-closed boot check must cover EMBEDDING_MODEL, not just
 * LLM_CHAIN generation members.
 *
 * Why this matters: usage-ledger.ts increments the Redis quota counter only
 * when cost computes non-null. An unpriced embedding model makes every
 * embedding call invisible to QuotaGuard — spend outside the cap, reported
 * as success. Local Ollama is free today, but OLLAMA_API_KEY exists so
 * EMBEDDING_BASE_URL can point at a metered host.
 *
 * How the decisive test works: it compiles the REAL AppModule (same shape as
 * bootstrap.integration.spec) with ConfigService overridden by a stub built
 * from the REAL validated env — only EMBEDDING_MODEL differs. The stub is
 * sourced from validateEnv rather than hand-rolled literals because a stale
 * literal is type-correct and silently measures the wrong thing (the
 * harness-config.ts landmine, applied here too).
 *
 * The first cut of this spec tested only the pure function and could NOT
 * fail when the factory stopped passing EMBEDDING_MODEL to it — the exact
 * "green suite constrains only what it exercises" trap. The factory test is
 * what bites.
 */

const configStub = (overrides: Record<string, unknown>) => {
  const values = { ...validateEnv(process.env as Record<string, unknown>), ...overrides };
  return { get: (key: string) => values[key as keyof typeof values] } as unknown as ConfigService;
};

describe('fail-closed boot check covers EMBEDDING_MODEL (item 4)', () => {
  it('the rule itself: declared zero passes, unknown fails closed', () => {
    expect(() =>
      assertPricedModels([{ label: 'EMBEDDING_MODEL', provider: 'ollama', model: 'snowflake-arctic-embed:110m' }]),
    ).not.toThrow();
    expect(() =>
      assertPricedModels([{ label: 'EMBEDDING_MODEL', provider: 'ollama', model: 'some-unknown-embed-model' }]),
    ).toThrow(/EMBEDDING_MODEL some-unknown-embed-model.*no declared price/s);
  });

  it('THE DECISIVE TEST: the process refuses to boot with an unpriced EMBEDDING_MODEL', async () => {
    // Before item [4] the factory checked LLM_CHAIN only; this configuration
    // booted and every embedding call escaped the quota counter.
    await expect(
      Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(ConfigService)
        .useValue(configStub({ EMBEDDING_MODEL: 'some-unknown-embed-model' }))
        .compile(),
    ).rejects.toThrow(/some-unknown-embed-model.*no declared price/s);
  });

  it('boots with the priced default embedding model', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue(configStub({}))
      .compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});