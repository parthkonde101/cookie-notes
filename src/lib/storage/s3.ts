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

      /*
       * Required for every S3-compatible store that is not AWS itself.
       *
       * From v3.729 the AWS SDK defaults these to WHEN_SUPPORTED, which adds a
       * CRC32 integrity checksum to PutObject. That is fine for a normal upload,
       * where the SDK sees the body — but a *presigned* PUT has no body at
       * signing time, so the SDK computes the checksum of nothing and pins
       * `x-amz-checksum-crc32=AAAAAA==` (the CRC32 of an empty payload) into the
       * signed URL. The browser then uploads a real PDF, the checksum cannot
       * match, and the store rejects the request.
       *
       * WHEN_REQUIRED restores the pre-3.729 behaviour: send a checksum only for
       * operations that genuinely mandate one. It changes nothing about SigV4
       * authentication, and integrity is still verified — the finalize route
       * reads the object's header and size back out of storage before creating
       * the note row.
       */
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
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
