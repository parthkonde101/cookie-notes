import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiAdmin } from '@/lib/auth/guards';
import { buildNoteKey, looksLikePdf, storage } from '@/lib/storage/index';
import { inspectPdf } from '@/lib/notes/pdf-meta';
import { recordEvent } from '@/lib/analytics/events';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** A paper older than this is almost certainly a typo, not an archive. */
const EARLIEST_YEAR = 1970;

/**
 * Creates or replaces a subject's previous-year paper for a given year.
 *
 * Uses the same two upload shapes as notes — a presigned direct PUT, or a
 * proxied post for the local driver — and the same rule that the server reads
 * the object back out of storage to validate it rather than trusting anything
 * the client says.
 *
 * Because a subject may have only one paper per year, posting a year that
 * already exists *replaces* it: the row is updated and the superseded file is
 * deleted. That makes "replace the 2024 paper" the natural action rather than a
 * separate endpoint.
 */
export async function POST(request: NextRequest) {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = contextFromHeaders(request.headers);

    const form = await request.formData();
    const subjectId = String(form.get('subjectId') ?? '');
    const yearRaw = String(form.get('year') ?? '');
    const label = String(form.get('label') ?? '').trim().slice(0, 120) || null;

    const year = Number.parseInt(yearRaw, 10);
    const nextYear = new Date().getUTCFullYear() + 1;
    if (!Number.isInteger(year) || year < EARLIEST_YEAR || year > nextYear) {
      throw Errors.validation(`Choose a year between ${EARLIEST_YEAR} and ${nextYear}.`);
    }

    const subject = await prisma.subject.findUnique({
      where: { id: subjectId },
      select: { id: true, name: true },
    });
    if (!subject) throw Errors.validation('Choose a valid subject.');

    const driver = storage();
    const uploadedKey = String(form.get('storageKey') ?? '');
    const file = form.get('file');

    let storageKey: string;
    let fileName: string;
    let fileSize: number;
    let checksum: string | null = null;
    let pageCount: number | null = null;

    if (uploadedKey) {
      // --- direct-to-storage upload ---
      if (!uploadedKey.startsWith('notes/')) throw Errors.validation('Invalid upload reference.');

      const head = await driver.head(uploadedKey);
      if (!head) throw Errors.validation('The upload did not complete. Please try again.');
      if (head.size > env.uploads.maxBytes) {
        await driver.delete(uploadedKey);
        throw Errors.validation(`Files must be ${env.uploads.maxMb} MB or smaller.`);
      }

      const header = await driver.getRange(uploadedKey, 0, 1023);
      if (!looksLikePdf(header)) {
        await driver.delete(uploadedKey);
        throw Errors.validation('That file is not a valid PDF.');
      }

      storageKey = uploadedKey;
      fileSize = head.size;
      fileName = String(form.get('fileName') ?? `${year}.pdf`).slice(0, 200);
    } else {
      // --- proxied upload ---
      if (!(file instanceof File)) throw Errors.validation('Choose a PDF file to upload.');
      if (file.size === 0) throw Errors.validation('That file is empty.');
      if (file.size > env.uploads.maxBytes) {
        throw Errors.validation(`Files must be ${env.uploads.maxMb} MB or smaller.`);
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const inspection = inspectPdf(buffer);
      if (!inspection.valid) throw Errors.validation(inspection.reason ?? 'Invalid PDF.');

      storageKey = buildNoteKey(file.name);
      await driver.put(storageKey, buffer, 'application/pdf');

      fileName = file.name.slice(0, 200);
      fileSize = buffer.byteLength;
      checksum = inspection.checksum;
      pageCount = inspection.pageCount;
    }

    const existing = await prisma.pyq.findUnique({
      where: { subjectId_year: { subjectId: subject.id, year } },
      select: { id: true, storageKey: true },
    });

    const pyq = await prisma.pyq.upsert({
      where: { subjectId_year: { subjectId: subject.id, year } },
      create: {
        subjectId: subject.id,
        year,
        label,
        storageKey,
        fileName,
        fileSize,
        checksum,
        pageCount,
        uploadedById: admin.id,
      },
      update: { label, storageKey, fileName, fileSize, checksum, pageCount },
      select: { id: true, year: true },
    });

    // Only once the row points at the new object.
    if (existing && existing.storageKey !== storageKey) {
      await driver.delete(existing.storageKey).catch(() => undefined);
    }

    const replaced = Boolean(existing);
    await writeAudit({
      action: replaced ? 'PYQ_REPLACED' : 'PYQ_UPLOADED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'pyq',
      targetId: pyq.id,
      targetLabel: `${subject.name} — ${year}`,
      metadata: { fileName, fileSize, year },
      ctx,
    });
    await recordEvent({
      type: replaced ? 'PYQ_REPLACED' : 'PYQ_UPLOADED',
      userId: admin.id,
      subjectId: subject.id,
      ctx,
      metadata: { pyqId: pyq.id, year, fileSize },
    });

    return NextResponse.json({ ok: true, pyqId: pyq.id, year, replaced }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
