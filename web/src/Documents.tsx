import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './api';

interface Document {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

interface CreateUploadResponse {
  document: { id: string };
  versionId: string;
  objectKey: string;
  uploadUrl: string;
}

const POLL_MS = 2000;

export function Documents() {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const docs = useQuery({
    queryKey: ['documents'],
    queryFn: () => apiJson<Document[]>('/documents'),
    // Poll while anything is in flight; the worker flips status server-side.
    refetchInterval: (q) =>
      q.state.data?.some((d) => d.status === 'processing' || d.status === 'uploaded' || d.status === 'pending')
        ? POLL_MS
        : false,
    // ponytail: no failure message in the list shape — fetch /:id on click
    // to show it; add when a detail view exists.
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      // Three-step presigned flow: create → PUT → complete.
      const created = await apiJson<CreateUploadResponse>('/documents', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, contentType: file.type || 'application/octet-stream', byteSize: file.size }),
      });
      const put = await fetch(created.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed: ${put.status}`);
      await apiJson(`/documents/${created.document.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ versionId: created.versionId }),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['documents'] }),
    onError: (e) => setError(e instanceof Error ? e.message : 'Upload failed'),
  });

  const onFiles = (files: FileList | null) => {
    setError('');
    for (const file of files ?? []) upload.mutate(file);
  };

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      <div
        className={`dropzone${dragOver ? ' drag' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); onFiles(e.dataTransfer.files); }}
        onClick={() => fileInput.current?.click()}
      >
        Drop documents here, or click to choose. PDF, DOCX, Markdown, text.
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }}
        />
      </div>

      {docs.isLoading && <div className="empty">Loading…</div>}
      {docs.isError && <div className="empty">Could not load documents: {String(docs.error)}</div>}
      {docs.data?.length === 0 && <div className="empty">No documents yet.</div>}

      {docs.data?.map((doc) => (
        <div key={doc.id} className="doc-row">
          <div>
            <div className="doc-title">{doc.title}</div>
            <div className="doc-meta">{new Date(doc.updatedAt).toLocaleString()}</div>
          </div>
          <span className={`status ${doc.status}`} style={{ marginLeft: 'auto' }}>{doc.status}</span>
        </div>
      ))}
    </>
  );
}