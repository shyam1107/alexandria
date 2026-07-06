import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    // Drizzle-kit runs outside Nest, so it reads the env directly.
    url: process.env.DATABASE_URL ?? 'postgres://alexandria:alexandria@localhost:5432/alexandria',
  },
});
