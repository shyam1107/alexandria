export const INGESTION_QUEUE = 'INGESTION_QUEUE';
export const INGEST_DOCUMENT_JOB = 'ingest-document';

export interface IngestDocumentJob {
  documentId: string;
  documentVersionId: string;
  workspaceId: string;
  objectKey: string;
  contentType: string;
  originalFilename: string;
}