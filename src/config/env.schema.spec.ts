import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';

/**
 * Config validation is the cheapest place to catch a deployment mistake, so
 * the cross-field rules deserve tests as much as the code they protect.
 */
const BASE = {
  DATABASE_URL: 'postgres://app:pw@localhost:5432/alexandria',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
  S3_BUCKET: 'alexandria',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('validateEnv', () => {
  it('accepts a single-provider chain with no Gemini key', () => {
    expect(validateEnv({ ...BASE, LLM_CHAIN: 'ollama' }).LLM_CHAIN).toBe('ollama');
  });

  it('refuses to boot when the chain names gemini but no key is set', () => {
    // The failure this prevents is not "Gemini is misconfigured" — it is
    // "the fallback silently never worked, discovered mid-incident", since a
    // fallback is only ever exercised once the primary is already down.
    expect(() => validateEnv({ ...BASE, LLM_CHAIN: 'ollama,gemini' })).toThrow(/GEMINI_API_KEY/);
  });

  it('accepts the same chain once the key is present, whitespace and all', () => {
    const env = validateEnv({ ...BASE, LLM_CHAIN: 'ollama, gemini', GEMINI_API_KEY: 'k' });
    expect(env.GEMINI_API_KEY).toBe('k');
  });

  it('still reports ordinary field errors with their path', () => {
    expect(() => validateEnv({ ...BASE, DATABASE_URL: 'mysql://nope' })).toThrow(/DATABASE_URL/);
  });
});
