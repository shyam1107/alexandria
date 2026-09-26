import { Controller, Get, Header, NotFoundException, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../config/env.schema';

/**
 * A local demo client, served by the API that answers it.
 *
 * Same-origin on purpose. The API has no CORS policy — deliberately, since
 * nothing needed one — and a page opened from disk would be blocked calling
 * it. Serving the page from the API sidesteps that instead of loosening a
 * production setting for a development tool.
 *
 * The routes are always REGISTERED but only respond outside production, so
 * the route-guard test can see them and assert they are deliberately public.
 * A route that exists only under one NODE_ENV is a route no test covers.
 */
@Controller({ path: 'ui', version: VERSION_NEUTRAL })
export class DemoUiController {
  private readonly enabled: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.enabled = config.get('NODE_ENV', { infer: true }) !== 'production';
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new NotFoundException();
  }

  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  page(): string {
    this.assertEnabled();
    return readFileSync(join(__dirname, 'ui.html'), 'utf8');
  }

  /**
   * Credentials and workspace id written by `pnpm demo:seed`.
   *
   * This exists because the API gives a client no way to discover its own
   * workspace: neither register nor login returns one, and there is no list
   * endpoint, yet every tenant route requires the x-workspace-id header. The
   * seeder reads it from the database and leaves it here. When that gap is
   * closed properly, this endpoint should go.
   */
  @Get('config')
  config(@Res() response: Response): void {
    this.assertEnabled();
    const path = join(process.cwd(), 'demo', 'demo-config.json');
    if (!existsSync(path)) {
      response.status(404).json({ message: 'Run `pnpm demo:seed` first — no demo workspace has been created yet.' });
      return;
    }
    response.type('application/json').send(readFileSync(path, 'utf8'));
  }
}
