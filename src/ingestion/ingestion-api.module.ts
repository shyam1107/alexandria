import { Module } from '@nestjs/common';
import { IngestionCoreModule } from './ingestion-core.module';
import { DocumentController } from './document.controller';
import { AuthModule } from '../auth/auth.module';

@Module({ imports: [IngestionCoreModule, AuthModule], controllers: [DocumentController] })
export class IngestionApiModule {}