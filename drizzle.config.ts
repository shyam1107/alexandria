import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    // Drizzle-kit runs outside Nest, so it reads the env directly.
    //
    // Migrations use MIGRATION_DATABASE_URL — the *owner* connection — not
    // DATABASE_URL, which is now the least-privilege runtime role with no DDL
    // rights. Keeping them separate is the point: the API and worker processes
    // never hold a credential that can alter a table or drop an RLS policy.
    url:
      process.env.MIGRATION_DATABASE_URL ??
      'postgres://alexandria:alexandria@localhost:5432/alexandria',
  },
});
