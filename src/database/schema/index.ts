/**
 * Drizzle schema barrel.
 *
 * Tables land here phase by phase:
 *  - Phase 2: users, workspaces, memberships, refresh tokens
 *  - Phase 3: documents, document versions, chunks (with vector + tsvector columns)
 *  - Phase 5: conversations, messages, citations
 *  - Phase 6: usage/token ledger
 */
import { customType, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

export const membershipRole = pgEnum('membership_role', ['owner', 'admin', 'member']);
export const refreshTokenStatus = pgEnum('refresh_token_status', ['active', 'revoked', 'used']);

export const documentStatus = pgEnum('document_status', ['pending', 'uploaded', 'processing', 'indexed', 'failed']);

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
}, (table) => ({ emailIndex: uniqueIndex('users_email_idx').on(table.email) }));

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
}, (table) => ({ membershipIndex: uniqueIndex('memberships_workspace_user_idx').on(table.workspaceId, table.userId) }));

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
}, (table) => ({ tokenIndex: uniqueIndex('refresh_tokens_hash_idx').on(table.tokenHash), userIndex: index('refresh_tokens_user_idx').on(table.userId) }));

export const documents = pgTable('documents', {
	id: uuid('id').defaultRandom().primaryKey(),
	workspaceId: uuid('workspace_id').notNull(),
	title: varchar('title', { length: 255 }).notNull(),
	status: documentStatus('status').default('pending').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
	workspaceIndex: index('documents_workspace_idx').on(table.workspaceId),
}));

export const documentVersions = pgTable('document_versions', {
	id: uuid('id').defaultRandom().primaryKey(),
	documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
	workspaceId: uuid('workspace_id').notNull(),
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
}, (table) => ({
	documentIndex: index('document_versions_document_idx').on(table.documentId),
	workspaceIndex: index('document_versions_workspace_idx').on(table.workspaceId),
	idempotencyIndex: uniqueIndex('document_versions_hash_idx').on(table.workspaceId, table.contentHash),
}));

export const documentChunks = pgTable('document_chunks', {
	id: uuid('id').defaultRandom().primaryKey(),
	documentVersionId: uuid('document_version_id').notNull().references(() => documentVersions.id, { onDelete: 'cascade' }),
	workspaceId: uuid('workspace_id').notNull(),
	chunkIndex: integer('chunk_index').notNull(),
	content: text('content').notNull(),
	tokenCount: integer('token_count'),
	embedding: vector('embedding'),
	embeddingModel: varchar('embedding_model', { length: 128 }),
	searchVector: text('search_vector'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
	versionIndex: uniqueIndex('document_chunks_version_index_idx').on(table.documentVersionId, table.chunkIndex),
	workspaceIndex: index('document_chunks_workspace_idx').on(table.workspaceId),
}));
