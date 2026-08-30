import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { LLM_PROVIDER } from './llm.constants';
import type { LlmProvider } from './llm.types';
import { OllamaProvider } from './ollama.provider';
import { ScriptedProvider } from './scripted.provider';

/**
 * Global for the same reason DatabaseModule is: every phase from 5 onward
 * talks to models, and none of them should re-import wiring. Business logic
 * injects LLM_PROVIDER and never knows which vendor is behind it.
 *
 * LLM_DRIVER=scripted exists so the API can boot and serve the full chat
 * pipeline with no model at all — CI, and laptops without a GPU.
 */
@Global()
@Module({
  providers: [
    OllamaProvider,
    {
      provide: LLM_PROVIDER,
      useFactory: (config: ConfigService<Env, true>, ollama: OllamaProvider): LlmProvider =>
        config.get('LLM_DRIVER', { infer: true }) === 'scripted'
          ? new ScriptedProvider(['This ', 'is ', 'a ', 'scripted ', 'answer ', '[1].'])
          : ollama,
      inject: [ConfigService, OllamaProvider],
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
