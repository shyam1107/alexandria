/**
 * Drizzle schema barrel.
 *
 * Tables land here phase by phase:
 *  - Phase 2: users, workspaces, memberships, refresh tokens
 *  - Phase 3: documents, document versions, chunks (with vector + tsvector columns)
 *  - Phase 5: conversations, messages, citations
 *  - Phase 6: usage/token ledger
 */
import { sql } from 'drizzle-orm';
import { boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { documentStatus, membershipRole, messageRole, refreshTokenStatus } from './enums';

export { documentStatus, membershipRole, messageRole, refreshTokenStatus } from './enums';

const vector = customType<{ data: number[]; driverData: string }>({
	dataType() {
		return 'vector(768)';
	},
	toDriver(value) {
		return `[${value.join(',')}]`;
	},
});

// Read-only: tsvector is maintained by Postgres as a STORED generated column,
// never written or compared from application code.
const tsvector = customType<{ data: string; driverData: string }>({
	dataType() {
		return 'tsvector';
	},
});

export const users = pgTable('users', {
	id: uuid('id').defaultRandom().primaryKey(),
	email: varchar('email', { length: 320 }).notNull(),
	passwordHash: text('password_hash').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex('users_email_idx').on(table.email)]);

export const workspaces = pgTable('workspaces', {
	id: uuid('id').defaultRandom().primaryKey(),
	name: varchar('name', { length: 120 }).notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const memberships = pgTable('memberships', {
	id: uuid('id').defaultRandom().primaryKey(),
	workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
	userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	role: membershipRole('role').notNull().default('member'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex('memberships_workspace_user_idx').on(table.workspaceId, table.userId)]);

export const refreshTokens = pgTable('refresh_tokens', {
	id: uuid('id').defaultRandom().primaryKey(),
	userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	familyId: uuid('family_id').notNull(),
	tokenHash: varchar('token_hash', { length: 64 }).notNull(),
	status: refreshTokenStatus('status').notNull().default('active'),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	usedAt: timestamp('used_at', { withTimezone: true }),
	revokedAt: timestamp('revoked_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex('refresh_tokens_hash_idx').on(table.tokenHash),
	index('refresh_tokens_user_idx').on(table.userId),
]);

export const documents = pgTable('documents', {
	id: uuid('id').defaultRandom().primaryKey(),
	// The workspace FK was missing until Phase 3.5: these tables were written
	// before `workspaces` existed (Phase 3 shipped ahead of Phase 2), so a
	// deleted workspace left its documents, versions and — expensively — its
	// vector rows behind forever, unreachable because no user can ever declare
	// that workspace again. RLS hides orphans; it does not collect them.
	workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
	title: varchar('title', { length: 255 }).notNull(),
	status: documentStatus('status').default('pending').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index('documents_workspace_idx').on(table.workspaceId),
]);

export const documentVersions = pgTable('document_versions', {
	id: uuid('id').defaultRandom().primaryKey(),
	documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
	workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
	objectKey: text('object_key').notNull(),
	originalFilename: varchar('original_filename', { length: 255 }).notNull(),
	contentType: varchar('content_type', { length: 127 }).notNull(),
	byteSize: integer('byte_size').notNull(),
	contentHash: varchar('content_hash', { length: 64 }),
	status: documentStatus('status').default('pending').notNull(),
	failureMessage: text('failure_message'),
	parserVersion: varchar('parser_version', { length: 32 }),
	embeddingModel: varchar('embedding_model', { length: 128 }),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index('document_versions_document_idx').on(table.documentId),
	index('document_versions_workspace_idx').on(table.workspaceId),
	uniqueIndex('document_versions_hash_idx').on(table.workspaceId, table.contentHash),
]);

export const documentChunks = pgTable('document_chunks', {
	id: uuid('id').defaultRandom().primaryKey(),
	documentVersionId: uuid('document_version_id').notNull().references(() => documentVersions.id, { onDelete: 'cascade' }),
	workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
	chunkIndex: integer('chunk_index').notNull(),
	content: text('content').notNull(),
	// Offsets into the parser's original output (pre-normalization), captured by
	// the chunker. Nullable only because pre-Phase-4 rows predate them; the
	// worker always writes them. Phase 5 citations slice the source with these.
	charStart: integer('char_start'),
	charEnd: integer('char_end'),
	tokenCount: integer('token_count'),
	embedding: vector('embedding'),
	embeddingModel: varchar('embedding_model', { length: 128 }),
	// Was a `text` copy of `content` written by the worker — double storage and
	// not even a tsvector. Now derived by Postgres: one source of truth, and the
	// two-argument to_tsvector form is IMMUTABLE, which STORED requires. The
	// 'english' regconfig is baked in; a multilingual corpus means revisiting
	// this column (per-language configs or 'simple').
	searchVector: tsvector('search_vector').generatedAlwaysAs(sql`to_tsvector('english', content)`),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex('document_chunks_version_index_idx').on(table.documentVersionId, table.chunkIndex),
	index('document_chunks_workspace_idx').on(table.workspaceId),
	// HNSW over IVFFlat: no training pass, no recall decay as the table grows,
	// better recall/latency at our scale; the price is build time and memory.
	// Default m=16 / ef_construction=64 — tune ef_search per query, not here.
	index('document_chunks_embedding_hnsw_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
	index('document_chunks_search_vector_gin_idx').using('gin', table.searchVector),
]);

export const conversations = pgTable('conversations', {
	id: uuid('id').defaultRandom().primaryKey(),
	workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
	createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
	title: varchar('title', { length: 255 }),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index('conversations_workspace_idx').on(table.workspaceId),
]);

export const messages = pgTable('messages', {
	id: uuid('id').defaultRandom().primaryKey(),
	conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
	// Denormalized (same pattern as document_chunks) so the RLS policy reads
	// the row itself instead of joining through conversations.
	workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
	// Explicit ordering: created_at ties between a user turn and its answer
	// would make history order nondeterministic.
	seq: integer('seq').notNull(),
	role: messageRole('role').notNull(),
	content: text('content').notNull(),
	// Client-supplied idempotency key: a retry after a crash replays the
	// stored answer instead of duplicating the turn (and paying for it again).
	clientMessageId: varchar('client_message_id', { length: 128 }),
	// The RESOLVED citation map ([n] -> chunk + span as served), not the raw
	// markers — a re-ingestion changes chunk ids, and this row is the only
	// record of what the answer pointed at when it was written.
	citations: jsonb('citations'),
	// Count of [n] markers with no corresponding context item. Persisted from
	// Phase 5 so Phase 8's faithfulness harness has a baseline waiting for it.
	unresolvedCitations: integer('unresolved_citations'),
	promptTokens: integer('prompt_tokens'),
	completionTokens: integer('completion_tokens'),
	model: varchar('model', { length: 128 }),
	provider: varchar('provider', { length: 64 }),
	promptVersion: varchar('prompt_version', { length: 32 }),
	// partial = stream ended without a done event (client disconnect or
	// provider failure mid-answer). finish_reason distinguishes them.
	partial: boolean('partial').default(false).notNull(),
	finishReason: varchar('finish_reason', { length: 16 }),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex('messages_conversation_seq_idx').on(table.conversationId, table.seq),
	uniqueIndex('messages_conversation_client_idx').on(table.conversationId, table.clientMessageId),
	index('messages_workspace_idx').on(table.workspaceId),
]);
