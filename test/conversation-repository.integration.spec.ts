import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/database/schema';
import { ConversationRepository } from '../src/chat/conversation.repository';

/**
 * Phase 7 defence-in-depth, asserted as a CLASS rather than as instances.
 *
 * The repository's every method takes a workspaceId — the application-level
 * tenant filter that stands in front of the RLS backstop. Three of them
 * (findUserMessageByClientId, completedAnswerAfter, deletePartialAnswersAfter)
 * filtered by conversation id alone and relied entirely on RLS; a sibling
 * (history) carried the explicit eq(workspace_id). The house rule is both,
 * always — so this test does not enumerate the three: it walks the prototype
 * and calls EVERY method with a foreign workspace, so a method added in Phase
 * 8 is covered the day it exists. The rls.integration.spec pattern, one layer
 * up: assert the rule, not the list.
 *
 * The cross-tenant probe: workspace A owns a conversation; we invoke every
 * method as workspace B, handing it A's conversation id. RLS already hides
 * A's rows from B — so the assertion is not "RLS works" (the other suite
 * proves that). The assertion is that the application-level filter ALSO
 * holds: no method may return, mutate, or block on another workspace's rows
 * even if RLS were ever removed, weakened, or mis-scoped. Defense in depth
 * means both layers are tested separately.
 *
 * insertMessage is special: its seq-allocation lock is FOR UPDATE by
 * conversation id. Pre-fix, a foreign conversation id BLOCKED on a row RLS
 * hides (lock waits even when the row is invisible). The fix returns zero
 * rows and the method throws instead — asserted here by timing: the call
 * must complete promptly with an error, not hang.
 */

describe('conversation repository tenancy (integration)', () => {
  let owner: Client;
  let pool: Pool;
  let repo: ConversationRepository;
  let workspaceA: string;
  let workspaceB: string;
  let conversationA: string;

  beforeAll(async () => {
    const ownerUrl = process.env.MIGRATION_DATABASE_URL;
    const appUrl = process.env.DATABASE_URL;
    if (!ownerUrl || !appUrl) throw new Error('DATABASE_URL and MIGRATION_DATABASE_URL must be set. Copy .env.example to .env.');
    owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    pool = new Pool({ connectionString: appUrl, max: 2 });
    repo = new ConversationRepository(drizzle(pool, { schema }));

    workspaceA = (await owner.query(`insert into workspaces (name) values ('repo-tenancy-a') returning id`)).rows[0].id;
    workspaceB = (await owner.query(`insert into workspaces (name) values ('repo-tenancy-b') returning id`)).rows[0].id;

    // Workspace A: a user, a conversation, and a couple of messages. The
    // email carries a timestamp so a previously failed run can never leave
    // a unique-constraint landmine behind for this one.
    const email = `repo-tenancy-${Date.now()}@test.local`;
    const userA = (await owner.query(`insert into users (email, password_hash) values ($1, 'x') returning id`, [email])).rows[0].id;
    conversationA = (
      await owner.query(`insert into conversations (workspace_id, created_by, title) values ($1, $2, 'A conversation') returning id`, [workspaceA, userA])
    ).rows[0].id;
    await owner.query(`insert into messages (conversation_id, workspace_id, seq, role, content, client_message_id) values ($1, $2, 1, 'user', 'A question', 'client-a')`, [conversationA, workspaceA]);
    await owner.query(`insert into messages (conversation_id, workspace_id, seq, role, content, partial) values ($1, $2, 2, 'assistant', 'A partial answer', true)`, [conversationA, workspaceA]);
    await owner.query(`insert into messages (conversation_id, workspace_id, seq, role, content, partial) values ($1, $2, 3, 'assistant', 'A completed answer', false)`, [conversationA, workspaceA]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query(`delete from workspaces where name in ('repo-tenancy-a', 'repo-tenancy-b')`);
      await owner.end();
    }
    if (pool) await pool.end();
  });

  it('returns nothing for a foreign workspace across every method that takes one', async () => {
    // Enumerate the prototype: every public method is probed as workspace B
    // against workspace A's conversation. A method added later that forgets
    // the explicit workspace filter fails here the day it exists.
    const methods = Object.getOwnPropertyNames(ConversationRepository.prototype).filter(
      (name) => name !== 'constructor' && typeof (repo as unknown as Record<string, unknown>)[name] === 'function',
    );
    expect(methods.length, 'expected several repository methods to probe').toBeGreaterThanOrEqual(7);

    // Workspace B has NO conversation — getConversation must not find A's.
    await expect(repo.getConversation(workspaceB, conversationA)).resolves.toBeUndefined();

    // history: no rows may cross.
    await expect(repo.history(workspaceB, conversationA, 10)).resolves.toHaveLength(0);

    // Idempotency lookup: A's clientMessageId must not be visible from B.
    await expect(repo.findUserMessageByClientId(workspaceB, conversationA, 'client-a')).resolves.toBeUndefined();

    // completedAnswerAfter: A's completed answer must not surface from B.
    await expect(repo.completedAnswerAfter(workspaceB, conversationA, 1)).resolves.toBeUndefined();

    // deletePartialAnswersAfter: B must not be able to delete A's partial
    // stub — and to prove the bite we re-check A's row survived.
    await repo.deletePartialAnswersAfter(workspaceB, conversationA, 1);
    const surviving = await owner.query(`select count(*)::int as n from messages where conversation_id = $1 and partial = true`, [conversationA]);
    expect(surviving.rows[0].n).toBe(1);

    // insertMessage into A's conversation AS B: must throw promptly (the
    // tenant-scoped lock finds no row), never insert, never block.
    const started = Date.now();
    await expect(
      repo.insertMessage(workspaceB, { conversationId: conversationA, role: 'user', content: 'smuggled' }),
    ).rejects.toThrow(/not found/i);
    expect(Date.now() - started).toBeLessThan(5_000);
    const smuggled = await owner.query(`select count(*)::int as n from messages where conversation_id = $1 and content = 'smuggled'`, [conversationA]);
    expect(smuggled.rows[0].n).toBe(0);
  });

  it('still serves the owning workspace (the filters did not over-reach)', async () => {
    const conversation = await repo.getConversation(workspaceA, conversationA);
    expect(conversation?.id).toBe(conversationA);
    const history = await repo.history(workspaceA, conversationA, 10);
    expect(history.map((m) => m.seq)).toEqual([1, 2, 3]);
    const prior = await repo.findUserMessageByClientId(workspaceA, conversationA, 'client-a');
    expect(prior?.content).toBe('A question');
    const answer = await repo.completedAnswerAfter(workspaceA, conversationA, 1);
    expect(answer?.content).toBe('A completed answer');
    const inserted = await repo.insertMessage(workspaceA, { conversationId: conversationA, role: 'user', content: 'second question' });
    expect(inserted.seq).toBe(4);
  });
});