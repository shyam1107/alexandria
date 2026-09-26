import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../config/env.schema';

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly uploadUrlTtl: number;

  constructor(config: ConfigService<Env, true>) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.uploadUrlTtl = config.get('UPLOAD_URL_TTL_SECONDS', { infer: true });
    this.client = new S3Client({
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
      region: config.get('S3_REGION', { infer: true }),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('S3_SECRET_KEY', { infer: true }),
      },
    });
  }

  /**
   * Presigned PUT for direct upload. ContentLength is a SIGNED header: the
   * client's Content-Length must equal the byteSize it declared at
   * createUpload, so a client declaring 1 byte and PUTting gigabytes gets
   * a 403 from storage instead of landing the object. (S3 presigned PUT
   * enforces signed ContentLength on both MinIO and AWS.)
   *
   * This is the whole fix for item [7]: previously only Bucket/Key/ContentType
   * were signed, so the size check at completeUpload fired after the bytes
   * had already landed — bounded late is not bounded.
   */
  async createUploadUrl(objectKey: string, contentType: string, contentLength: number): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: contentType,
      ContentLength: contentLength,
    }), { expiresIn: this.uploadUrlTtl });
  }

  async head(objectKey: string): Promise<{ size: number; contentType?: string }> {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    return { size: result.ContentLength ?? 0, contentType: result.ContentType };
  }

  async download(objectKey: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    if (!result.Body) throw new Error('Object storage returned an empty body');
    return Buffer.from(await result.Body.transformToByteArray());
  }

  /**
   * Deletes one object. Used by the abandoned-upload sweeper; idempotent by
   * S3 semantics (deleting a missing key succeeds), which matters because the
   * sweeper may race a client that finally completed its upload.
   */
  async delete(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }
}
