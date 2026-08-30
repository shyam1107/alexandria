import { Module } from '@nestjs/common';
import { IngestionCoreModule } from './ingestion-core.module';
import { DocumentController } from './document.controller';
import { UploadRateLimitGuard } from './upload-rate-limit.guard';
import { AuthModule } from '../auth/auth.module';

@Module({ imports: [IngestionCoreModule, AuthModule], controllers: [DocumentController], providers: [UploadRateLimitGuard] })
export class IngestionApiModule {}