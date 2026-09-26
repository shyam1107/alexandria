/**
 * Postgres `unique_violation`. Worth detecting explicitly: a pre-flight
 * "does it already exist?" SELECT is always racy, so the unique index is
 * the real guarantee and turns a lost race into a proper 409
 * instead of an unhandled 500.
 *
 * Drizzle (>=0.44) wraps query failures in DrizzleQueryError, so the pg
 * error with `code`/`constraint` sits on `.cause`. Unwrap before matching.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = unwrapPgError(error);
  if (!pgError) return false;
  if (pgError.code !== '23505') return false;
  return constraint === undefined || pgError.constraint === constraint;
}

function unwrapPgError(error: unknown): { code?: string; constraint?: string } | undefined {
  let current: unknown = error;
  // Bounded walk: pg error is at most one .cause deep under DrizzleQueryError,
  // but a small loop is cheaper than assuming and safer than recursing.
  for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth++) {
    if ('code' in current && 'constraint' in current) return current as { code?: string; constraint?: string };
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
