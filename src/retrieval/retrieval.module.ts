import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
// Query embedding reuses the ingestion EmbeddingService. Embedding is no
// longer an ingestion-only concern — it moves into the Phase 6 LLM platform
// layer behind the provider interface; extracting it twice is worse than
// importing it from the "wrong" module once.
import { IngestionCoreModule } from '../ingestion/ingestion-core.module';
import { RetrievalController } from './retrieval.controller';
import { RetrievalService } from './retrieval.service';

@Module({
  imports: [IngestionCoreModule, AuthModule],
  controllers: [RetrievalController],
  providers: [RetrievalService],
})
export class RetrievalModule {}
