'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileUp, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
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
 * Upload flow.
 *
 * With object storage configured the file goes browser → bucket with a
 * short-lived presigned URL, which avoids the few-megabyte request body limit
 * serverless platforms impose. With local storage it is posted through the app.
 * Either way the server validates the bytes before creating the note.
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
  const [topicId, setTopicId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [pending, setPending] = useState(false);

  const selected = useMemo(
    () => placements.find((placement) => placement.subjectId === subjectId),
    [placements, subjectId],
  );
  const units = selected?.units ?? [];
  const topics = units.find((unit) => unit.id === unitId)?.topics ?? [];

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
      const data = (await response.json().catch(() => ({}))) as { error?: string; noteId?: string };

      if (!response.ok) throw new Error(data.error ?? 'The upload failed.');

      toast.success('Note uploaded.');
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

      <Field label="Title" htmlFor="title">
        <Input id="title" name="title" required placeholder="Unit 2 — Decision Trees & SVM" />
      </Field>

      <Field label="Description" htmlFor="description" hint="Shown on the catalogue card.">
        <Textarea id="description" name="description" rows={2} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Subject" htmlFor="subjectId">
          <Select
            id="subjectId"
            name="subjectId"
            required
            value={subjectId}
            onChange={(event) => {
              setSubjectId(event.target.value);
              setUnitId('');
              setTopicId('');
            }}
          >
            {placements.map((placement) => (
              <option key={placement.subjectId} value={placement.subjectId}>
                {placement.subjectLabel}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Unit" htmlFor="unitId">
          <Select
            id="unitId"
            name="unitId"
            value={unitId}
            disabled={units.length === 0}
            onChange={(event) => {
              setUnitId(event.target.value);
              setTopicId('');
            }}
          >
            <option value="">None</option>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Topic" htmlFor="topicId">
          <Select
            id="topicId"
            name="topicId"
            value={topicId}
            disabled={topics.length === 0}
            onChange={(event) => setTopicId(event.target.value)}
          >
            <option value="">None</option>
            {topics.map((topic) => (
              <option key={topic.id} value={topic.id}>
                {topic.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

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

      <Button type="submit" size="lg" loading={pending} disabled={!file}>
        Upload note
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
        : reject(new Error(`Storage rejected the upload (${xhr.status}).`));
    xhr.onerror = () => reject(new Error('The upload connection failed.'));
    xhr.send(file);
  });
}
