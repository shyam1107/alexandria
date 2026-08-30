import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
// Chat is a CONSUMER of retrieval, not a fork of it — Phase 4's service is
// injected as-is. LlmModule is global, so LLM_PROVIDER needs no import here.
import { RetrievalModule } from '../retrieval/retrieval.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ConversationRepository } from './conversation.repository';
import { QueryRewriterService } from './query-rewriter.service';
import { ChatRateLimitGuard } from './chat-rate-limit.guard';
import { QuotaGuard } from './quota.guard';

@Module({
  imports: [RetrievalModule, AuthModule],
  controllers: [ChatController],
  providers: [ChatService, ConversationRepository, QueryRewriterService, ChatRateLimitGuard, QuotaGuard],
})
export class ChatModule {}
