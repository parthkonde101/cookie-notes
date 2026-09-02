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
    topicId: string;
    status: string;
    visibility: string;
    price: number;
  };
}

export function NoteEditForm({ noteId, catalog, currencySymbol, initial }: Props) {
  const [subjectId, setSubjectId] = useState(initial.subjectId);
  const [unitId, setUnitId] = useState(initial.unitId);
  const [topicId, setTopicId] = useState(initial.topicId);

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
  const topics = units.find((unit) => unit.id === unitId)?.topics ?? [];

  return (
    <ActionForm action={updateNoteAction.bind(null, noteId)} submitLabel="Save changes">
      <Field label="Title" htmlFor="title">
        <Input id="title" name="title" defaultValue={initial.title} required />
      </Field>

      <Field label="Description" htmlFor="description">
        <Textarea id="description" name="description" rows={3} defaultValue={initial.description} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Subject" htmlFor="subjectId">
          <Select
            id="subjectId"
            name="subjectId"
            value={subjectId}
            onChange={(event) => {
              setSubjectId(event.target.value);
              setUnitId('');
              setTopicId('');
            }}
          >
            {subjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.label}
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
