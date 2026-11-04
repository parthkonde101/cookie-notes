import 'server-only';
import { Errors } from '@/lib/errors';
import {
  buildCoverKey,
  isCoverMimeType,
  MAX_COVER_BYTES,
  readImageSize,
  sniffImageMimeType,
  storage,
} from '@/lib/storage/index';

/** A cover smaller than this is a placeholder or a tracking pixel, not artwork. */
const MIN_DIMENSION = 200;
/** Guards against a decompression bomb dressed up as a cover. */
const MAX_DIMENSION = 6000;

/** A bundle's covers are filed under `covers/bundle-<id>/`, which a subject id can never collide with. */
export function bundleCoverOwner(bundleId: string): string {
  return `bundle-${bundleId}`;
}

function checkDimensions(size: { width: number; height: number } | null): void {
  if (size && (size.width < MIN_DIMENSION || size.height < MIN_DIMENSION)) {
    throw Errors.validation(
      `That image is ${size.width}×${size.height}. Covers should be at least ${MIN_DIMENSION}px on each side.`,
    );
  }
  if (size && (size.width > MAX_DIMENSION || size.height > MAX_DIMENSION)) {
    throw Errors.validation(`Covers must be ${MAX_DIMENSION}px or smaller on each side.`);
  }
}

/**
 * Takes in a cover image for a subject or a bundle and returns where it now lives.
 *
 * Both upload shapes the admin UI uses end here: the browser has already PUT the image to private
 * storage with a short-lived presigned URL and sends only the key (`storageKey`), or it posts the
 * bytes through the app (`file`) — the local storage driver, and small files anywhere. Nothing the
 * client claims is trusted: the bytes are read back out of storage and sniffed, and an object that
 * fails any check is deleted before the error is thrown, so a rejected upload leaves nothing behind.
 *
 * `ownerId` is the folder the image belongs in (`covers/<ownerId>/…`). A presigned key must
 * start with it, so a compromised client cannot point a cover at an unrelated object such as a note
 * PDF.
 */
export async function receiveCover(
  form: FormData,
  ownerId: string,
): Promise<{ key: string; mimeType: string }> {
  const uploadedKey = String(form.get('storageKey') ?? '');
  const file = form.get('file');
  const driver = storage();

  if (uploadedKey) {
    if (!uploadedKey.startsWith(`covers/${ownerId}/`)) {
      throw Errors.validation('Invalid upload reference.');
    }

    const head = await driver.head(uploadedKey);
    if (!head) throw Errors.validation('The upload did not complete. Please try again.');
    if (head.size > MAX_COVER_BYTES) {
      await driver.delete(uploadedKey);
      throw Errors.validation('Cover images must be 5 MB or smaller.');
    }

    // Read enough of the header to identify the format and its dimensions.
    const header = await driver.getRange(uploadedKey, 0, Math.min(head.size, 65_535) - 1);
    const sniffed = sniffImageMimeType(header);
    if (!sniffed) {
      await driver.delete(uploadedKey);
      throw Errors.validation('That file is not a JPG, PNG or WebP image.');
    }
    try {
      checkDimensions(readImageSize(header));
    } catch (error) {
      await driver.delete(uploadedKey);
      throw error;
    }

    return { key: uploadedKey, mimeType: sniffed };
  }

  if (!(file instanceof File)) throw Errors.validation('Choose an image to upload.');
  if (file.size === 0) throw Errors.validation('That file is empty.');
  if (file.size > MAX_COVER_BYTES) throw Errors.validation('Cover images must be 5 MB or smaller.');

  const buffer = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffImageMimeType(buffer);
  if (!sniffed) throw Errors.validation('That file is not a JPG, PNG or WebP image.');
  if (file.type && isCoverMimeType(file.type) && file.type !== sniffed) {
    throw Errors.validation('That file does not match the image type it claims to be.');
  }
  checkDimensions(readImageSize(buffer));

  const key = buildCoverKey(ownerId, sniffed);
  await driver.put(key, buffer, sniffed);
  return { key, mimeType: sniffed };
}
