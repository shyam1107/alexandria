import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { LLM_PROVIDER } from '../llm/llm.constants';
import type { LlmProvider, TokenUsage } from '../llm/llm.types';
import { UsageLedger } from '../llm/usage-ledger';
import { RewriteBudgetError } from './chat.errors';
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
 * Three guardrails keep a second LLM call safe in the hot path:
 *  - Skipped entirely on the first turn (a lone question is already
 *    standalone; most turns are first turns).
 *  - Fails OPEN: an error, a timeout, or a degenerate rewrite (empty, or
 *    wildly longer than the original) falls back to the raw question. A
 *    rewriter outage degrades to single-turn behaviour, never downtime.
 *  - BOUNDED: the rewrite is an optimization inside the chat request's
 *    pre-frame window (Phase 7), so it gets a slice of it — not the whole
 *    window the user is waiting in. A dedicated budget aborts with a REASON
 *    (the Phase 6 pattern): RewriteBudgetError keeps "the budget fired"
 *    distinguishable from "the client hung up" downstream, because the
 *    ledger must record a timeout, not a client_disconnect — an abandonment
 *    is not an outage.
 *
 * Fail-open does not mean fail-silent for the ledger: rewrites are LLM
 * spend with no message row to hang off, so success and failure both write
 * a usage event (Phase 6). The ledger itself never throws.
 */
@Injectable()
export class QueryRewriterService {
  private readonly budgetMs: number;

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly ledger: UsageLedger,
    config: ConfigService<Env, true>,
  ) {
    this.budgetMs = config.get('CHAT_REWRITE_BUDGET_MS', { infer: true });
  }

  async rewrite(question: string, history: Array<{ role: string; content: string }>, workspaceId: string, signal?: AbortSignal): Promise<RewrittenQuery> {
    if (history.length === 0) return { query: question, rewritten: false };
    // The budget abort composes with the caller's signal via AbortSignal.any:
    // whichever fires first wins, and both are reasons we can read apart.
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new RewriteBudgetError()), this.budgetMs);
    const composed = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;

    // Consumption is RACED against the budget, not merely handed the signal:
    // cooperative cancellation only works if every layer observes it, and the
    // rewriter cannot trust a provider double (or a hung vendor connection)
    // to honor the abort. The loser of the race gets a no-op catch so its
    // eventual rejection can never surface as an unhandled one.
    const budgetExpiry = new Promise<never>((_, reject) => {
      budget.signal.addEventListener('abort', () => reject(budget.signal.reason), { once: true });
    });
    const consume = async (): Promise<RewrittenQuery> => {
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
        signal: composed,
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
    };

    const consumption = consume();
    consumption.catch(() => undefined);
    try {
      return await Promise.race([consumption, budgetExpiry]);
    } catch (error) {
      // The budget firing is an abandonment of the rewrite, not a failure of
      // the client: the caller's signal is what means "client gone". Reading
      // composed.aborted here would misclassify an expired budget as a
      // client_disconnect in the ledger — the exact confusion aborting with
      // a reason exists to prevent.
      const clientLeft = signal?.aborted === true;
      const budgetFired = error instanceof RewriteBudgetError || budget.signal.aborted;
      await this.ledger.record(workspaceId, {
        operation: 'query_rewrite',
        success: false,
        errorKind: clientLeft ? 'client_disconnect' : budgetFired ? 'timeout' : 'provider_error',
      });
      return { query: question, rewritten: false };
    } finally {
      clearTimeout(timer);
    }
  }
}
