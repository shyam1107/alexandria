export const INGESTION_QUEUE = 'INGESTION_QUEUE';
export const INGEST_DOCUMENT_JOB = 'ingest-document';

export interface IngestDocumentJob {
  documentId: string;
  documentVersionId: string;
  workspaceId: string;
  objectKey: string;
  contentType: string;
  originalFilename: string;
  /**
   * Phase 7 trace propagation. The request crosses a process boundary here
   * (API → Redis → worker); without the id riding in the PAYLOAD, the
   * trace ends at the enqueue and a failed ingestion can never be
   * correlated back to the upload that caused it. Generated per request
   * by the trace middleware, absent for jobs created outside a request
   * (tests, replays) — the worker treats absence as "untraced", never
   * invents one.
   */
  traceId?: string;
}