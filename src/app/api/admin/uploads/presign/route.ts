import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { Errors, toErrorResponse } from '@/lib/errors';
import { requireApiAdmin } from '@/lib/auth/guards';
import { buildNoteKey, storage } from '@/lib/storage/index';

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
    };

    const contentType = body.contentType ?? 'application/pdf';
    if (!env.uploads.allowedMimeTypes.includes(contentType as 'application/pdf')) {
      throw Errors.validation('Only PDF files are supported right now.');
    }
    if (typeof body.size === 'number' && body.size > env.uploads.maxBytes) {
      throw Errors.validation(`Files must be ${env.uploads.maxMb} MB or smaller.`);
    }

    const driver = storage();
    if (!driver.supportsDirectUpload || !driver.presignUpload) {
      return NextResponse.json({ mode: 'proxy' as const, maxBytes: env.uploads.maxBytes });
    }

    const key = buildNoteKey(body.fileName ?? 'note.pdf');
    const url = await driver.presignUpload(key, contentType, 300);

    return NextResponse.json({
      mode: 'direct' as const,
      key,
      url,
      headers: { 'Content-Type': contentType },
      maxBytes: env.uploads.maxBytes,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
