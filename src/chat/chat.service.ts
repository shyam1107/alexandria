import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { LLM_PROVIDER } from '../llm/llm.constants';
import { LlmProviderError, LlmTimeoutError, PromptBlockedError } from '../llm/llm.errors';
import type { LlmEvent, LlmProvider, Message } from '../llm/llm.types';
import { UsageLedger } from '../llm/usage-ledger';
import { RetrievalService } from '../retrieval/retrieval.service';
import { assembleContext, trimHistory } from './context-assembler';
import { extractCitations } from './citations';
import { ConversationRepository } from './conversation.repository';
import { QueryRewriterService } from './query-rewriter.service';
import { ANSWER_SYSTEM_PROMPT, BLOCKED_REFUSAL, NO_CONTEXT_REFUSAL, PROMPT_VERSION, buildAnswerUserMessage } from './prompt';
import type { ChatDto } from './dto/chat.dto';
import type { ContextSource } from './context-assembler';

/** How many retrieval candidates go into context assembly. */
const RETRIEVAL_TOP_K = 8;

/**
 * Slack left in the window for what countTokens cannot see: chat-template
 * scaffolding the server wraps every message in, role markers, and the drift
 * of a chars/4 heuristic against a real tokenizer. Overflow is silent
 * front-truncation, so the margin errs large.
 */
const PROMPT_MARGIN_TOKENS = 256;

/**
 * The frame sink the controller implements over a raw SSE response. The
 * service owns the event GRAMMAR; the controller owns bytes on the wire.
 *
 * Grammar: every stream is
 *   sources → delta* → usage → done
 * or terminates in a single `error` frame. Retrieval failures happen before
 * the first frame and surface as a real HTTP error; once `sources` has been
 * written the status is 200 and mid-stream failures can only ever be frames.
 */
export interface ChatSink {
  event(name: 'sources' | 'delta' | 'usage' | 'done' | 'error', data: unknown): void;
}

@Injectable()
export class ChatService {
  private readonly historyLimit: number;
  private readonly historyBudget: number;
  private readonly contextBudget: number;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(
    private readonly repo: ConversationRepository,
    private readonly retrieval: RetrievalService,
    private readonly rewriter: QueryRewriterService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly ledger: UsageLedger,
    config: ConfigService<Env, true>,
  ) {
    this.historyLimit = config.get('CHAT_HISTORY_MESSAGES', { infer: true });
    this.historyBudget = config.get('CHAT_HISTORY_TOKEN_BUDGET', { infer: true });
    this.contextBudget = config.get('CHAT_CONTEXT_TOKEN_BUDGET', { infer: true });
    this.maxTokens = config.get('GENERATION_MAX_TOKENS', { infer: true });
    this.temperature = config.get('GENERATION_TEMPERATURE', { infer: true });
  }

  async streamChat(workspaceId: string, userId: string, dto: ChatDto, sink: ChatSink, signal: AbortSignal): Promise<void> {
    // 1. Resolve the conversation — explicit and tenant-checked, or new.
    let conversationId = dto.conversationId;
    if (conversationId) {
      const conversation = await this.repo.getConversation(workspaceId, conversationId);
      if (!conversation) throw new NotFoundException('Conversation not found');
    } else {
      const conversation = await this.repo.createConversation(workspaceId, userId, dto.message.slice(0, 80));
      conversationId = conversation.id;
    }

    // 2. Idempotent replay: the client retried a turn we already answered.
    //    The stored citations jsonb IS the sources map as served, so the
    //    replay is byte-identical in shape to a live stream.
    let userTurnPersisted = false;
    let priorSeq: number | undefined;
    if (dto.clientMessageId) {
      const prior = await this.repo.findUserMessageByClientId(workspaceId, conversationId, dto.clientMessageId);
      if (prior) {
        const answer = await this.repo.completedAnswerAfter(workspaceId, conversationId, prior.seq);
        if (answer) {
          sink.event('sources', { conversationId, sources: (answer.citations as ContextSource[] | null) ?? [] });
          sink.event('delta', { text: answer.content });
          sink.event('usage', { promptTokens: answer.promptTokens ?? 0, completionTokens: answer.completionTokens ?? 0 });
          sink.event('done', {
            conversationId,
            finishReason: answer.finishReason ?? 'stop',
            model: answer.model,
            unresolvedCitations: [],
          });
          return;
        }
        // Only a failed attempt (or nothing) exists for this turn. Drop the
        // truncated stub so it cannot poison the history we are about to
        // prompt with, reuse the question, and generate now.
        await this.repo.deletePartialAnswersAfter(workspaceId, conversationId, prior.seq);
        userTurnPersisted = true;
        priorSeq = prior.seq;
      }
    }

    // 3. History is read BEFORE inserting the new user turn — the question
    //    must not appear in its own context. On the retry path that turn is
    //    already persisted, so it is excluded by seq instead.
    const historyRows = await this.repo.history(workspaceId, conversationId, this.historyLimit, priorSeq);
    // A message COUNT is not a size bound. Cap by tokens too, oldest first.
    const history = trimHistory(historyRows, this.historyBudget, (text) => this.llm.countTokens(text));
    if (!userTurnPersisted) {
      await this.repo.insertMessage(workspaceId, {
        conversationId,
        role: 'user',
        content: dto.message,
        clientMessageId: dto.clientMessageId,
      });
    }

    // 4. Rewrite only pays for itself on follow-ups; first turns skip it.
    const { query, rewritten } = await this.rewriter.rewrite(dto.message, history, workspaceId, signal);

    // 5. Retrieval — its own transaction, committed before generation starts.
    const search = await this.retrieval.search(workspaceId, { query, topK: RETRIEVAL_TOP_K, debug: dto.debug });

    // 6. Zero hits → deterministic refusal, no LLM call. A model told to
    //    refuse on an empty context will eventually hallucinate; a string
    //    literal never does.
    if (search.results.length === 0) {
      await this.refuse(workspaceId, conversationId, sink);
      return;
    }

    // 7. Assemble context under a budget derived from the WHOLE prompt, not
    //    a standalone constant. Everything else in the window is already
    //    known here — system prompt, the trimmed history, the question, and
    //    the output we reserve — so context gets what is genuinely left, or
    //    the configured ceiling, whichever is smaller. Getting this wrong is
    //    not an error anywhere: the model server truncates the FRONT of the
    //    prompt and the system prompt disappears without a word.
    const fixedTokens =
      this.llm.countTokens(ANSWER_SYSTEM_PROMPT) +
      history.reduce((sum, m) => sum + this.llm.countTokens(m.content), 0) +
      this.llm.countTokens(buildAnswerUserMessage('', dto.message)) +
      this.maxTokens +
      PROMPT_MARGIN_TOKENS;
    const budget = Math.min(this.contextBudget, this.llm.contextWindow - fixedTokens);
    const context = assembleContext(search.results, budget, (text) => this.llm.countTokens(text));

    // 7b. Nothing survived the budget — the same situation as zero hits, and
    //     it takes the same deterministic refusal. Asking a model to answer
    //     from an empty <context> block is how "I don't know" turns into
    //     invention.
    if (context.sources.length === 0) {
      await this.refuse(workspaceId, conversationId, sink);
      return;
    }

    // 8. Sources FIRST: retrieval is complete before generation begins, so
    //    the client renders citation chips immediately and a disconnect
    //    still leaves attribution behind.
    sink.event('sources', {
      conversationId,
      sources: context.sources,
      ...(dto.debug
        ? {
            rewrittenQuery: rewritten ? query : null,
            retrieval: search.debug,
            // "Why did it only cite two chunks?" is a budget question far
            // more often than a retrieval one, and a budget squeezed to
            // nothing by a small num_ctx presents as a blanket refusal.
            budget: { contextWindow: this.llm.contextWindow, fixedTokens, contextBudget: budget, contextTokens: context.tokens },
          }
        : {}),
    });

    // 9. Stream.
    const prompt: Message[] = [
      { role: 'system', content: ANSWER_SYSTEM_PROMPT },
      ...history.map((m) => ({ role: m.role, content: m.content }) as Message),
      { role: 'user', content: buildAnswerUserMessage(context.promptText, dto.message) },
    ];
    let answer = '';
    let doneEvent: Extract<LlmEvent, { type: 'done' }> | null = null;
    let streamError: unknown = null;
    try {
      for await (const event of this.llm.stream({
        messages: prompt,
        maxTokens: this.maxTokens,
        // Pinned, not inherited: Ollama defaults to 0.8, and a grounded
        // cite-your-sources answer is not a creative task.
        temperature: this.temperature,
        purpose: 'answer',
        signal,
      })) {
        if (event.type === 'delta') {
          answer += event.text;
          sink.event('delta', { text: event.text });
        } else {
          doneEvent = event;
        }
      }
    } catch (error) {
      // Abort (client gone) and provider failure land here alike; the sink
      // guards its own writes, so emitting is safe either way — but a
      // disconnected client must not get an error frame it can't read. A
      // safety block gets its own deterministic refusal below, not the
      // generic failure frame.
      streamError = error;
      if (!signal.aborted && !(error instanceof PromptBlockedError)) {
        sink.event('error', { conversationId, message: 'Generation failed mid-stream' });
      }
    }

    // A pre-generation safety block is NOT a failure and NOT an empty
    // answer: it is a deterministic refusal with its own literal, because
    // "the corpus doesn't say" and "the provider refused the prompt" must
    // never read the same to a user. Emitting the full grammar keeps the
    // client free of special cases; persisting an empty assistant turn would
    // poison history.
    if (streamError instanceof PromptBlockedError) {
      sink.event('delta', { text: BLOCKED_REFUSAL });
      sink.event('usage', { promptTokens: 0, completionTokens: 0 });
      sink.event('done', { conversationId, finishReason: 'content_filter', model: streamError.model ?? null, unresolvedCitations: [] });
      const row = await this.repo.insertMessage(workspaceId, {
        conversationId,
        role: 'assistant',
        content: BLOCKED_REFUSAL,
        provider: streamError.provider,
        model: streamError.model,
        promptVersion: PROMPT_VERSION,
        finishReason: 'content_filter',
      });
      await this.ledger.record(workspaceId, {
        operation: 'chat_answer',
        provider: streamError.provider,
        model: streamError.model,
        success: false,
        errorKind: 'prompt_blocked',
        messageId: row.id,
      });
      return;
    }

    if (streamError || !doneEvent) {
      // Partial answers are still context: history that silently drops them
      // makes the next follow-up confusing. Flagged, never hidden.
      //
      // Attribution comes from the ERROR, never from the injected composite:
      // with a fallback chain, this.llm.name is the chain's name. Both
      // provider errors and our own deadlines know which member they were
      // talking to; only a provider error knows the model. A timeout row
      // with provider NULL would drop attribution for exactly the failure
      // class most worth attributing ("which vendor is timing out on us?").
      // A client disconnect genuinely knows neither, and says so.
      const failedProvider =
        streamError instanceof LlmProviderError || streamError instanceof LlmTimeoutError ? streamError.provider : undefined;
      const failedModel = streamError instanceof LlmProviderError ? streamError.model : undefined;
      const row = await this.repo.insertMessage(workspaceId, {
        conversationId,
        role: 'assistant',
        content: answer,
        partial: true,
        finishReason: 'error',
        provider: failedProvider,
        promptVersion: PROMPT_VERSION,
      });
      await this.ledger.record(workspaceId, {
        operation: 'chat_answer',
        provider: failedProvider,
        model: failedModel,
        success: false,
        errorKind: signal.aborted ? 'client_disconnect' : streamError instanceof LlmTimeoutError ? 'timeout' : 'provider_error',
        messageId: row.id,
      });
      return;
    }

    // 10. Validate citations post-hoc (they're already on the wire — stripping
    //     was never an option), then terminate the stream: usage, then done.
    const { resolved, unresolved } = extractCitations(answer, context.sources.length);
    const citations = resolved.map((n) => context.sources[n - 1]);
    sink.event('usage', doneEvent.usage);
    sink.event('done', {
      conversationId,
      finishReason: doneEvent.finishReason,
      model: doneEvent.model,
      unresolvedCitations: unresolved,
    });

    // 11. Persist — its own transaction, after the stream has terminated.
    //     provider comes from the DONE event, never from the injected
    //     composite: with a fallback chain, this.llm.name is the chain's
    //     name and the ledger becomes a lie the moment a fallback fires.
    const row = await this.repo.insertMessage(workspaceId, {
      conversationId,
      role: 'assistant',
      content: answer,
      citations,
      unresolvedCitations: unresolved.length,
      promptTokens: doneEvent.usage.promptTokens,
      completionTokens: doneEvent.usage.completionTokens,
      model: doneEvent.model,
      provider: doneEvent.provider,
      promptVersion: PROMPT_VERSION,
      finishReason: doneEvent.finishReason,
    });
    await this.ledger.record(workspaceId, {
      operation: 'chat_answer',
      provider: doneEvent.provider,
      model: doneEvent.model,
      promptTokens: doneEvent.usage.promptTokens,
      completionTokens: doneEvent.usage.completionTokens,
      success: true,
      messageId: row.id,
    });
  }

  /**
   * The zero-context answer, in both senses: nothing was retrieved, or
   * nothing survived the token budget. Deterministic on purpose — a model
   * asked to refuse against an empty context eventually invents instead, and
   * a string literal never does. Emits the full grammar so the client sees no
   * special case.
   */
  private async refuse(workspaceId: string, conversationId: string, sink: ChatSink): Promise<void> {
    sink.event('sources', { conversationId, sources: [] });
    sink.event('delta', { text: NO_CONTEXT_REFUSAL });
    sink.event('usage', { promptTokens: 0, completionTokens: 0 });
    sink.event('done', { conversationId, finishReason: 'stop', model: null, unresolvedCitations: [] });
    await this.repo.insertMessage(workspaceId, {
      conversationId,
      role: 'assistant',
      content: NO_CONTEXT_REFUSAL,
      provider: 'none',
      promptVersion: PROMPT_VERSION,
      finishReason: 'stop',
    });
  }
}
