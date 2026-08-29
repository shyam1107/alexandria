import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    setupFiles: ['test/setup.ts'],
    // Integration specs share one Postgres database. Running files in parallel
    // would interleave their fixtures; the suite is small enough that serial
    // execution costs less than the isolation machinery would.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
