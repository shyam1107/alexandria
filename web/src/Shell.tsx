import { useState } from 'react';
import type { Session } from './api';
import { Documents } from './Documents';
import { Chat } from './Chat';

interface ShellProps {
  session: Session;
  onLogout: () => void;
}

export function Shell({ session, onLogout }: ShellProps) {
  const [view, setView] = useState<'documents' | 'chat'>('documents');

  return (
    <>
      <header className="masthead">
        <span className="wordmark">Alexandria</span>
        <span className="place">
          {session.workspaceId ? <b>workspace</b> : 'no workspace selected'}
        </span>
        <div className="right">
          <button className="quiet" onClick={onLogout}>Sign out</button>
        </div>
      </header>
      <div className="app">
        <aside className="sidebar">
          <nav>
            <a className={view === 'documents' ? 'active' : ''} onClick={() => setView('documents')} href="#">Documents</a>
            <a className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')} href="#">Ask</a>
          </nav>
        </aside>
        <main className="main">
          {view === 'documents' ? <Documents /> : <Chat />}
        </main>
      </div>
    </>
  );
}