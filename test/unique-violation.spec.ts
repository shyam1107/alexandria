import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from '../src/database/errors';

/**
 * Regression: drizzle-orm >=0.44 wraps query failures in DrizzleQueryError,
 * so the pg error with `code`/`constraint` sits on `.cause`. The old
 * top-level-only check never matched, and duplicate-email register returned
 * 500 instead of 409. Both shapes must keep working.
 */
describe('isUniqueViolation unwraps drizzle-wrapped pg errors', () => {
  const pgError = { code: '23505', constraint: 'users_email_idx' };

  it('matches a bare pg error', () => {
    expect(isUniqueViolation(pgError, 'users_email_idx')).toBe(true);
  });

  it('matches a drizzle-wrapped pg error via .cause', () => {
    const wrapped = new Error('Failed query: insert into users');
    (wrapped as { cause?: unknown }).cause = pgError;
    expect(isUniqueViolation(wrapped, 'users_email_idx')).toBe(true);
  });

  it('rejects other pg codes and non-errors', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(new Error('no pg fields'))).toBe(false);
  });
});