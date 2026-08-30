import { Controller, Get, Header, Inject } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/**
 * The scrape endpoint. Not versioned, not behind the api prefix — it is
 * infrastructure surface, not product surface; Prometheus configs expect
 * a stable /metrics and a version in the path would be noise.
 */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4')
  async scrape(): Promise<string> {
    return this.metrics.render();
  }
}