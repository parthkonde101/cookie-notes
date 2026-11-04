import { describeStorageFailure } from '@/components/admin/note-upload-form';
import { formatBytes } from '@/lib/utils';

export const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const COVER_MAX_BYTES = 5 * 1024 * 1024;

/** What the cover belongs to: a subject's notebook, or a bundle. */
export type CoverTarget = { kind: 'subject' | 'bundle'; id: string };

/**
 * Uploads a cover image from the browser and tells the server to adopt it.
 *
 * With S3-compatible storage the image goes straight to the bucket on a short-lived presigned URL
 * (so size is not limited by the host's request-body cap); with local storage it is posted through
 * the app. Either way the server re-reads and validates the bytes before it writes anything, so the
 * checks here are for a quick, friendly refusal and are not what keeps the bucket clean.
 *
 * Resolves with the new version stamp; throws an `Error` whose message is fit to show an admin.
 */
export async function uploadCoverImage(file: File, target: CoverTarget): Promise<{ updatedAt: number }> {
  if (!COVER_TYPES.includes(file.type)) throw new Error('Covers must be a JPG, PNG or WebP image.');
  if (file.size > COVER_MAX_BYTES) {
    throw new Error(`That image is ${formatBytes(file.size)}. The limit is 5 MB.`);
  }

  const presignResponse = await fetch('/api/admin/uploads/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'cover',
      ...(target.kind === 'bundle' ? { bundleId: target.id } : { subjectId: target.id }),
      fileName: file.name,
      contentType: file.type,
      size: file.size,
    }),
  });
  const presign = (await presignResponse.json()) as
    | { mode: 'proxy' }
    | { mode: 'direct'; key: string; url: string; headers: Record<string, string> }
    | { error?: string };

  if (!presignResponse.ok) {
    throw new Error(('error' in presign && presign.error) || 'Could not start the upload. Please try again.');
  }

  const payload = new FormData();
  if ('mode' in presign && presign.mode === 'direct') {
    const put = await fetch(presign.url, { method: 'PUT', headers: presign.headers, body: file }).catch(() => null);
    if (!put) throw new Error(describeStorageFailure(0, ''));
    if (!put.ok) throw new Error(describeStorageFailure(put.status, await put.text().catch(() => '')));
    payload.append('storageKey', presign.key);
  } else {
    payload.append('file', file);
  }

  const response = await fetch(`/api/admin/${target.kind === 'bundle' ? 'bundles' : 'subjects'}/${target.id}/cover`, {
    method: 'POST',
    body: payload,
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string; updatedAt?: number };
  if (!response.ok) throw new Error(data.error ?? 'The cover could not be saved.');
  return { updatedAt: data.updatedAt ?? Date.now() };
}
