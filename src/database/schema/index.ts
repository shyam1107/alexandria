/**
 * Drizzle schema barrel.
 *
 * Tables land here phase by phase:
 *  - Phase 2: users, workspaces, memberships, refresh tokens
 *  - Phase 3: documents, document versions, chunks (with vector + tsvector columns)
 *  - Phase 5: conversations, messages, citations
 *  - Phase 6: usage/token ledger
 */
import { customType, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { documentStatus, membershipRole, refreshTokenStatus } from './enums';

export { documentStatus, membershipRole, refreshTokenStatus } from './enums';

const vector = customType<{ data: number[]; driverData: string }>({
	dataType() {
		return 'vector(768)';
	},
	toDriver(value) {
		return `[${value.join(',')}]`;
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
	tokenCount: integer('token_count'),
	embedding: vector('embedding'),
	embeddingModel: varchar('embedding_model', { length: 128 }),
	searchVector: text('search_vector'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex('document_chunks_version_index_idx').on(table.documentVersionId, table.chunkIndex),
	index('document_chunks_workspace_idx').on(table.workspaceId),
]);
