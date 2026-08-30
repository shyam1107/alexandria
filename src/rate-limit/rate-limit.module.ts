import { Global, Module } from '@nestjs/common';
import { RateLimiterService } from './rate-limiter.service';

/**
 * Global for the same reason Redis is: guards in any module (auth, chat,
 * retrieval, ingestion) enforce limits without re-importing wiring.
 *
 * Deliberately NOT @nestjs/throttler: its default storage is in-process —
 * behind two instances every limit silently doubles and a restart resets
 * everyone — and its model is request-count, which cannot express a
 * concurrent-stream cap. The limiter is ~40 lines of atomic Lua over the
 * Redis that is already in the stack; the units stay exact and the logic
 * stays visible, the same instinct that keeps retrieval SQL unhidden.
 */
@Global()
@Module({
  providers: [RateLimiterService],
  exports: [RateLimiterService],
})
export class RateLimitModule {}