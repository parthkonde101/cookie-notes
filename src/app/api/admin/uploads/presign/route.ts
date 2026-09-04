import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { Errors, toErrorResponse } from '@/lib/errors';
import { requireApiAdmin } from '@/lib/auth/guards';
import {
  buildCoverKey,
  buildNoteKey,
  isCoverMimeType,
  MAX_COVER_BYTES,
  storage,
} from '@/lib/storage/index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tells the admin UI how to upload.
 *
 * With S3-compatible storage the browser uploads straight to the bucket using a
 * short-lived presigned PUT — which is what makes large PDFs work on serverless
 * hosts, where the request body limit is only a few megabytes. With local
 * storage the file is posted through the app instead.
 *
 * The presigned URL is write-only, expires in minutes, and the object is still
 * validated server-side afterwards before any note row is created.
 */
export async function POST(request: NextRequest) {
  try {
    await requireApiAdmin();

    const body = (await request.json().catch(() => ({}))) as {
      fileName?: string;
      contentType?: string;
      size?: number;
      /** "note" (a PDF: a note or a PYQ) or "cover" (a subject notebook image). */
      kind?: string;
      subjectId?: string;
    };

    const kind = body.kind === 'cover' ? 'cover' : 'note';
    const contentType = body.contentType ?? 'application/pdf';

    // Two upload shapes, two rules. Everything else about the flow — presigned
    // PUT, private bucket, server-side validation afterwards — is identical.
    let key: string;
    let maxBytes: number;

    if (kind === 'cover') {
      if (!isCoverMimeType(contentType)) {
        throw Errors.validation('Covers must be a JPG, PNG or WebP image.');
      }
      if (!body.subjectId) throw Errors.validation('A cover needs a subject.');
      maxBytes = MAX_COVER_BYTES;
      if (typeof body.size === 'number' && body.size > maxBytes) {
        throw Errors.validation('Cover images must be 5 MB or smaller.');
      }
      key = buildCoverKey(body.subjectId, contentType);
    } else {
      if (!env.uploads.allowedMimeTypes.includes(contentType as 'application/pdf')) {
        throw Errors.validation('Only PDF files are supported right now.');
      }
      maxBytes = env.uploads.maxBytes;
      if (typeof body.size === 'number' && body.size > maxBytes) {
        throw Errors.validation(`Files must be ${env.uploads.maxMb} MB or smaller.`);
      }
      key = buildNoteKey(body.fileName ?? 'note.pdf');
    }

    const driver = storage();
    if (!driver.supportsDirectUpload || !driver.presignUpload) {
      return NextResponse.json({ mode: 'proxy' as const, maxBytes });
    }

    const url = await driver.presignUpload(key, contentType, 300);

    return NextResponse.json({
      mode: 'direct' as const,
      key,
      url,
      headers: { 'Content-Type': contentType },
      maxBytes,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
