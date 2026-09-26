import { Module } from '@nestjs/common';
import { IngestionCoreModule } from './ingestion-core.module';
import { IngestionWorker } from './ingestion.worker';
import { UploadSweeperService } from './upload-sweeper.service';

/**
 * Worker-process wiring. The abandoned-upload sweeper lives HERE and not in
 * the API module on purpose: janitorial work belongs beside the queue
 * consumer, not on request threads behind a load balancer where every
 * replica would run its own copy.
 */
@Module({ imports: [IngestionCoreModule], providers: [IngestionWorker, UploadSweeperService] })
export class IngestionWorkerModule {}