import 'server-only';
import { createHash } from 'node:crypto';

/**
 * Cheap, dependency-free PDF inspection used at upload time.
 *
 * Page counting here is best effort: a PDF that stores its page tree in
 * compressed object streams will not match, in which case we record `null` and
 * let the reader report the real count the first time the note is opened.
 */
export function inspectPdf(buffer: Buffer): {
  valid: boolean;
  reason?: string;
  pageCount: number | null;
  checksum: string;
} {
  const checksum = createHash('sha256').update(buffer).digest('hex');

  if (buffer.length < 1024) {
    return { valid: false, reason: 'The file is too small to be a valid PDF.', pageCount: null, checksum };
  }
  if (!buffer.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
    return { valid: false, reason: 'That file is not a PDF.', pageCount: null, checksum };
  }

  // %%EOF normally sits in the last kilobyte or so.
  const tail = buffer.subarray(Math.max(0, buffer.length - 4096)).toString('latin1');
  if (!tail.includes('%%EOF')) {
    return {
      valid: false,
      reason: 'This PDF looks truncated or corrupted. Try exporting it again.',
      pageCount: null,
      checksum,
    };
  }

  let pageCount: number | null = null;
  const text = buffer.toString('latin1');

  const countMatch = text.match(/\/Type\s*\/Pages[\s\S]{0,400}?\/Count\s+(\d+)/);
  if (countMatch) {
    pageCount = Number(countMatch[1]);
  } else {
    const pages = text.match(/\/Type\s*\/Page[^s]/g);
    if (pages && pages.length > 0) pageCount = pages.length;
  }

  if (pageCount !== null && (!Number.isFinite(pageCount) || pageCount <= 0 || pageCount > 20_000)) {
    pageCount = null;
  }

  return { valid: true, pageCount, checksum };
}
