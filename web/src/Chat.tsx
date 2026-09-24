import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, apiJson } from './api';

interface Source {
  n: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  charStart: number | null;
  charEnd: number | null;
}

interface Turn {
  question: string;
  answer: string;
  sources: Source[];
  done: boolean;
  error?: string;
}

interface ConversationRow {
  id: string;
  title: string | null;
  updatedAt: string;
}

interface MessageRow {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  citations?: { sources?: Source[] } | null;
}

// SSE over POST: fetch + ReadableStream reader. EventSource cannot POST, and
// the API's grammar is event: sources/delta/usage/done/error frames.
async function streamChat(
  question: string,
  conversationId: string | undefined,
  onEvent: (name: string, data: unknown) => void,
): Promise<void> {
  const res = await api('/chat', {
    method: 'POST',
    body: JSON.stringify({ message: question, ...(conversationId ? { conversationId } : {}) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `${res.status} ${res.statusText}`);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Frames separated by blank line; heartbeat lines (": ping") ignored by
    // the parser below because they carry no event/data fields.
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let name = '';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (name && data) onEvent(name, JSON.parse(data));
    }
  }
}

export function Chat() {
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [litSource, setLitSource] = useState<number | null>(null);
  // undefined = new conversation on next ask; set once the first frame
  // reports the id, so follow-ups share context server-side.
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);

  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: () => apiJson<ConversationRow[]>('/chat/conversations'),
  });

  const openConversation = useMutation({
    mutationFn: async (id: string) => {
      const messages = await apiJson<MessageRow[]>(`/chat/conversations/${id}/messages`);
      return { id, messages };
    },
    onSuccess: ({ id, messages }) => {
      setConversationId(id);
      // Rebuild turns from persisted rows: user row + its assistant row
      // pair into one Turn. Sources come from the stored citation map.
      const loaded: Turn[] = [];
      for (const m of messages) {
        if (m.role === 'user') loaded.push({ question: m.content, answer: '', sources: [], done: true });
        else if (loaded.length > 0) {
          const t = loaded[loaded.length - 1];
          t.answer = m.content;
          t.sources = m.citations?.sources ?? [];
        }
      }
      setTurns(loaded);
      bottom.current?.scrollIntoView({ behavior: 'smooth' });
    },
  });

  const newConversation = () => {
    openConversation.reset();
    setConversationId(undefined);
    setTurns([]);
  };

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || busy) return;
    const q = question;
    setQuestion('');
    setBusy(true);
    setLitSource(null);
    const turn: Turn = { question: q, answer: '', sources: [], done: false };
    setTurns((t) => [...t, turn]);
    bottom.current?.scrollIntoView({ behavior: 'smooth' });

    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? fn(t) : t)));

    try {
      await streamChat(q, conversationId, (name, data) => {
        if (name === 'sources') {
          const frame = data as { conversationId?: string; sources: Source[] };
          if (frame.conversationId) setConversationId(frame.conversationId);
          patch((t) => ({ ...t, sources: frame.sources }));
        }
        else if (name === 'delta') patch((t) => ({ ...t, answer: t.answer + (data as { text: string }).text }));
        else if (name === 'done') patch((t) => ({ ...t, done: true }));
        else if (name === 'error') patch((t) => ({ ...t, done: true, error: (data as { message: string }).message }));
      });
    } catch (err) {
      patch((t) => ({ ...t, done: true, error: err instanceof Error ? err.message : 'Chat failed' }));
    } finally {
      setBusy(false);
      // The conversation list ordering (updatedAt desc) changed.
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }
  };

  const latest = turns[turns.length - 1];

  return (
    <div className="chat-spread">
      <div className="chat-main">
        <div className="chat-toolbar">
          <button className="quiet" type="button" onClick={newConversation}>+ New chat</button>
        </div>
        <div className="chat-scroll">
          {turns.length === 0 && <div className="empty">Ask a question about your documents.</div>}
          {turns.map((turn, ti) => (
            <div key={ti}>
              <h2 className="question">{turn.question}</h2>
              <div className={`answer${!turn.done ? ' thinking' : ''}`}>
                {turn.answer
                  ? <Markdown remarkPlugins={[remarkGfm]}>{turn.answer}</Markdown>
                  : (turn.error ? '' : '…')}
                {turn.error && <span style={{ color: 'var(--stamp)' }}>{turn.error}</span>}
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <form className="askrow" onSubmit={ask}>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about your documents…"
            disabled={busy}
          />
          <button className="primary" type="submit" disabled={busy || !question.trim()}>
            {busy ? '…' : 'Ask'}
          </button>
        </form>
      </div>

      <aside className="margin">
        <div className="history">
          <div className="history-head">History</div>
          {conversations.isLoading && <div className="empty">Loading…</div>}
          {conversations.isError && <div className="empty">Could not load history.</div>}
          {conversations.data?.length === 0 && <div className="empty">No conversations yet.</div>}
          {conversations.data?.map((c) => (
            <a
              key={c.id}
              className={`history-item${conversationId === c.id ? ' active' : ''}`}
              onClick={() => openConversation.mutate(c.id)}
              href="#"
            >
              {c.title ?? 'Untitled'}
            </a>
          ))}
        </div>

        {latest && latest.sources.length > 0 ? (
          // Group by document: a single-document answer renders the title
          // once, not N times. Chunk spans distinguish sources within a doc.
          <div className="sources-block">
            <div className="history-head">Sources</div>
            {Object.entries(
              latest.sources.reduce<Record<string, { title: string; items: Source[] }>>((acc, s) => {
                (acc[s.documentId] ??= { title: s.documentTitle, items: [] }).items.push(s);
                return acc;
              }, {}),
            ).map(([docId, group]) => (
              <div key={docId} className="source-group">
                <div className="source-doc-title">{group.title}</div>
                {group.items.map((s) => (
                  <div
                    key={s.chunkId}
                    className={`source${litSource === s.n ? ' lit' : ''}`}
                    onMouseEnter={() => setLitSource(s.n)}
                    onMouseLeave={() => setLitSource(null)}
                  >
                    <span className="n">{s.n}</span>
                    <span className="doc">
                      {s.charStart !== null && s.charEnd !== null ? `chars ${s.charStart}–${s.charEnd}` : 'chunk'}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="sources-block"><div className="history-head">Sources</div><div className="empty">Sources appear here.</div></div>
        )}
      </aside>
    </div>
  );
}