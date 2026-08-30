import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { Db } from '../database/database.module';
import { DRIZZLE } from '../database/database.module';
import { withWorkspace } from '../database/tenant';
import { conversations, messages } from '../database/schema';

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

export interface InsertMessage {
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  clientMessageId?: string;
  citations?: unknown;
  unresolvedCitations?: number;
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
  provider?: string;
  promptVersion?: string;
  partial?: boolean;
  finishReason?: string;
}

/**
 * Every method is its own short transaction ON PURPOSE. A chat request lives
 * for 10–30 seconds; holding one withWorkspace() transaction across the
 * generation would pin a pool connection for the whole stream and block
 * vacuum on the chunk tables. The consequence is named, not hidden: there is
 * no atomicity between the user turn and its answer, so a conversation whose
 * last message is a user turn is a VALID state (an unanswered question), and
 * retries are made safe by clientMessageId instead.
 */
@Injectable()
export class ConversationRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  getConversation(workspaceId: string, conversationId: string): Promise<ConversationRow | undefined> {
    return withWorkspace(this.db, workspaceId, async (tx) => {
      const [row] = await tx.select().from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.workspaceId, workspaceId)));
      return row;
    });
  }

  createConversation(workspaceId: string, userId: string, title: string): Promise<ConversationRow> {
    return withWorkspace(this.db, workspaceId, async (tx) => {
      const [row] = await tx.insert(conversations).values({ workspaceId, createdBy: userId, title }).returning();
      return row;
    });
  }

  /**
   * The last `limit` messages, oldest first — the order the prompt wants.
   *
   * `beforeSeq` excludes a turn that is already persisted but is about to be
   * asked again: on the crash-recovery path the current question is already
   * row `prior.seq`, and without this it would appear both as history and as
   * the question being asked, giving the model the same text twice and making
   * the rewriter treat a first turn as a follow-up on itself.
   */
  async history(workspaceId: string, conversationId: string, limit: number, beforeSeq?: number): Promise<MessageRow[]> {
    return withWorkspace(this.db, workspaceId, async (tx) => {
      const rows = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.workspaceId, workspaceId),
            ...(beforeSeq === undefined ? [] : [lt(messages.seq, beforeSeq)]),
          ),
        )
        .orderBy(desc(messages.seq))
        .limit(limit);
      return rows.reverse();
    });
  }

  async insertMessage(workspaceId: string, input: InsertMessage): Promise<MessageRow> {
    return withWorkspace(this.db, workspaceId, async (tx) => {
      // Allocating seq is a read-modify-write against a UNIQUE index, so it
      // needs the conversation row locked first. Without it two concurrent
      // turns (two tabs, or a retry racing the original) both read the same
      // max at READ COMMITTED and the loser dies on
      // messages_conversation_seq_idx — after its tokens were already paid
      // for. The same lesson as the Phase 3.5 refresh-token rotation race:
      // SELECT-then-write is not atomic just because it is in a transaction.
      // The lock is nearly free: the updatedAt write below takes it anyway.
      await tx.execute(sql`select 1 from conversations where id = ${input.conversationId} for update`);
      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(${messages.seq}), 0) + 1` })
        .from(messages)
        .where(eq(messages.conversationId, input.conversationId));
      const [row] = await tx
        .insert(messages)
        .values({ ...input, workspaceId, seq: next })
        .returning();
      await tx.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, input.conversationId));
      return row;
    });
  }

  findUserMessageByClientId(workspaceId: string, conversationId: string, clientMessageId: string): Promise<MessageRow | undefined> {
    return withWorkspace(this.db, workspaceId, async (tx) => {
      const [row] = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.clientMessageId, clientMessageId), eq(messages.role, 'user')));
      return row;
    });
  }

  /**
   * The COMPLETED answer to a given user turn, if generation ever finished.
   *
   * `partial = false` is load-bearing: the failure path persists a truncated
   * assistant row, so without this filter the one scenario clientMessageId
   * exists for — generation died mid-answer, client retries — would find that
   * stub and replay it as a finished answer, forever. A retry could never
   * succeed.
   */
  async completedAnswerAfter(workspaceId: string, conversationId: string, seq: number): Promise<MessageRow | undefined> {
    return withWorkspace(this.db, workspaceId, async (tx) => {
      const [row] = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'assistant'), eq(messages.partial, false), gt(messages.seq, seq)))
        .orderBy(messages.seq)
        .limit(1);
      return row;
    });
  }

  /**
   * Clears the failed attempt before regenerating a retried turn. Leaving it
   * would put a truncated answer into the very history the retry is about to
   * be prompted with, and leave the conversation showing two assistant turns
   * for one question.
   */
  async deletePartialAnswersAfter(workspaceId: string, conversationId: string, seq: number): Promise<void> {
    await withWorkspace(this.db, workspaceId, async (tx) => {
      await tx
        .delete(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'assistant'), eq(messages.partial, true), gt(messages.seq, seq)));
    });
  }
}
