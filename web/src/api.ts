// API client: base fetch with auth header, refresh rotation, workspace header.
// ponytail: no /me or workspace-list endpoint exists yet — workspaceId is
// stored at register/login time (register returns it via the demo config
// path); goes away when the API gap is closed.

const API = '/api/v1';

export interface Session {
  accessToken: string;
  refreshToken: string;
  workspaceId: string;
}

const store = {
  session: null as Session | null,
  onUnauthorized: null as null | (() => void),
};

export function setSession(session: Session | null) {
  store.session = session;
  if (session) localStorage.setItem('alexandria.session', JSON.stringify(session));
  else localStorage.removeItem('alexandria.session');
}

export function loadSession(): Session | null {
  const raw = localStorage.getItem('alexandria.session');
  if (!raw) return null;
  try {
    store.session = JSON.parse(raw);
  } catch {
    store.session = null;
  }
  return store.session;
}

export function onUnauthorized(cb: () => void) {
  store.onUnauthorized = cb;
}

async function refresh(): Promise<boolean> {
  if (!store.session?.refreshToken) return false;
  const res = await fetch(`${API}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: store.session.refreshToken }),
  });
  if (!res.ok) return false;
  const tokens = await res.json();
  store.session = { ...store.session!, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  localStorage.setItem('alexandria.session', JSON.stringify(store.session));
  return true;
}

export async function api(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (store.session) {
    headers.set('authorization', `Bearer ${store.session.accessToken}`);
    if (store.session.workspaceId) headers.set('x-workspace-id', store.session.workspaceId);
  }
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (res.status === 401 && retry && store.session) {
    if (await refresh()) return api(path, init, false);
    setSession(null);
    store.onUnauthorized?.();
  }
  return res;
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await api(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}