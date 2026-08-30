import { describe, expect, it } from 'vitest';
import { GeminiProvider } from '../src/llm/gemini.provider';
import type { Env } from '../src/config/env.schema';
import type { ConfigService } from '@nestjs/config';
import type { LlmEvent } from '../src/llm/llm.types';
import { envSchema } from '../src/config/env.schema';

/**
 * The model under test comes from the SCHEMA's default, never a literal here.
 * A hardcoded fallback in this file is how the probe ends up faithfully
 * testing a model the application no longer uses — which is exactly what
 * happened on the first run: the app had moved on and the probe kept calling
 * a decommissioned model.
 */
const DEFAULT_GEMINI_MODEL = envSchema.shape.GEMINI_MODEL.parse(undefined);

/**
 * The live Gemini one-shot — the probe that has been outstanding since Phase 6.
 *
 * Every other provider claim in this repository rests on an observation. This
 * adapter's rested on a fixture: a recorded SSE body replayed by a local HTTP
 * server. A fixture proves the PARSER handles the bytes it was given; it
 * cannot prove those bytes still resemble what Google sends. This closes that
 * gap, and its findings decide whether the fixture is honest.
 *
 *   GEMINI_LIVE=1 pnpm test test/gemini-live.spec.ts
 *
 * Gated, not skipped-by-default-forever: it costs real (free-tier) quota and
 * needs a key, so CI must never depend on it. Re-run it after any change to
 * the adapter's request shape, and after a model version bump.
 */

const RUN = process.env.GEMINI_LIVE === '1' && Boolean(process.env.GEMINI_API_KEY);

const config = {
  get: (key: string) => {
    const values: Record<string, unknown> = {
      GEMINI_BASE_URL: process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com',
      GEMINI_MODEL: process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GEMINI_NUM_CTX: 1_048_576,
    };
    if (!(key in values)) throw new Error(`gemini-live: unexpected config key ${key}`);
    return values[key];
  },
} as unknown as ConfigService<Env, true>;

describe.runIf(RUN)('GeminiProvider against the live API (GEMINI_LIVE=1)', () => {
  it('streams a grounded answer and maps every field the fixture claims', async () => {
    const provider = new GeminiProvider(config);
    const events: LlmEvent[] = [];

    // Deliberately shaped like a real chat prompt, because the mapping under
    // test is the whole point: a system message (which Gemini has no role
    // for — it becomes systemInstruction), a prior assistant turn (which is
    // Gemini's 'model' role), and a closing user turn. A single user message
    // would exercise none of that.
    for await (const event of provider.stream({
      messages: [
        { role: 'system', content: 'You answer using only the provided context. Cite it as [1]. If the context does not answer, say you do not know.' },
        { role: 'user', content: 'What is the refund window?' },
        { role: 'assistant', content: 'The refund window is 30 days [1].' },
        { role: 'user', content: 'And for annual plans?' },
      ],
      maxTokens: 128,
      temperature: 0,
      purpose: 'answer',
    })) {
      events.push(event);
    }

    const deltas = events.filter((e) => e.type === 'delta') as Array<{ text: string }>;
    const done = events.at(-1) as Extract<LlmEvent, { type: 'done' }>;

    // 1. It streamed — more than one frame, i.e. genuinely incremental.
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((d) => d.text).join('')).not.toBe('');

    // 2. The terminal frame is a done, and it is the LAST event.
    expect(done?.type).toBe('done');

    // 3. usageMetadata was found and parsed. Zero here would mean the adapter
    //    is reading a field the API no longer populates — the exact drift a
    //    fixture cannot detect.
    expect(done.usage.promptTokens).toBeGreaterThan(0);
    expect(done.usage.completionTokens).toBeGreaterThan(0);

    // 4. finishReason mapped into our vocabulary, not passed through raw.
    expect(['stop', 'length', 'content_filter']).toContain(done.finishReason);

    // 5. Attribution the ledger depends on.
    expect(done.provider).toBe('gemini');
    expect(done.model).toBeTruthy();

    console.log(
      `[gemini-live] model=${done.model} finish=${done.finishReason} ` +
        `promptTokens=${done.usage.promptTokens} completionTokens=${done.usage.completionTokens} ` +
        `deltas=${deltas.length} chars=${deltas.map((d) => d.text).join('').length}`,
    );
  }, 60_000);
});
