import 'server-only';
import { createReadStream } from 'node:fs';
import { mkdir, open, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { env } from '@/lib/env';
import type { StorageDriver, StoredObject } from '@/lib/storage/index';

/**
 * Filesystem storage in a directory that is *not* inside /public, so Next.js
 * never serves these files statically. Good for local development and for
 * single-server deployments with a persistent disk (Railway volume, VPS, Fly).
 *
 * Not suitable for serverless hosts — see the S3 driver.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local' as const;
  readonly supportsDirectUpload = false;

  private root = path.resolve(process.cwd(), env.storage.localDir);

  /** Blocks path traversal: a key may never escape the storage root. */
  private resolve(key: string): string {
    const target = path.resolve(this.root, key);
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      throw new Error('Invalid storage key');
    }
    return target;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, { mode: 0o600 });
    return { key, size: body.byteLength, contentType };
  }

  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const target = this.resolve(key);
    await stat(target);
    return Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>;
  }

  async getRange(key: string, start: number, end: number): Promise<Buffer> {
    const target = this.resolve(key);
    const handle = await open(target, 'r');
    try {
      const length = Math.max(0, end - start + 1);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async head(key: string): Promise<{ size: number; contentType: string } | null> {
    try {
      const info = await stat(this.resolve(key));
      return { size: info.size, contentType: 'application/pdf' };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch {
      /* already gone */
    }
  }
}
