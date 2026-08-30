import { Inject, Injectable } from '@nestjs/common';
import { LLM_PROVIDER } from '../llm/llm.constants';
import type { LlmProvider, TokenUsage } from '../llm/llm.types';
import { UsageLedger } from '../llm/usage-ledger';
import { REWRITE_SYSTEM_PROMPT, buildRewriteUserMessage } from './prompt';

export interface RewrittenQuery {
  query: string;
  rewritten: boolean;
}

/**
 * Turns a follow-up into a standalone search query. Without this, "what
 * about the second one?" embeds a pronoun and retrieval returns noise — the
 * generator having memory is not enough if the retriever is stateless.
 *
 * Two guardrails keep a second LLM call safe in the hot path:
 *  - Skipped entirely on the first turn (a lone question is already
 *    standalone; most turns are first turns).
 *  - Fails OPEN: an error, a timeout, or a degenerate rewrite (empty, or
 *    wildly longer than the original) falls back to the raw question. A
 *    rewriter outage degrades to single-turn behaviour, never downtime.
 *
 * Fail-open does not mean fail-silent for the ledger: rewrites are LLM
 * spend with no message row to hang off, so success and failure both write
 * a usage event (Phase 6). The ledger itself never throws.
 */
@Injectable()
export class QueryRewriterService {
  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly ledger: UsageLedger,
  ) {}

  async rewrite(question: string, history: Array<{ role: string; content: string }>, workspaceId: string, signal?: AbortSignal): Promise<RewrittenQuery> {
    if (history.length === 0) return { query: question, rewritten: false };
    try {
      let text = '';
      let usage: TokenUsage | undefined;
      let provider: string | undefined;
      let model: string | undefined;
      for await (const event of this.llm.stream({
        messages: [
          { role: 'system', content: REWRITE_SYSTEM_PROMPT },
          { role: 'user', content: buildRewriteUserMessage(history, question) },
        ],
        maxTokens: 128,
        temperature: 0,
        purpose: 'rewrite',
        signal,
      })) {
        if (event.type === 'delta') text += event.text;
        else {
          usage = event.usage;
          provider = event.provider;
          model = event.model;
        }
      }
      await this.ledger.record(workspaceId, {
        operation: 'query_rewrite',
        provider,
        model,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        success: true,
      });
      const candidate = text.trim();
      if (!candidate || candidate.length > question.length * 5) return { query: question, rewritten: false };
      return { query: candidate, rewritten: true };
    } catch {
      await this.ledger.record(workspaceId, {
        operation: 'query_rewrite',
        success: false,
        errorKind: signal?.aborted ? 'client_disconnect' : 'provider_error',
      });
      return { query: question, rewritten: false };
    }
  }
}
