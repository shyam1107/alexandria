import { describe, expect, it } from 'vitest';
import { IngestionWorker } from './ingestion.worker';
import { INGESTION_QUEUE } from './ingestion.constants';

/**
 * Phase 7 config honesty. `INGESTION_WORKER_CONCURRENCY` was validated by the
 * env schema since Phase 1 and read by nobody: the worker ran at BullMQ's
 * default of 1 while the config advertised 2. A knob that does nothing is
 * worse than no knob, because it is a lie you tune during an incident.
 *
 * The assertion is on the decorator's metadata rather than on runtime
 * throughput because that is where the wiring actually lives — and because
 * @nestjs/bullmq only sets WORKER_METADATA when options are passed at all,
 * so this fails outright (metadata undefined) on the un-wired version.
 */
describe('IngestionWorker registration', () => {
  it('passes the configured concurrency through to the worker options', () => {
    const options = Reflect.getMetadata('bullmq:worker_metadata', IngestionWorker) as { concurrency?: number } | undefined;
    expect(options, 'no worker options on the @Processor decorator — concurrency is not wired').toBeDefined();
    expect(options!.concurrency).toBe(Number(process.env.INGESTION_WORKER_CONCURRENCY) || 2);
    expect(options!.concurrency).toBeGreaterThan(0);
  });

  it('registers against the constant queue name, not a configurable one', () => {
    // The queue name must never become an env var: renaming it orphans every
    // job already enqueued under the old name.
    const processor = Reflect.getMetadata('bullmq:processor_metadata', IngestionWorker) as { name?: string };
    expect(processor.name).toBe(INGESTION_QUEUE);
  });
});
