import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

/**
 * Worker entrypoint — no HTTP server. createApplicationContext boots the DI
 * container only; the process stays alive because the Redis connection (and,
 * from Phase 3, BullMQ workers) keep the event loop busy.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();

  logger.log('Worker started — waiting for jobs (queues arrive in Phase 3)', 'Worker');
}

void bootstrap();
