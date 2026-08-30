import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { ConfigService } from '@nestjs/config';
import * as schema from '../src/database/schema';
import type { Env } from '../src/config/env.schema';
import type { Db } from '../src/database/database.module';
import { RetrievalService } from '../src/retrieval/retrieval.service';
import type { EmbeddingService } from '../src/ingestion/embedding.service';
import { ScriptedProvider } from '../src/llm/scripted.provider';
import type { Message } from '../src/llm/llm.types';
import { ChatService, type ChatSink } from '../src/chat/chat.service';
import { ConversationRepository } from '../src/chat/conversation.repository';
import { QueryRewriterService } from '../src/chat/query-rewriter.service';
import { UsageLedger } from '../src/llm/usage-ledger';
import { LlmTimeoutError, PromptBlockedError } from '../src/llm/llm.errors';
import type { LlmEvent } from '../src/llm/llm.types';
import { BLOCKED_REFUSAL, NO_CONTEXT_REFUSAL, PROMPT_VERSION } from '../src/chat/prompt';

/**
 * The chat pipeline end to end, with no model running anywhere: generation
 * is scripted (deterministic tokens), embeddings are one-hot vectors
 * (deterministic ranking), and Postgres is real — as the runtime role, so
 * RLS is active. What is being tested is the ORCHESTRATION: the SSE event
 * grammar, citation validation, idempotent replay, partial persistence, and
 * tenant scoping. Whether a real model obeys the prompt is Phase 8's
 * question, not this suite's.
 */

const DIMENSIONS = 768;
const basis = (dim: number) => {
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[dim] = 1;
  return `[${v.join(',')}]`;
};
const stubEmbeddings = {
  embed: async (text: string) => (text.includes('shipping') ? basis(1) : basis(0)).slice(1, -1).split(',').map(Number),
  modelName: 'test-embedding-model',
} as unknown as EmbeddingService;

const settings = {
  CHAT_HISTORY_MESSAGES: 10,
  CHAT_HISTORY_TOKEN_BUDGET: 1500,
  CHAT_CONTEXT_TOKEN_BUDGET: 3000,
  GENERATION_MAX_TOKENS: 1024,
  GENERATION_TEMPERATURE: 0.2,
} as Partial<Env>;
const config = { get: (key: keyof Env) => settings[key] } as unknown as ConfigService<Env, true>;

interface Frame { event: string; data: Record<string, unknown> }

class CollectingSink implements ChatSink {
  frames: Frame[] = [];
  onDelta?: () => void;
  event(event: string, data: unknown): void {
    this.frames.push({ event, data: data as Record<string, unknown> });
    if (event === 'delta') this.onDelta?.();
  }
  events(): string[] { return this.frames.map((f) => f.event); }
  text(): string { return this.frames.filter((f) => f.event === 'delta').map((f) => (f.data as { text: string }).text).join(''); }
  last(name: string): Frame { return [...this.frames].reverse().find((f) => f.event === name)!; }
}

const ANSWER_CHUNKS = ['You ', 'can ', 'refund ', 'within ', '30 ', 'days ', '[1].'];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rewrite calls get the rewrite system prompt; answer calls get the answer one. */
function makeProvider(script: string[] = ANSWER_CHUNKS, onCall?: (system: string) => void) {
  return new ScriptedProvider((messages) => {
    const system = messages[0]?.content ?? '';
    onCall?.(system);
    return system.startsWith('Rewrite the user') ? ['What is the refund window?'] : script;
  });
}

describe('chat (integration)', () => {
  let owner: Client;
  let pool: Pool;
  let db: Db;
  let workspaceA: string;
  let workspaceEmpty: string;
  let userId: string;

  function makeChat(script?: string[], onCall?: (system: string) => void) {
    const llm = makeProvider(script, onCall);
    // The ledger is REAL here (same DB, runtime role): the pipeline's cost
    // accounting is part of what this suite proves, not an implementation
    // detail to stub away.
    const ledger = new UsageLedger(db);
    return new ChatService(new ConversationRepository(db), new RetrievalService(db, stubEmbeddings), new QueryRewriterService(llm, ledger), llm, ledger, config);
  }

  async function allMessages(conversationId: string) {
    return (await owner.query(`select * from messages where conversation_id = $1 order by seq`, [conversationId])).rows;
  }

  beforeAll(async () => {
    const ownerUrl = process.env.MIGRATION_DATABASE_URL;
    const appUrl = process.env.DATABASE_URL;
    if (!ownerUrl || !appUrl) throw new Error('DATABASE_URL and MIGRATION_DATABASE_URL must be set.');
    owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    pool = new Pool({ connectionString: appUrl, max: 2 });
    db = drizzle(pool, { schema });

    userId = (await owner.query(`insert into users (email, password_hash) values ('chat-spec@example.com', 'x') returning id`)).rows[0].id;
    workspaceA = (await owner.query(`insert into workspaces (name) values ('chat-spec-a') returning id`)).rows[0].id;
    workspaceEmpty = (await owner.query(`insert into workspaces (name) values ('chat-spec-empty') returning id`)).rows[0].id;

    const documentId = (
      await owner.query(`insert into documents (workspace_id, title, status) values ($1, 'Refund policy', 'indexed') returning id`, [workspaceA])
    ).rows[0].id;
    const versionId = (
      await owner.query(
        `insert into document_versions (document_id, workspace_id, object_key, original_filename, content_type, byte_size, status)
         values ($1, $2, 'k/refund', 'refund.txt', 'text/plain', 100, 'indexed') returning id`,
        [documentId, workspaceA],
      )
    ).rows[0].id;
    await owner.query(
      `insert into document_chunks (document_version_id, workspace_id, chunk_index, content, char_start, char_end, embedding, embedding_model)
       values ($1, $2, 0, 'Our refund policy covers returned items within thirty days', 0, 58, $3::vector, 'test-embedding-model')`,
      [versionId, workspaceA, basis(0)],
    );
  });

  afterAll(async () => {
    if (owner) {
      await owner.query(`delete from users where email = 'chat-spec@example.com'`);
      await owner.query(`delete from workspaces where name in ('chat-spec-a', 'chat-spec-empty')`);
      await owner.end();
    }
    if (pool) await pool.end();
  });

  it('streams the full grammar and persists both turns with citations and usage', async () => {
    const sink = new CollectingSink();
    await makeChat().streamChat(workspaceA, userId, { message: 'refund policy?', debug: true }, sink, new AbortController().signal);

    expect(sink.events()).toEqual(['sources', ...ANSWER_CHUNKS.map(() => 'delta'), 'usage', 'done']);
    const sources = sink.frames[0].data as { sources: Array<{ n: number }>; rewrittenQuery: string | null };
    expect(sources.sources).toHaveLength(1);
    expect(sources.rewrittenQuery).toBeNull(); // first turn: no rewrite call
    expect(sink.text()).toBe(ANSWER_CHUNKS.join(''));
    expect(sink.last('done').data).toMatchObject({ finishReason: 'stop', model: 'scripted', unresolvedCitations: [] });

    const conversationId = sink.last('done').data.conversationId as string;
    const rows = await allMessages(conversationId);
    expect(rows.map((r) => [r.seq, r.role])).toEqual([[1, 'user'], [2, 'assistant']]);
    expect(rows[1]).toMatchObject({
      content: ANSWER_CHUNKS.join(''),
      unresolved_citations: 0,
      model: 'scripted',
      provider: 'scripted',
      prompt_version: PROMPT_VERSION,
      partial: false,
      finish_reason: 'stop',
    });
    expect(rows[1].prompt_tokens).toBeGreaterThan(0);
    // The persisted citation is the RESOLVED map — chunk id + span as served.
    expect(rows[1].citations[0]).toMatchObject({ n: 1, documentTitle: 'Refund policy', charStart: 0, charEnd: 58 });

    // The ledger row: one per provider call, linked to the answer, cost an
    // exact integer in micro-USD (pg returns bigint as a string; '0' is the
    // DECLARED free price of the scripted provider, not an unknown price).
    const ledgerRows = (await owner.query(`select * from llm_usage_events where message_id = $1`, [rows[1].id])).rows;
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({ operation: 'chat_answer', provider: 'scripted', model: 'scripted', success: true, cost_micro_usd: '0' });
    expect(ledgerRows[0].prompt_tokens).toBe(rows[1].prompt_tokens);
  });

  it('rewrites follow-up queries and exposes the rewrite under debug', async () => {
    const chat = makeChat();
    // Tests share workspaceA, so count the ledger rows THIS test creates.
    const countOps = async () =>
      (await owner.query(`select operation, count(*)::int as n from llm_usage_events where workspace_id = $1 group by operation`, [workspaceA])).rows;
    const before = await countOps();
    const first = new CollectingSink();
    await chat.streamChat(workspaceA, userId, { message: 'refund policy?' }, first, new AbortController().signal);
    const conversationId = first.last('done').data.conversationId as string;

    const second = new CollectingSink();
    await chat.streamChat(workspaceA, userId, { conversationId, message: 'what is the window?', debug: true }, second, new AbortController().signal);
    const sources = second.frames[0].data as { rewrittenQuery: string | null };
    expect(sources.rewrittenQuery).toBe('What is the refund window?');

    const rows = await allMessages(conversationId);
    expect(rows.map((r) => [r.seq, r.role])).toEqual([[1, 'user'], [2, 'assistant'], [3, 'user'], [4, 'assistant']]);

    // The rewrite call is LLM spend with no message row of its own — the
    // ledger is the only place it exists. Exactly one rewrite (the follow-up;
    // first turns skip it) and two answers were created by THIS test.
    const after = await countOps();
    const delta = (op: string) =>
      (after.find((r) => r.operation === op)?.n ?? 0) - (before.find((r) => r.operation === op)?.n ?? 0);
    expect(delta('query_rewrite')).toBe(1);
    expect(delta('chat_answer')).toBe(2);
  });

  it('flags out-of-range citations instead of stripping them', async () => {
    const sink = new CollectingSink();
    await makeChat(['Grounded [1] and invented [9].']).streamChat(workspaceA, userId, { message: 'refund policy?' }, sink, new AbortController().signal);

    // The marker was already streamed when detected — the terminal frame
    // reports it unresolved so the client renders plain text, not a dead chip.
    expect(sink.last('done').data.unresolvedCitations).toEqual([9]);
    const conversationId = sink.last('done').data.conversationId as string;
    const rows = await allMessages(conversationId);
    expect(rows[1].unresolved_citations).toBe(1);
    expect(rows[1].citations).toHaveLength(1);
  });

  it('refuses deterministically on zero retrieval hits, with no LLM call', async () => {
    let llmCalls = 0;
    const sink = new CollectingSink();
    await makeChat(ANSWER_CHUNKS, () => llmCalls++).streamChat(workspaceEmpty, userId, { message: 'anything at all' }, sink, new AbortController().signal);

    expect(llmCalls).toBe(0);
    expect(sink.events()).toEqual(['sources', 'delta', 'usage', 'done']);
    expect(sink.text()).toBe(NO_CONTEXT_REFUSAL);
    expect((sink.frames[0].data as { sources: unknown[] }).sources).toEqual([]);
  });

  it('cannot continue another workspace’s conversation', async () => {
    const sink = new CollectingSink();
    await makeChat().streamChat(workspaceA, userId, { message: 'refund policy?' }, sink, new AbortController().signal);
    const conversationId = sink.last('done').data.conversationId as string;

    await expect(
      makeChat().streamChat(workspaceEmpty, userId, { conversationId, message: 'hello' }, new CollectingSink(), new AbortController().signal),
    ).rejects.toThrow(/not found/i);
  });

  it('replays a stored answer for a retried clientMessageId instead of regenerating', async () => {
    let answerCalls = 0;
    const chat = makeChat(ANSWER_CHUNKS, (system) => { if (!system.startsWith('Rewrite the user')) answerCalls++; });
    const first = new CollectingSink();
    await chat.streamChat(workspaceA, userId, { message: 'refund policy?', clientMessageId: 'retry-me' }, first, new AbortController().signal);
    expect(answerCalls).toBe(1);

    const second = new CollectingSink();
    await chat.streamChat(workspaceA, userId, {
      conversationId: first.last('done').data.conversationId as string,
      message: 'refund policy?',
      clientMessageId: 'retry-me',
    }, second, new AbortController().signal);

    expect(answerCalls).toBe(1); // no second generation
    expect(second.text()).toBe(first.text());
    expect(second.events()).toEqual(['sources', 'delta', 'usage', 'done']);
    const rows = await allMessages(first.last('done').data.conversationId as string);
    expect(rows.filter((r) => r.role === 'user')).toHaveLength(1);
  });

  it('regenerates a retried turn whose only answer was a partial', async () => {
    // The exact scenario clientMessageId exists for. The failure path
    // persists a truncated assistant row, so a replay lookup that ignores
    // `partial` finds that stub and serves it as the finished answer —
    // forever. The retry could never succeed.
    const chat = makeChat();
    const abort = new AbortController();
    const first = new CollectingSink();
    first.onDelta = () => abort.abort();
    await chat.streamChat(workspaceA, userId, { message: 'refund policy?', clientMessageId: 'died-midway' }, first, abort.signal);

    const conversationId = (first.frames[0].data as { conversationId: string }).conversationId;
    expect((await allMessages(conversationId))[1]).toMatchObject({ partial: true, finish_reason: 'error' });

    const retry = new CollectingSink();
    await chat.streamChat(
      workspaceA,
      userId,
      { conversationId, message: 'refund policy?', clientMessageId: 'died-midway' },
      retry,
      new AbortController().signal,
    );

    expect(retry.text()).toBe(ANSWER_CHUNKS.join(''));
    expect(retry.events()).toContain('done');
    const rows = await allMessages(conversationId);
    // One question, one finished answer: the failed stub is cleared rather
    // than left to poison the history the retry is prompted with, and its seq
    // is reused so the conversation has no gap.
    expect(rows.map((r) => [r.seq, r.role, r.partial])).toEqual([[1, 'user', false], [2, 'assistant', false]]);
  });

  it('does not put the retried question into its own history', async () => {
    const prompts: Message[][] = [];
    const llm = new ScriptedProvider((messages) => {
      prompts.push(messages);
      return messages[0].content.startsWith('Rewrite the user') ? ['rewritten'] : ANSWER_CHUNKS;
    });
    const ledger = new UsageLedger(db);
    const chat = new ChatService(new ConversationRepository(db), new RetrievalService(db, stubEmbeddings), new QueryRewriterService(llm, ledger), llm, ledger, config);

    const abort = new AbortController();
    const first = new CollectingSink();
    first.onDelta = () => abort.abort();
    await chat.streamChat(workspaceA, userId, { message: 'refund policy?', clientMessageId: 'no-echo' }, first, abort.signal);
    const conversationId = (first.frames[0].data as { conversationId: string }).conversationId;

    await chat.streamChat(
      workspaceA,
      userId,
      { conversationId, message: 'refund policy?', clientMessageId: 'no-echo' },
      new CollectingSink(),
      new AbortController().signal,
    );

    // On the retry the question is ALREADY row 1, so a naive history read
    // hands the model the same text as both context and question, and makes
    // the rewriter condense a first turn against itself.
    const answerPrompt = prompts.filter((p) => !p[0].content.startsWith('Rewrite the user')).pop()!;
    expect(answerPrompt.filter((m) => m.content.includes('refund policy?'))).toHaveLength(1);
    expect(prompts.some((p) => p[0].content.startsWith('Rewrite the user'))).toBe(false);
  });

  it('serialises seq allocation when two turns race', async () => {
    // Allocating seq is SELECT max(seq)+1 then INSERT against a UNIQUE index
    // — the Phase 3.5 refresh-token shape. Unlocked, both racers read the
    // same max at READ COMMITTED and the loser dies on
    // messages_conversation_seq_idx, mid-stream, after paying for its tokens.
    //
    // Two concurrent calls do not reliably interleave on their own, so the
    // race is staged: a third connection holds the conversation row, both
    // inserts pile up behind it, and releasing it wakes them together. Without
    // the FOR UPDATE in insertMessage this fails with a duplicate key on
    // messages_conversation_seq_idx.
    const repo = new ConversationRepository(db);
    const conversation = await repo.createConversation(workspaceA, userId, 'seq race');

    await owner.query('begin');
    await owner.query('select 1 from conversations where id = $1 for update', [conversation.id]);

    const inserts = Promise.all([
      repo.insertMessage(workspaceA, { conversationId: conversation.id, role: 'user', content: 'first' }),
      repo.insertMessage(workspaceA, { conversationId: conversation.id, role: 'user', content: 'second' }),
    ]);
    await delay(250); // both are now queued behind the held row
    await owner.query('commit');

    const [a, b] = await inserts;
    expect(new Set([a.seq, b.seq])).toEqual(new Set([1, 2]));
  });

  it('persists the partial answer when the client disconnects mid-stream', async () => {
    const abort = new AbortController();
    const sink = new CollectingSink();
    sink.onDelta = () => abort.abort(); // client leaves after the first token
    await makeChat().streamChat(workspaceA, userId, { message: 'refund policy?' }, sink, abort.signal);

    // No done frame exists — the client is gone — but history is not left
    // with a dangling unanswered question.
    expect(sink.events()).not.toContain('done');
    const rows = await allMessages((sink.frames[0].data as { conversationId: string }).conversationId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ role: 'assistant', content: ANSWER_CHUNKS[0], partial: true, finish_reason: 'error' });
  });

  it('attributes a mid-stream timeout to the provider that stalled, not to NULL', async () => {
    // A deadline fired by the resilient wrapper knows which chain member it
    // was talking to. Recording provider NULL would drop attribution for
    // exactly the failure class most worth attributing — "which vendor is
    // timing out on us?" is unanswerable from a table of NULLs.
    class StallsProvider extends ScriptedProvider {
      override async *stream(): AsyncIterable<LlmEvent> {
        yield { type: 'delta', text: 'half an ans' };
        throw new LlmTimeoutError('idle', 'ollama');
      }
    }
    const llm = new StallsProvider([]);
    const ledger = new UsageLedger(db);
    const chat = new ChatService(new ConversationRepository(db), new RetrievalService(db, stubEmbeddings), new QueryRewriterService(llm, ledger), llm, ledger, config);

    const sink = new CollectingSink();
    await chat.streamChat(workspaceA, userId, { message: 'refund policy?' }, sink, new AbortController().signal);

    const rows = await allMessages((sink.frames[0].data as { conversationId: string }).conversationId);
    expect(rows[1]).toMatchObject({ partial: true, finish_reason: 'error', provider: 'ollama' });
    const ledgerRows = (await owner.query(`select * from llm_usage_events where message_id = $1`, [rows[1].id])).rows;
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({ operation: 'chat_answer', success: false, error_kind: 'timeout', provider: 'ollama' });
    // The model stays NULL: our deadline knows the vendor, not which model
    // was loaded behind it. Honest beats complete.
    expect(ledgerRows[0].model).toBeNull();
  });

  it('answers a provider safety block with a deterministic refusal, not an error frame or an empty turn', async () => {
    // Gemini can end a stream with promptFeedback.blockReason and ZERO
    // candidates. Persisting that as an empty answer would poison history;
    // serving an error frame would conflate "provider refused" with
    // "provider broke". It is a third, deterministic refusal instead.
    class BlockedProvider extends ScriptedProvider {
      override stream(): AsyncIterable<LlmEvent> {
        return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new PromptBlockedError('PROHIBITED_CONTENT', 'scripted', 'scripted')) }) };
      }
    }
    const llm = new BlockedProvider([]);
    const ledger = new UsageLedger(db);
    const chat = new ChatService(new ConversationRepository(db), new RetrievalService(db, stubEmbeddings), new QueryRewriterService(llm, ledger), llm, ledger, config);

    const sink = new CollectingSink();
    await chat.streamChat(workspaceA, userId, { message: 'refund policy?' }, sink, new AbortController().signal);

    expect(sink.events()).toEqual(['sources', 'delta', 'usage', 'done']);
    expect(sink.text()).toBe(BLOCKED_REFUSAL);
    expect(sink.text()).not.toBe(NO_CONTEXT_REFUSAL); // "provider refused" ≠ "corpus doesn't say"
    expect(sink.last('done').data).toMatchObject({ finishReason: 'content_filter' });

    const conversationId = sink.last('done').data.conversationId as string;
    const rows = await allMessages(conversationId);
    expect(rows[1]).toMatchObject({ content: BLOCKED_REFUSAL, finish_reason: 'content_filter', partial: false, provider: 'scripted' });
    const ledgerRows = (await owner.query(`select * from llm_usage_events where message_id = $1`, [rows[1].id])).rows;
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({ operation: 'chat_answer', success: false, error_kind: 'prompt_blocked' });
  });
});
