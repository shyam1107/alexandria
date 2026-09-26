import { Module } from '@nestjs/common';
import { DemoUiController } from './demo-ui.controller';

/** Serves the local demo client. No providers: it reads two files. */
@Module({ controllers: [DemoUiController] })
export class DemoUiModule {}
