import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { LLM_PROVIDER } from './llm.constants';
import type { LlmProvider } from './llm.types';
import { GeminiProvider } from './gemini.provider';
import { OllamaProvider } from './ollama.provider';
import { ResilientProvider } from './resilient.provider';
import { ScriptedProvider, defaultScriptedScript } from './scripted.provider';
import { UsageLedger } from './usage-ledger';
import { isPriced } from './pricing';

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
 *
 * PHASE 7 FAIL-CLOSED BOOT CHECK: a chain naming a model with no declared
 * price refuses to boot. Quota enforcement (QuotaGuard) bounds spend by the
 * costs the ledger computes; a model whose cost computes to NULL cannot be
 * bounded, so "unpriced therefore unlimited" would resurface the Phase 6
 * silent-$0 trap as an enforcement hole instead of a measurement hole. The
 * check runs at BOOT, not per request, because an unpriced chain is a
 * configuration error and no amount of traffic self-heals it. Ollama's
 * zero is DECLARED — declared-zero passes, unknown does not.
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
        // Fail-closed boot check (see the module doc). Each provider answers
        // with the model it was constructed with from config; the provider
        // instance knows its own name, so (name, model) identity is
        // available right here, before anything serves a request.
        for (const provider of providers) {
          const model = provider instanceof OllamaProvider
            ? config.get('GENERATION_MODEL', { infer: true })
            : config.get('GEMINI_MODEL', { infer: true });
          if (!isPriced(provider.name, model)) {
            throw new Error(
              `LLM_CHAIN member ${provider.name} (model ${model}) has no declared price in pricing.ts. ` +
              'Quota enforcement fails closed: declare the price (a genuine zero counts) or remove the member from LLM_CHAIN.',
            );
          }
        }
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