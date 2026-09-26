import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { INGESTION_QUEUE } from './ingestion.constants';
import { StorageService } from './storage.service';
import { ParserService } from './parser.service';
import { ChunkerService } from './chunker.service';
import { EmbeddingCache } from './embedding-cache.service';
import { EmbeddingService } from './embedding.service';
import { DocumentService } from './document.service';
import { LlmModule } from '../llm/llm.module';
import { MetricsCoreModule } from '../metrics/metrics-core.module';

function redisConnection(url: string) {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379), username: parsed.username || undefined, password: parsed.password || undefined, db: parsed.pathname ? Number(parsed.pathname.slice(1)) || 0 : 0 };
}

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({ connection: redisConnection(config.get('REDIS_URL', { infer: true })) }),
    }),
    BullModule.registerQueue({ name: INGESTION_QUEUE }),
    // EmbeddingService injects UsageLedger, which LlmModule provides. LlmModule
    // is @Global(), but a global module must still appear in the graph to be
    // loaded at all: the API got it transitively via AppModule, the worker
    // never imported it, and start:worker could not boot from Phase 6 until
    // this line existed. Imported by the module that actually consumes it.
    LlmModule,
    // DocumentService injects TraceContextService, and UsageLedger records into
    // MetricsService. Both live in MetricsCoreModule — NOT MetricsModule,
    // which carries the /metrics controller and HTTP middleware the worker
    // must not load.
    MetricsCoreModule,
  ],
  providers: [StorageService, ParserService, ChunkerService, EmbeddingCache, EmbeddingService, DocumentService],
  exports: [BullModule, StorageService, ParserService, ChunkerService, EmbeddingService, DocumentService],
})
export class IngestionCoreModule {}