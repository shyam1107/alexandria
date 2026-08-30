import { pgEnum } from 'drizzle-orm/pg-core';

export const membershipRole = pgEnum('membership_role', ['owner', 'admin', 'member']);
export const refreshTokenStatus = pgEnum('refresh_token_status', ['active', 'revoked', 'used']);
export const documentStatus = pgEnum('document_status', ['pending', 'uploaded', 'processing', 'indexed', 'failed']);
// System prompts are code, not data — only turns a conversation actually has.
export const messageRole = pgEnum('message_role', ['user', 'assistant']);
// Every kind of call the platform layer meters. The rewriter and embeddings
// are LLM spend with no message row to hang off — this enum is why the
// ledger exists separately from `messages`.
export const llmOperation = pgEnum('llm_operation', ['chat_answer', 'query_rewrite', 'embedding_index', 'embedding_query']);
