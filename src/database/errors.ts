/**
 * Postgres `unique_violation`. Worth detecting explicitly: a pre-flight
 * "does this already exist?" SELECT is always racy, so the unique index is
 * the real guarantee and this turns losing that race into a proper 409
 * instead of an unhandled 500.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const pgError = error as { code?: string; constraint?: string };
  if (pgError.code !== '23505') return false;
  return constraint === undefined || pgError.constraint === constraint;
}
