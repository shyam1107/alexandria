import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Phase 7 trace context. A request-scoped id carried on AsyncLocalStorage
 * so deep call paths (service → repository → queue) can read it without a
 * parameter threaded through every signature — the same reason RLS's
 * workspace GUC rides a transaction, not a function argument.
 *
 * The id's job is CORRELATION, not distributed tracing: it ties a log line
 * in the API to a job payload in the worker across the BullMQ boundary.
 * Full OpenTelemetry spans are Phase 9 (deployment) territory; the piece
 * that must exist now — context that survives the process boundary by
 * riding the job payload — is exactly what this plus the payload field
 * provide.
 */
@Injectable()
export class TraceContextService {
  private readonly storage = new AsyncLocalStorage<{ traceId: string }>();

  /** Runs `fn` with a fresh trace id (or the incoming x-request-id, so a
   *  caller's own trace survives into this process). */
  run<T>(incomingRequestId: string | undefined, fn: () => T): T {
    return this.storage.run({ traceId: incomingRequestId ?? randomUUID() }, fn);
  }

  /** The current trace id, or undefined outside a traced request. */
  currentTraceId(): string | undefined {
    return this.storage.getStore()?.traceId;
  }
}