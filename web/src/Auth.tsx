import { useState } from 'react';
import { apiJson, type Session } from './api';

interface AuthProps {
  onAuthenticated: (session: Session) => void;
}

// ponytail: register/login return the FIRST membership's workspace id
// (single-workspace product stage). A workspace switcher needs a list
// endpoint + picker; until then this is the only workspace the client knows.
export function Auth({ onAuthenticated }: AuthProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/register';
      const body = mode === 'login'
        ? { email, password }
        : { email, password, workspaceName };
      const res = await apiJson<Record<string, unknown>>(path, { method: 'POST', body: JSON.stringify(body) });
      const session: Session = {
        accessToken: res.accessToken as string,
        refreshToken: res.refreshToken as string,
        workspaceId: (res.workspaceId ?? '') as string,
      };
      if (session.workspaceId) localStorage.setItem('alexandria.workspaceId', session.workspaceId);
      onAuthenticated(session);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <h1>Alexandria</h1>
      <p>{mode === 'login' ? 'Sign in to your workspace.' : 'Create an account and a workspace.'}</p>
      <form onSubmit={submit}>
        {mode === 'register' && (
          <div className="field">
            <label htmlFor="ws">Workspace name</label>
            <input id="ws" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} required />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <div className="auth-msg">{msg}</div>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        {' '}
        <button className="quiet" type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setMsg(''); }}>
          {mode === 'login' ? 'Need an account?' : 'Have an account?'}
        </button>
      </form>
    </div>
  );
}