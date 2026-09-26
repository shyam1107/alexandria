import { useEffect, useState } from 'react';
import { loadSession, onUnauthorized, setSession, type Session } from './api';
import { Auth } from './Auth';
import { Shell } from './Shell';

export function App() {
  const [session, setSessionState] = useState<Session | null>(() => loadSession());

  useEffect(() => {
    onUnauthorized(() => setSessionState(null));
  }, []);

  if (!session) {
    return (
      <Auth
        onAuthenticated={(s) => {
          setSession(s);
          setSessionState(s);
        }}
      />
    );
  }
  return <Shell session={session} onLogout={() => { setSession(null); setSessionState(null); }} />;
}