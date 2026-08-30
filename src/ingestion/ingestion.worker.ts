import { Inject, Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../database/database.module';
import { DRIZZLE } from '../database/database.module';
import { withWorkspace } from '../database/tenant';
import { documentChunks, documentVersions, documents } from '../database/schema';
import { INGESTION_QUEUE, type IngestDocumentJob } from './ingestion.constants';
import { StorageService } from './storage.service';
import { ParserService } from './parser.service';
import { ChunkerService } from './chunker.service';
import { EmbeddingService } from './embedding.service';

@Injectable()
@Processor(INGESTION_QUEUE)
export class IngestionWorker extends WorkerHost {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly parser: ParserService,
    private readonly chunker: ChunkerService,
    private readonly embeddings: EmbeddingService,
  ) { super(); }

  async process(job: Job<IngestDocumentJob>): Promise<void> {
    const { documentId, documentVersionId, workspaceId, objectKey, contentType, originalFilename } = job.data;
    await withWorkspace(this.db, workspaceId, async (tx) => {
      await tx.update(documentVersions).set({ status: 'processing', updatedAt: new Date(), failureMessage: null }).where(and(eq(documentVersions.id, documentVersionId), eq(documentVersions.workspaceId, workspaceId)));
      await tx.update(documents).set({ status: 'processing', updatedAt: new Date() }).where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)));
    });
    try {
      const parsed = await this.parser.parse(await this.storage.download(objectKey), contentType, originalFilename);
      const chunks = this.chunker.split(parsed.text);
      if (chunks.length === 0) throw new Error('Document contains no extractable text');
      const embeddedChunks: Array<{ chunkIndex: number; content: string; charStart: number; charEnd: number; embedding: number[] }> = [];
      for (const [chunkIndex, chunk] of chunks.entries())
        embeddedChunks.push({ chunkIndex, ...chunk, embedding: await this.embeddings.embed(chunk.content, { workspaceId, operation: 'embedding_index' }) });
      await withWorkspace(this.db, workspaceId, async (tx) => {
        await tx.delete(documentChunks).where(and(eq(documentChunks.documentVersionId, documentVersionId), eq(documentChunks.workspaceId, workspaceId)));
        // searchVector is gone from the insert list: it is a STORED generated
        // column now, so Postgres derives it from content and the two can
        // never drift apart.
        for (const { chunkIndex, content, charStart, charEnd, embedding } of embeddedChunks) await tx.insert(documentChunks).values({ documentVersionId, workspaceId, chunkIndex, content, charStart, charEnd, tokenCount: content.split(/\s+/).length, embedding, embeddingModel: this.embeddings.modelName });
        await tx.update(documentVersions).set({ status: 'indexed', parserVersion: parsed.parserVersion, embeddingModel: this.embeddings.modelName, updatedAt: new Date() }).where(eq(documentVersions.id, documentVersionId));
        await tx.update(documents).set({ status: 'indexed', updatedAt: new Date() }).where(eq(documents.id, documentId));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : 'Document processing failed';
      // `attemptsStarted` is incremented when the job moves to active, so it is
      // already 1 during the first run. Only the last attempt is terminal —
      // reporting `failed` earlier would make the API lie while retries are
      // still pending, flickering failed -> processing -> indexed.
      const isFinalAttempt = job.attemptsStarted >= (job.opts.attempts ?? 1);
      await withWorkspace(this.db, workspaceId, async (tx) => {
        await tx.update(documentVersions).set({ status: isFinalAttempt ? 'failed' : 'processing', failureMessage: message, updatedAt: new Date() }).where(eq(documentVersions.id, documentVersionId));
        if (isFinalAttempt) await tx.update(documents).set({ status: 'failed', updatedAt: new Date() }).where(eq(documents.id, documentId));
      });
      throw error;
    }
  }
}
