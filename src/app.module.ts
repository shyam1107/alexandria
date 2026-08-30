import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env.schema';
import type { Env } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { RedisModule } from './redis/redis.module';
import { MetricsModule } from './metrics/metrics.module';
import { MetricsInterceptor } from './metrics/metrics.interceptor';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { IngestionApiModule } from './ingestion/ingestion-api.module';
import { RetrievalModule } from './retrieval/retrieval.module';
import { LlmModule } from './llm/llm.module';
import { ChatModule } from './chat/chat.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          // Pretty-print locally; ship raw JSON in production (machine-parseable).
          transport:
            config.get('NODE_ENV', { infer: true }) === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          // Never log credentials, even accidentally.
          redact: ['req.headers.authorization', 'req.headers.cookie'],
        },
      }),
    }),
    DatabaseModule,
    RedisModule,
    RateLimitModule,
    MetricsModule,
    HealthModule,
    IngestionApiModule,
    RetrievalModule,
    LlmModule,
    ChatModule,
    AuthModule,
  ],
  providers: [
    // The metrics interceptor wraps the whole handler chain — guards
    // included — so 429s/402s/401s from guards are counted with their real
    // status class. Registered here (not per-controller) because it is
    // cross-cutting infrastructure, not business logic.
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
})
export class AppModule {}
