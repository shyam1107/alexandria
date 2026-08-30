import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, WorkspaceMemberGuard } from '../auth/auth.guards';
import { SearchRateLimitGuard } from './search-rate-limit.guard';
import type { RequestWithAuth } from '../auth/auth.types';
import { RetrievalService } from './retrieval.service';
import { SearchDto } from './dto/search.dto';

@Controller('search')
@UseGuards(AccessTokenGuard, WorkspaceMemberGuard, SearchRateLimitGuard)
export class RetrievalController {
  constructor(private readonly retrieval: RetrievalService) {}

  @Post()
  search(@Req() request: RequestWithAuth, @Body() body: SearchDto) {
    return this.retrieval.search(request.workspaceId!, body);
  }
}
