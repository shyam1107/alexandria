import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  // bufferLogs: hold early logs until pino replaces the default logger,
  // so even bootstrap output is structured.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = app.get(ConfigService<Env, true>);

  // Graceful shutdown: lets DatabaseModule/RedisModule close connections
  // on SIGTERM (what ECS/K8s send before killing the container).
  app.enableShutdownHooks();

  app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip properties not in the DTO
      forbidNonWhitelisted: true, // ...and reject the request if extras were sent
      transform: true, // coerce payloads into DTO class instances
    }),
  );

  const openApiConfig = new DocumentBuilder()
    .setTitle('Alexandria')
    .setDescription('Multi-tenant knowledge-base RAG API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, openApiConfig), {
    jsonDocumentUrl: 'docs/openapi.json',
  });

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  logger.log(`API listening on :${port} — Swagger at /docs`, 'Bootstrap');
}

void bootstrap();
