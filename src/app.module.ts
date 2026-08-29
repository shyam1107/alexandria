import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env.schema';
import type { Env } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { RedisModule } from './redis/redis.module';
import { IngestionApiModule } from './ingestion/ingestion-api.module';
import { RetrievalModule } from './retrieval/retrieval.module';
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
    HealthModule,
    IngestionApiModule,
    RetrievalModule,
    AuthModule,
  ],
})
export class AppModule {}
