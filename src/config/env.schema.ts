import { z } from 'zod';

/**
 * Single source of truth for every environment variable the app reads.
 *
 * Fail-fast principle: if configuration is invalid, the process must refuse
 * to boot with a precise error — not limp along and fail at 3am when the
 * first request touches the misconfigured dependency.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().startsWith('postgres', 'must be a postgres:// connection string'),
  REDIS_URL: z.string().startsWith('redis', 'must be a redis:// connection string'),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  MAX_DOCUMENT_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  INGESTION_QUEUE: z.string().default('document-ingestion'),
  INGESTION_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  EMBEDDING_BASE_URL: z.string().default('http://localhost:11434'),
  EMBEDDING_MODEL: z.string().default('nomic-embed-text'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(768).refine((value) => value === 768, 'Phase 3 schema requires 768-dimensional embeddings'),
  CHUNK_SIZE: z.coerce.number().int().positive().default(1200),
  CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(200),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),

  OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
  GEMINI_API_KEY: z.string().optional(),

  // Generation (Phase 5). OLLAMA_API_KEY stays optional: local Ollama has no
  // auth, and the provider sends the Bearer header only when this is set —
  // same code path for localhost and ollama.com.
  OLLAMA_API_KEY: z.string().optional(),
  LLM_DRIVER: z.enum(['ollama', 'scripted']).default('ollama'),
  GENERATION_MODEL: z.string().default('gpt-oss:120b'),
  // Ollama defaults num_ctx to 2048 regardless of the model's advertised
  // window and then silently truncates the FRONT of the prompt — where the
  // system prompt lives. Always send it explicitly.
  GENERATION_NUM_CTX: z.coerce.number().int().positive().default(8192),
  GENERATION_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  // Grounded, cite-your-sources answering is not a creative task. Ollama's
  // default is 0.8, which measurably increases both invention and citation
  // drift — the behaviour Phase 8 exists to measure, so it must be pinned and
  // configurable rather than inherited.
  GENERATION_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  CHAT_HISTORY_MESSAGES: z.coerce.number().int().positive().default(10),
  // A message COUNT is not a size bound: ten turns of 4000-char questions and
  // 1024-token answers is ~10k tokens on its own. History is capped by tokens
  // too, and the oldest turns are dropped first.
  CHAT_HISTORY_TOKEN_BUDGET: z.coerce.number().int().positive().default(1500),
  // A ceiling, not an allocation: the effective context budget is the smaller
  // of this and whatever the model's window has left after the system prompt,
  // history, the question, and the reserved output.
  CHAT_CONTEXT_TOKEN_BUDGET: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
