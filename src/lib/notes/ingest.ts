import 'server-only';
import { env } from '@/lib/env';
import { Errors } from '@/lib/errors';
import { buildNoteKey, looksLikePdf, storage } from '@/lib/storage/index';
import { inspectPdf } from '@/lib/notes/pdf-meta';

export interface IngestedPdf {
  storageKey: string;
  fileName: string;
  fileSize: number;
  checksum: string | null;
  pageCount: number | null;
}

/**
 * Takes the file half of an admin upload and returns a validated object in
 * private storage.
 *
 * Uploading a new PDF and replacing an existing one differ only in what happens
 * to the database afterwards — the file itself is accepted the same way both
 * times — so both routes share this. Keeping it in one place is what stops the
 * two paths from drifting into two upload systems with two sets of checks.
 *
 * Two shapes arrive here:
 *   • direct — the browser already PUT the bytes to object storage with a
 *              short-lived presigned URL and sends only the key. Nothing the
 *              client says about that object is trusted: its size and leading
 *              bytes are read back out of storage, and an object that fails
 *              either check is deleted rather than left behind.
 *   • proxy  — the browser posts the file through the app, which parses the PDF
 *              before writing it. Used by the local driver and for small files.
 *
 * The returned key always sits inside the same private area the reader serves
 * from. No public URL is produced at any point.
 */
export async function ingestPdfUpload(
  form: FormData,
  options: { fallbackFileName?: string } = {},
): Promise<IngestedPdf> {
  const driver = storage();
  const uploadedKey = String(form.get('storageKey') ?? '');

  if (uploadedKey) {
    // --- direct-to-storage upload ---
    if (!uploadedKey.startsWith('notes/')) throw Errors.validation('Invalid upload reference.');

    const head = await driver.head(uploadedKey);
    if (!head) throw Errors.validation('The upload did not complete. Please try again.');
    if (head.size === 0) {
      await driver.delete(uploadedKey);
      throw Errors.validation('That file is empty.');
    }
    if (head.size > env.uploads.maxBytes) {
      await driver.delete(uploadedKey);
      throw Errors.validation(`Files must be ${env.uploads.maxMb} MB or smaller.`);
    }

    const header = await driver.getRange(uploadedKey, 0, 1023);
    if (!looksLikePdf(header)) {
      await driver.delete(uploadedKey);
      throw Errors.validation('That file is not a valid PDF.');
    }

    return {
      storageKey: uploadedKey,
      fileName: String(form.get('fileName') ?? options.fallbackFileName ?? 'note.pdf').slice(0, 200),
      fileSize: head.size,
      // The page count needs the whole document; a ranged read only proves the
      // header. Left null rather than guessed.
      checksum: null,
      pageCount: null,
    };
  }

  // --- proxied upload ---
  const file = form.get('file');
  if (!(file instanceof File)) throw Errors.validation('Choose a PDF file to upload.');
  if (file.size === 0) throw Errors.validation('That file is empty.');
  if (file.size > env.uploads.maxBytes) {
    throw Errors.validation(`Files must be ${env.uploads.maxMb} MB or smaller.`);
  }
  if (file.type && !env.uploads.allowedMimeTypes.includes(file.type as 'application/pdf')) {
    throw Errors.validation('Only PDF files are supported right now.');
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const inspection = inspectPdf(buffer);
  if (!inspection.valid) throw Errors.validation(inspection.reason ?? 'Invalid PDF.');

  const storageKey = buildNoteKey(file.name);
  await driver.put(storageKey, buffer, 'application/pdf');

  return {
    storageKey,
    fileName: file.name.slice(0, 200),
    fileSize: buffer.byteLength,
    checksum: inspection.checksum,
    pageCount: inspection.pageCount,
  };
}
