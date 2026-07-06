/**
 * Drizzle schema barrel.
 *
 * Tables land here phase by phase:
 *  - Phase 2: users, workspaces, memberships, refresh tokens
 *  - Phase 3: documents, document versions, chunks (with vector + tsvector columns)
 *  - Phase 5: conversations, messages, citations
 *  - Phase 6: usage/token ledger
 */
export {};
