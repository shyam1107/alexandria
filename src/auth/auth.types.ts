export interface AuthenticatedUser {
  userId: string;
  email: string;
}

export interface RequestWithAuth {
  user?: AuthenticatedUser;
  workspaceId?: string;
  headers: Record<string, string | string[] | undefined>;
}