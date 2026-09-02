import 'server-only';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { LocalStorageDriver } from '@/lib/storage/local';
import { S3StorageDriver } from '@/lib/storage/s3';

export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
}

export interface StorageDriver {
  readonly name: 'local' | 's3';
  /** True when the browser can PUT straight to storage with a presigned URL. */
  readonly supportsDirectUpload: boolean;

  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  /** Web stream so route handlers can pipe without buffering the whole file. */
  getStream(key: string): Promise<ReadableStream<Uint8Array>>;
  getRange(key: string, start: number, end: number): Promise<Buffer>;
  head(key: string): Promise<{ size: number; contentType: string } | null>;
  delete(key: string): Promise<void>;
  presignUpload?(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
}

let cached: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (cached) return cached;
  cached = env.storage.driver === 's3' ? new S3StorageDriver() : new LocalStorageDriver();
  return cached;
}

/**
 * Storage keys are opaque and unguessable and are never sent to the browser —
 * content is always served through an authorised application endpoint.
 */
export function buildNoteKey(originalName: string): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const safeExt = (originalName.split('.').pop() ?? 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `notes/${yyyy}/${mm}/${randomUUID()}.${safeExt || 'pdf'}`;
}

export const PDF_MAGIC = Buffer.from('%PDF-');

/** Cheap structural validation: real PDFs start with %PDF- and contain %%EOF. */
export function looksLikePdf(head: Buffer, tail?: Buffer): boolean {
  if (head.length < 5) return false;
  if (!head.subarray(0, 5).equals(PDF_MAGIC)) return false;
  if (tail && !tail.includes('%%EOF')) return false;
  return true;
}
