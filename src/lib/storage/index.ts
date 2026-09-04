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

// ---------------------------------------------------------------------------
// Notebook cover images
// ---------------------------------------------------------------------------

/**
 * Covers are catalogue imagery, not protected content, but they live in the
 * same private bucket as everything else — the bucket is never made public.
 * They get their own key prefix so a cover can never be mistaken for note
 * content by a route that only ever expects to serve PDFs.
 */
export const COVER_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type CoverMimeType = (typeof COVER_MIME_TYPES)[number];

/** Covers are small by nature; anything larger is a mistake, not a photo. */
export const MAX_COVER_BYTES = 5 * 1024 * 1024;

export function isCoverMimeType(value: string): value is CoverMimeType {
  return (COVER_MIME_TYPES as readonly string[]).includes(value);
}

export function buildCoverKey(subjectId: string, mimeType: string): string {
  const extension =
    mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  // A fresh uuid per upload rather than a stable name, so replacing a cover can
  // never be served from a stale CDN or browser cache.
  return `covers/${subjectId}/${randomUUID()}.${extension}`;
}

/**
 * Identifies an image from its leading bytes and returns the type it actually
 * is — not the type the uploader claimed.
 *
 * A declared Content-Type is attacker-controlled, so it is never trusted on its
 * own: the bytes decide, and a mismatch is rejected by the caller.
 */
export function sniffImageMimeType(head: Buffer): CoverMimeType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  // WebP is a RIFF container: "RIFF" .... "WEBP"
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Reads an image's pixel dimensions from its header.
 *
 * Enough to reject a 1x1 tracking pixel or an absurd decompression bomb without
 * pulling in an image library or decoding the whole file. Returns null when the
 * header is not understood, which the caller treats as "unknown" rather than
 * "invalid" — the magic-byte check has already established the format.
 */
export function readImageSize(buffer: Buffer): { width: number; height: number } | null {
  // PNG: IHDR is always the first chunk, at a fixed offset.
  if (buffer.length >= 24 && buffer.subarray(12, 16).toString('latin1') === 'IHDR') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // WebP (simple lossy and lossless forms).
  if (buffer.length >= 30 && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    const format = buffer.subarray(12, 16).toString('latin1');
    if (format === 'VP8 ' && buffer.length >= 30) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (format === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (format === 'VP8X' && buffer.length >= 30) {
      const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
      const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
      return { width, height };
    }
    return null;
  }

  // JPEG: walk the segment markers to the start-of-frame.
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      // SOF0..SOF15, excluding the non-frame markers DHT/JPG/DAC.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return null;
      offset += 2 + length;
    }
  }

  return null;
}
