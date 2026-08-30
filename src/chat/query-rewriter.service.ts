import { Inject, Injectable } from '@nestjs/common';
import { LLM_PROVIDER } from '../llm/llm.constants';
import type { LlmProvider } from '../llm/llm.types';
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
 */
@Injectable()
export class QueryRewriterService {
  constructor(@Inject(LLM_PROVIDER) private readonly llm: LlmProvider) {}

  async rewrite(question: string, history: Array<{ role: string; content: string }>, signal?: AbortSignal): Promise<RewrittenQuery> {
    if (history.length === 0) return { query: question, rewritten: false };
    try {
      let text = '';
      for await (const event of this.llm.stream({
        messages: [
          { role: 'system', content: REWRITE_SYSTEM_PROMPT },
          { role: 'user', content: buildRewriteUserMessage(history, question) },
        ],
        maxTokens: 128,
        temperature: 0,
        signal,
      })) {
        if (event.type === 'delta') text += event.text;
      }
      const candidate = text.trim();
      if (!candidate || candidate.length > question.length * 5) return { query: question, rewritten: false };
      return { query: candidate, rewritten: true };
    } catch {
      return { query: question, rewritten: false };
    }
  }
}
