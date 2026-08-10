import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

  async createUploadUrl(objectKey: string, contentType: string): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: contentType,
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
}