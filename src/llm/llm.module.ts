import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { LLM_PROVIDER } from './llm.constants';
import type { LlmProvider } from './llm.types';
import { GeminiProvider } from './gemini.provider';
import { OllamaProvider } from './ollama.provider';
import { ResilientProvider } from './resilient.provider';
import { UsageLedger } from './usage-ledger';
import { ScriptedProvider, defaultScriptedScript } from './scripted.provider';

/**
 * Global for the same reason DatabaseModule is: every phase from 5 onward
 * talks to models, and none of them should re-import wiring. Business logic
 * injects LLM_PROVIDER and never knows which vendor is behind it.
 *
 * LLM_CHAIN is a comma-separated fallback chain ('ollama', 'ollama,gemini').
 * Every chain — even a single provider — is wrapped in ResilientProvider:
 * timeouts and retries are not optional just because there is no fallback.
 * 'scripted' short-circuits entirely: a deterministic provider for CI and
 * smoke runs must not grow retries or clocks. Its script is a function of
 * the incoming messages — a fixed answer script would also be handed to the
 * query rewriter, which would then search for "This is a scripted answer".
 */
@Global()
@Module({
  providers: [
    OllamaProvider,
    GeminiProvider,
    UsageLedger,
    {
      provide: LLM_PROVIDER,
      useFactory: (config: ConfigService<Env, true>, ollama: OllamaProvider, gemini: GeminiProvider): LlmProvider => {
        const chain = config
          .get('LLM_CHAIN', { infer: true })
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean);
        if (chain.length === 1 && chain[0] === 'scripted') {
          return new ScriptedProvider(defaultScriptedScript);
        }
        const named: Record<string, LlmProvider> = { ollama, gemini };
        const providers = chain.map((name) => {
          const provider = named[name];
          if (!provider) throw new Error(`LLM_CHAIN names an unknown provider: ${name}`);
          return provider;
        });
        return new ResilientProvider({
          providers,
          maxRetries: config.get('LLM_MAX_RETRIES', { infer: true }),
          baseDelayMs: config.get('LLM_RETRY_BASE_MS', { infer: true }),
          retryAfterCapMs: config.get('LLM_RETRY_AFTER_CAP_MS', { infer: true }),
          firstTokenTimeoutMs: config.get('LLM_FIRST_TOKEN_TIMEOUT_MS', { infer: true }),
          idleTimeoutMs: config.get('LLM_IDLE_TIMEOUT_MS', { infer: true }),
        });
      },
      inject: [ConfigService, OllamaProvider, GeminiProvider],
    },
  ],
  exports: [LLM_PROVIDER, UsageLedger],
})
export class LlmModule {}
