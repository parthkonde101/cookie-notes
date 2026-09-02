import 'server-only';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '@/lib/env';
import type { StorageDriver, StoredObject } from '@/lib/storage/index';

/**
 * S3-compatible private storage. Works with AWS S3, Cloudflare R2, Backblaze B2,
 * MinIO and Supabase Storage's S3 endpoint.
 *
 * The bucket must stay private: content is streamed to the browser by our own
 * authorised endpoint, and the only presigned URLs we ever mint are short-lived
 * *upload* URLs for admins.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = 's3' as const;
  readonly supportsDirectUpload = true;

  private client: S3Client;
  private bucket: string;

  constructor() {
    const cfg = env.storage.s3;
    if (!cfg.bucket) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');

    this.bucket = cfg.bucket;
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { key, size: body.byteLength, contentType };
  }

  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) throw new Error('Object has no body');
    return result.Body.transformToWebStream() as ReadableStream<Uint8Array>;
  }

  async getRange(key: string, start: number, end: number): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }),
    );
    const bytes = await result.Body?.transformToByteArray();
    return Buffer.from(bytes ?? new Uint8Array());
  }

  async head(key: string): Promise<{ size: number; contentType: string } | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: result.ContentLength ?? 0,
        contentType: result.ContentType ?? 'application/pdf',
      };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async presignUpload(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds },
    );
  }
}
