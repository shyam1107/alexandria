import { pgEnum } from 'drizzle-orm/pg-core';

export const membershipRole = pgEnum('membership_role', ['owner', 'admin', 'member']);
export const refreshTokenStatus = pgEnum('refresh_token_status', ['active', 'revoked', 'used']);
export const documentStatus = pgEnum('document_status', ['pending', 'uploaded', 'processing', 'indexed', 'failed']);
