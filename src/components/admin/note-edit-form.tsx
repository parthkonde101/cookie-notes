'use client';

import { useMemo, useState } from 'react';
import { Input, Select, Textarea } from '@/components/ui/input';
import { ActionForm, Field } from '@/components/admin/action-form';
import { updateNoteAction } from '@/app/admin/_actions/notes';
import type { CatalogSemester } from '@/lib/admin/catalog';

interface Props {
  noteId: string;
  catalog: CatalogSemester[];
  currencySymbol: string;
  initial: {
    title: string;
    description: string;
    subjectId: string;
    unitId: string;
    status: string;
    visibility: string;
    price: number;
  };
}

/**
 * The detail screen for one note.
 *
 * Uploading is subject → unit → PDF and nothing else; this screen is where an
 * existing note is corrected — moved to a different unit, taken off the
 * catalogue, repriced. The title is still editable because notes filed under the
 * older model carry their own, but a note that lives in a unit is named after
 * that unit and normally needs no attention here.
 */
export function NoteEditForm({ noteId, catalog, currencySymbol, initial }: Props) {
  const [subjectId, setSubjectId] = useState(initial.subjectId);
  const [unitId, setUnitId] = useState(initial.unitId);

  const subjects = useMemo(
    () =>
      catalog.flatMap((semester) =>
        semester.subjects.map((subject) => ({
          id: subject.id,
          label: `${semester.name} · ${subject.name}`,
          units: subject.units,
        })),
      ),
    [catalog],
  );

  const units = subjects.find((subject) => subject.id === subjectId)?.units ?? [];

  return (
    <ActionForm action={updateNoteAction.bind(null, noteId)} submitLabel="Save changes">
      <Field label="Title" htmlFor="title">
        <Input id="title" name="title" defaultValue={initial.title} required />
      </Field>

      <Field label="Description" htmlFor="description">
        <Textarea id="description" name="description" rows={3} defaultValue={initial.description} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Subject" htmlFor="subjectId">
          <Select
            id="subjectId"
            name="subjectId"
            value={subjectId}
            onChange={(event) => {
              setSubjectId(event.target.value);
              setUnitId('');
            }}
          >
            {subjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Unit"
          htmlFor="unitId"
          hint="A unit holds one PDF. Units that already have one are marked."
        >
          <Select
            id="unitId"
            name="unitId"
            value={unitId}
            disabled={units.length === 0}
            onChange={(event) => setUnitId(event.target.value)}
          >
            <option value="">None</option>
            {units.map((unit) => (
              <option
                key={unit.id}
                value={unit.id}
                // Moving into an occupied unit would violate the one-PDF rule,
                // so the option is shown (for context) but cannot be chosen.
                // The note already in this unit is of course still selectable.
                disabled={unit.note !== null && unit.note.id !== noteId}
              >
                Unit {unit.index} — {unit.name}
                {unit.note !== null && unit.note.id !== noteId ? ' (has a PDF)' : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Status" htmlFor="status">
          <Select id="status" name="status" defaultValue={initial.status}>
            <option value="PUBLISHED">Published</option>
            <option value="DRAFT">Draft — hidden from the catalogue</option>
            <option value="ARCHIVED">Archived</option>
          </Select>
        </Field>
        <Field label="Visibility" htmlFor="visibility">
          <Select id="visibility" name="visibility" defaultValue={initial.visibility}>
            <option value="RESTRICTED">Restricted — grant required</option>
            <option value="FREE">Free for all students</option>
          </Select>
        </Field>
        <Field
          label={`Price (${currencySymbol})`}
          htmlFor="price"
          hint="0 hides the price. Nothing is charged yet."
        >
          <Input id="price" name="price" type="number" min={0} step={1} defaultValue={initial.price} />
        </Field>
      </div>
    </ActionForm>
  );
}
