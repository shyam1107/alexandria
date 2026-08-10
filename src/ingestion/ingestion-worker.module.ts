import { Module } from '@nestjs/common';
import { IngestionCoreModule } from './ingestion-core.module';
import { IngestionWorker } from './ingestion.worker';

@Module({ imports: [IngestionCoreModule], providers: [IngestionWorker] })
export class IngestionWorkerModule {}