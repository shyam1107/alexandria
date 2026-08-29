import { ConflictException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import type { Db } from '../database/database.module';
import { DRIZZLE } from '../database/database.module';
import { withWorkspace } from '../database/tenant';
import { isUniqueViolation } from '../database/errors';
import { documents, documentVersions } from '../database/schema';
import type { Env } from '../config/env.schema';
import { INGESTION_QUEUE, INGEST_DOCUMENT_JOB, type IngestDocumentJob } from './ingestion.constants';
import { StorageService } from './storage.service';

export interface CreateDocumentInput {
  workspaceId: string;
  filename: string;
  contentType: string;
  byteSize: number;
}

@Injectable()
export class DocumentService {
  private readonly maxBytes: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @InjectQueue(INGESTION_QUEUE) private readonly queue: Queue<IngestDocumentJob>,
    private readonly storage: StorageService,
    config: ConfigService<Env, true>,
  ) {
    this.maxBytes = config.get('MAX_DOCUMENT_BYTES', { infer: true });
  }

  async createUpload(input: CreateDocumentInput) {
    if (input.byteSize > this.maxBytes) throw new PayloadTooLargeException(`Document exceeds the ${this.maxBytes} byte limit`);
    const documentId = randomUUID();
    const versionId = randomUUID();
    const objectKey = `${input.workspaceId}/${documentId}/${versionId}/${input.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const document = await withWorkspace(this.db, input.workspaceId, async (tx) => {
      const [created] = await tx.insert(documents).values({ id: documentId, workspaceId: input.workspaceId, title: input.filename }).returning();
      await tx.insert(documentVersions).values({ id: versionId, documentId, workspaceId: input.workspaceId, objectKey, originalFilename: input.filename, contentType: input.contentType, byteSize: input.byteSize });
      return created;
    });
    return {
      document,
      versionId,
      objectKey,
      uploadUrl: await this.storage.createUploadUrl(objectKey, input.contentType),
    };
  }

  async completeUpload(workspaceId: string, documentId: string, versionId: string) {
    const [version] = await withWorkspace(this.db, workspaceId, (tx) =>
      tx.select().from(documentVersions).where(and(eq(documentVersions.id, versionId), eq(documentVersions.documentId, documentId), eq(documentVersions.workspaceId, workspaceId))),
    );
    if (!version) throw new NotFoundException('Document version not found');
    const head = await this.storage.head(version.objectKey);
    if (head.size !== version.byteSize) throw new ConflictException('Uploaded object size does not match the declared size');
    const contentHash = createHash('sha256').update(await this.storage.download(version.objectKey)).digest('hex');

    const [duplicate] = await withWorkspace(this.db, workspaceId, (tx) =>
      tx
        .select({ id: documentVersions.id, documentId: documentVersions.documentId })
        .from(documentVersions)
        .where(and(eq(documentVersions.workspaceId, workspaceId), eq(documentVersions.contentHash, contentHash))),
    );
    if (duplicate && duplicate.id !== versionId) {
      await this.discardVersion(workspaceId, documentId, versionId);
      throw new ConflictException({
        message: 'Identical content is already indexed in this workspace',
        existingDocumentId: duplicate.documentId,
        existingVersionId: duplicate.id,
      });
    }

    try {
      await withWorkspace(this.db, workspaceId, async (tx) => {
        await tx.update(documentVersions).set({ status: 'uploaded', contentHash, updatedAt: new Date() }).where(eq(documentVersions.id, versionId));
        await tx.update(documents).set({ status: 'uploaded', updatedAt: new Date() }).where(eq(documents.id, documentId));
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await this.discardVersion(workspaceId, documentId, versionId);
      throw new ConflictException({ message: 'Identical content is already indexed in this workspace' });
    }

    await this.queue.add(INGEST_DOCUMENT_JOB, {
      documentId, documentVersionId: versionId, workspaceId, objectKey: version.objectKey,
      contentType: version.contentType, originalFilename: version.originalFilename,
    }, { jobId: versionId, attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 100, removeOnFail: 1000 });
    return { documentId, versionId, status: 'uploaded' as const };
  }

  async status(workspaceId: string, documentId: string) {
    return withWorkspace(this.db, workspaceId, async (tx) => {
      const [document] = await tx.select().from(documents).where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)));
      if (!document) throw new NotFoundException('Document not found');
      const versions = await tx.select().from(documentVersions).where(eq(documentVersions.documentId, documentId)).orderBy(desc(documentVersions.createdAt));
      return { ...document, versions };
    });
  }

  /**
   * Removes a version that turned out to be redundant, and its parent document
   * if nothing else hangs off it — so a rejected upload leaves no half-created
   * rows behind. The S3 object is left to a bucket lifecycle rule, which has to
   * exist anyway for uploads that are presigned but never completed.
   */
  private async discardVersion(workspaceId: string, documentId: string, versionId: string) {
    await withWorkspace(this.db, workspaceId, async (tx) => {
      await tx.delete(documentVersions).where(and(eq(documentVersions.id, versionId), eq(documentVersions.workspaceId, workspaceId)));
      const remaining = await tx.select({ id: documentVersions.id }).from(documentVersions).where(eq(documentVersions.documentId, documentId));
      if (remaining.length === 0) await tx.delete(documents).where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)));
    });
  }
}
