export interface AuthenticatedUser {
  userId: string;
  email: string;
}

/**
 * Set by ChatRateLimitGuard: the concurrent-stream lease acquired for THIS
 * request. The controller releases it when the stream ends; the lease's own
 * TTL is the crash-cleanliness fallback if nothing releases it.
 */
export interface StreamLease {
  key: string;
  id: string;
}

export interface RequestWithAuth {
  user?: AuthenticatedUser;
  workspaceId?: string;
  streamLease?: StreamLease;
  headers: Record<string, string | string[] | undefined>;
}