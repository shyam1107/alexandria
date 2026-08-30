import { describe, expect, it } from 'vitest';
import { computeCostMicroUsd } from './pricing';

/**
 * The money rules, as executable arguments: integer micro-USD math, an
 * unknown price reads as NULL (loud), and zero is only ever a DECLARED
 * price.
 */
describe('computeCostMicroUsd', () => {
  it('computes exact integer micro-USD for a metered model', () => {
    // gemini-2.0-flash: $0.10 / $0.40 per 1M tokens.
    // 2M prompt + 500k completion = $0.20 + $0.20 = $0.40 = 400_000 micro-USD.
    expect(computeCostMicroUsd('gemini', 'gemini-2.0-flash', 2_000_000, 500_000)).toBe(400_000n);
  });

  it('floors sub-cent calls to integer micro-USD — never a float', () => {
    // 100 prompt tokens at $0.10/1M = 10 micro-USD exactly.
    expect(computeCostMicroUsd('gemini', 'gemini-2.0-flash', 100, 0)).toBe(10n);
    const cost = computeCostMicroUsd('gemini', 'gemini-2.0-flash', 7, 3);
    expect(typeof cost).toBe('bigint');
  });

  it('returns NULL for an unknown model — silently charging $0 is how a dashboard reads $0 for a month', () => {
    expect(computeCostMicroUsd('gemini', 'gemini-9-ultra', 1000, 1000)).toBeNull();
  });

  it('returns NULL when provider or model is unknown (mid-stream aborts through the chain)', () => {
    expect(computeCostMicroUsd(null, 'gpt-oss:120b', 100, 100)).toBeNull();
    expect(computeCostMicroUsd('ollama', null, 100, 100)).toBeNull();
  });

  it('self-hosted / flat-subscription models are a DECLARED zero, computed even with unknown token counts', () => {
    expect(computeCostMicroUsd('ollama', 'gpt-oss:120b', 12_345, 678)).toBe(0n);
    // A failed call reports null tokens; a flat-price provider still costs $0.
    expect(computeCostMicroUsd('ollama', 'nomic-embed-text', null, null)).toBe(0n);
  });
});
