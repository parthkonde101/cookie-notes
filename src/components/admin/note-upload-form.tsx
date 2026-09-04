'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileUp, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Alert } from '@/components/ui/feedback';
import { Field } from '@/components/admin/action-form';
import { formatBytes, cn } from '@/lib/utils';
import type { PlacementOption } from '@/lib/admin/catalog';

interface Props {
  placements: PlacementOption[];
  maxMb: number;
  currencySymbol: string;
  defaultSubjectId?: string;
  defaultUnitId?: string;
  onUploaded?: (noteId: string) => void;
}

/**
 * Upload flow: subject → unit → PDF.
 *
 * That is the whole form. There is no title to type — the note is named after
 * the unit — and no topic to pick, because a unit holds exactly one PDF. Picking
 * a unit that already has one is how you replace it: the form says so, and the
 * server keeps the old file as a version rather than creating a second note.
 *
 * With object storage configured the file goes browser → bucket with a
 * short-lived presigned URL, which avoids the few-megabyte request body limit
 * serverless platforms impose. With local storage it is posted through the app.
 * Either way the server validates the bytes before touching the database.
 */
export function NoteUploadForm({
  placements,
  maxMb,
  currencySymbol,
  defaultSubjectId,
  defaultUnitId,
  onUploaded,
}: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [subjectId, setSubjectId] = useState(defaultSubjectId ?? placements[0]?.subjectId ?? '');
  const [unitId, setUnitId] = useState(defaultUnitId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [pending, setPending] = useState(false);

  const selected = useMemo(
    () => placements.find((placement) => placement.subjectId === subjectId),
    [placements, subjectId],
  );
  const units = useMemo(() => selected?.units ?? [], [selected]);
  const unit = units.find((candidate) => candidate.id === unitId) ?? null;

  // A unit is required, so one is always selected when the subject has any.
  // Doing it here rather than in the change handler also covers the first
  // render and a catalogue that changed underneath us after a refresh.
  useEffect(() => {
    if (units.length === 0) {
      if (unitId !== '') setUnitId('');
      return;
    }
    if (!units.some((candidate) => candidate.id === unitId)) {
      setUnitId(units[0]!.id);
    }
  }, [units, unitId]);

  function pickFile(next: File | null) {
    setError(null);
    if (!next) {
      setFile(null);
      return;
    }
    if (next.type !== 'application/pdf' && !next.name.toLowerCase().endsWith('.pdf')) {
      setError('Only PDF files are supported right now.');
      return;
    }
    if (next.size > maxMb * 1024 * 1024) {
      setError(`That file is ${formatBytes(next.size)}. The limit is ${maxMb} MB.`);
      return;
    }
    setFile(next);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!file) {
      setError('Choose a PDF to upload.');
      return;
    }
    if (!unitId) {
      setError('Add a unit to this subject first — a PDF belongs to a unit.');
      return;
    }

    const formData = new FormData(event.currentTarget);
    setPending(true);

    try {
      // Ask the server how this upload should travel.
      const presignResponse = await fetch('/api/admin/uploads/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          contentType: 'application/pdf',
          size: file.size,
        }),
      });
      const presign = (await presignResponse.json()) as
        | { mode: 'proxy' }
        | { mode: 'direct'; key: string; url: string; headers: Record<string, string> };

      if (!presignResponse.ok) throw new Error('Could not start the upload. Please try again.');

      const payload = new FormData();
      for (const [key, value] of formData.entries()) {
        if (key !== 'file') payload.append(key, value);
      }

      if (presign.mode === 'direct') {
        setProgress(0);
        await putWithProgress(presign.url, file, presign.headers, setProgress);
        payload.append('storageKey', presign.key);
        payload.append('fileName', file.name);
      } else {
        payload.append('file', file);
      }

      const response = await fetch('/api/admin/notes', { method: 'POST', body: payload });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        noteId?: string;
        replaced?: boolean;
      };

      if (!response.ok) throw new Error(data.error ?? 'The upload failed.');

      toast.success(data.replaced ? 'PDF replaced.' : 'PDF uploaded.');
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      router.refresh();
      onUploaded?.(data.noteId ?? '');
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'The upload failed.');
    } finally {
      setPending(false);
      setProgress(null);
    }
  }

  if (placements.length === 0) {
    return (
      <Alert variant="warning" title="Create a subject first">
        Notes are filed under a subject. Add a semester and a subject, then come back.
      </Alert>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {error && <Alert variant="error">{error}</Alert>}

      <div
        className={cn(
          'rounded-lg border border-dashed border-border p-5 text-center transition-colors',
          file && 'border-primary/45 bg-primary/5',
        )}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          pickFile(event.dataTransfer.files?.[0] ?? null);
        }}
      >
        {file ? (
          <div className="flex items-center justify-center gap-3">
            <div className="min-w-0 text-left">
              <p className="truncate font-medium">{file.name}</p>
              <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              aria-label="Remove file"
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <>
            <FileUp className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">Drop a PDF here, or browse</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Up to {maxMb} MB</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => fileInputRef.current?.click()}
            >
              Choose file
            </Button>
          </>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          id="note-file"
          onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
        />
      </div>

      {progress !== null && (
        <div className="space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">Uploading… {progress}%</p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Subject" htmlFor="subjectId">
          <Select
            id="subjectId"
            name="subjectId"
            required
            value={subjectId}
            onChange={(event) => setSubjectId(event.target.value)}
          >
            {placements.map((placement) => (
              <option key={placement.subjectId} value={placement.subjectId}>
                {placement.subjectLabel}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Unit"
          htmlFor="unitId"
          hint={
            units.length === 0
              ? 'This subject has no units yet. Add one first.'
              : 'The PDF is filed here and takes the unit’s name.'
          }
        >
          <Select
            id="unitId"
            name="unitId"
            required
            value={unitId}
            disabled={units.length === 0}
            onChange={(event) => setUnitId(event.target.value)}
          >
            {units.length === 0 && <option value="">No units yet</option>}
            {units.map((option) => (
              <option key={option.id} value={option.id}>
                Unit {option.index} — {option.name}
                {option.hasNote ? ' (has a PDF)' : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {unit?.hasNote && (
        <Alert variant="warning" title="This unit already has a PDF">
          Uploading here replaces it. The current file is kept as an earlier version, and no second
          note is created.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Status" htmlFor="status">
          <Select id="status" name="status" defaultValue="PUBLISHED">
            <option value="PUBLISHED">Published</option>
            <option value="DRAFT">Draft — hidden from the catalogue</option>
          </Select>
        </Field>
        <Field
          label="Visibility"
          htmlFor="visibility"
          hint="Free notes open for any signed-in student."
        >
          <Select id="visibility" name="visibility" defaultValue="RESTRICTED">
            <option value="RESTRICTED">Restricted</option>
            <option value="FREE">Free</option>
          </Select>
        </Field>
        <Field
          label={`Price (${currencySymbol})`}
          htmlFor="price"
          hint="0 hides the price. Nothing is charged yet."
        >
          <Input id="price" name="price" type="number" min={0} step={1} defaultValue={0} />
        </Field>
      </div>

      <Button type="submit" size="lg" loading={pending} disabled={!file || units.length === 0}>
        {unit?.hasNote ? 'Replace PDF' : 'Upload PDF'}
      </Button>
    </form>
  );
}

/** XHR because fetch still has no upload progress events. */
function putWithProgress(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(describeStorageFailure(xhr.status, xhr.responseText)));
    xhr.onerror = () => reject(new Error(describeStorageFailure(xhr.status, '')));
    xhr.ontimeout = () => reject(new Error('The upload timed out before storage responded.'));
    xhr.send(file);
  });
}

/**
 * Turns a failed direct-to-storage PUT into something an operator can act on.
 *
 * The browser deliberately hides almost everything about a cross-origin failure,
 * so the two cases have to be told apart by shape: status 0 means no usable
 * response reached us at all (CORS rejection, DNS, TLS, offline), while any real
 * status means storage answered and its S3 error code says why.
 *
 * Only the `<Code>` element of the S3 error document is surfaced. The presigned
 * URL is never included in a message — it carries the signature and the access
 * key id.
 */
export function describeStorageFailure(status: number, body: string): string {
  if (status === 0) {
    return (
      'The upload could not reach storage (no response). This is usually the storage ' +
      "bucket's CORS rules not allowing PUT from this site's address — check that the " +
      'current site origin is in the allowed origins.'
    );
  }

  const code = /<Code>([^<]{1,64})<\/Code>/.exec(body)?.[1];

  const hint: Record<string, string> = {
    SignatureDoesNotMatch:
      'the storage credentials or region do not match the signature (R2 expects region "auto")',
    AccessDenied: 'the storage API token lacks write permission on this bucket',
    InvalidAccessKeyId: 'the storage access key id is not valid for this account',
    NoSuchBucket: 'the configured bucket does not exist at this endpoint',
    BadDigest: 'storage computed a different checksum for the uploaded bytes',
    InvalidRequest: 'storage rejected the request as malformed',
    RequestTimeTooSkewed: "the server clock is too far from storage's",
    EntityTooLarge: 'the file is larger than storage accepts',
  };

  if (code) {
    const because = hint[code];
    return `Storage rejected the upload (${status} ${code})${because ? ` — ${because}` : ''}.`;
  }
  return `Storage rejected the upload (${status}).`;
}
