'use client';

import { useMemo, useState } from 'react';
import { Input, Select } from '@/components/ui/input';
import { ActionForm, Field } from '@/components/admin/action-form';
import { grantAccessAction } from '@/app/admin/_actions/access';
import type { CatalogSemester } from '@/lib/admin/catalog';

type Scope = 'ALL' | 'SEMESTER' | 'SUBJECT' | 'UNIT' | 'NOTE';

interface Props {
  catalog: CatalogSemester[];
  /** Set on a user's own page, where the student is already known. */
  fixedUser?: { id: string; label: string };
  students?: { id: string; name: string; email: string }[];
}

const SCOPE_HELP: Record<Scope, string> = {
  ALL: 'Access to every published note, including anything uploaded later.',
  SEMESTER: 'Every subject and note under one semester.',
  SUBJECT: 'Every note in one subject.',
  UNIT: 'Every note in one unit.',
  NOTE: 'A single note.',
};

/**
 * Builds a grant. The options here mirror the entitlement scopes exactly, so
 * what an admin sees is what the authorisation check will evaluate.
 */
export function GrantAccessForm({ catalog, fixedUser, students }: Props) {
  const [scope, setScope] = useState<Scope>('SUBJECT');
  const [targetId, setTargetId] = useState('');

  const options = useMemo(() => {
    if (scope === 'ALL') return [];

    const result: { value: string; label: string }[] = [];

    for (const semester of catalog) {
      if (scope === 'SEMESTER') {
        result.push({ value: semester.id, label: semester.name });
        continue;
      }
      for (const subject of semester.subjects) {
        if (scope === 'SUBJECT') {
          result.push({
            value: subject.id,
            label: `${semester.name} · ${subject.name}`,
          });
          continue;
        }
        for (const unit of subject.units) {
          if (scope === 'UNIT') {
            result.push({
              value: unit.id,
              label: `${subject.name} · Unit ${unit.index} — ${unit.name}`,
            });
            continue;
          }
          // One unit, one PDF — so a unit contributes at most one NOTE target,
          // and a unit still waiting for its upload contributes none.
          if (unit.note) {
            result.push({
              value: unit.note.id,
              label: `${subject.name} · Unit ${unit.index} — ${unit.name}`,
            });
          }
        }
        // Notes filed under the older model, with no unit. Nothing creates
        // these now, but they can still be granted individually.
        if (scope === 'NOTE') {
          for (const note of subject.looseNotes) {
            result.push({ value: note.id, label: `${subject.name} · ${note.title}` });
          }
        }
      }
    }

    return result;
  }, [catalog, scope]);

  return (
    <ActionForm
      action={grantAccessAction}
      submitLabel="Grant access"
      resetOnSuccess
      className="rounded-md border border-border p-4"
    >
      {fixedUser ? (
        <input type="hidden" name="userId" value={fixedUser.id} />
      ) : (
        <Field label="Student" htmlFor="userId">
          <Select id="userId" name="userId" required defaultValue="">
            <option value="" disabled>
              Choose a student
            </option>
            {(students ?? []).map((student) => (
              <option key={student.id} value={student.id}>
                {student.name} — {student.email}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Scope" htmlFor="scope" hint={SCOPE_HELP[scope]}>
          <Select
            id="scope"
            name="scope"
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as Scope);
              setTargetId('');
            }}
          >
            <option value="SUBJECT">Subject</option>
            <option value="SEMESTER">Semester</option>
            <option value="UNIT">Unit</option>
            <option value="NOTE">Single note</option>
            <option value="ALL">Everything</option>
          </Select>
        </Field>

        {scope !== 'ALL' && (
          <Field label="Target" htmlFor="targetId">
            <Select
              id="targetId"
              name="targetId"
              required
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
            >
              <option value="" disabled>
                {options.length === 0 ? 'Nothing available yet' : 'Choose one'}
              </option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Expires (optional)"
          htmlFor="expiresAt"
          hint="Leave empty for permanent access."
        >
          <Input id="expiresAt" name="expiresAt" type="date" />
        </Field>
        <Field label="Internal note (optional)" htmlFor="note">
          <Input id="note" name="note" placeholder="e.g. paid via UPI, trial access" />
        </Field>
      </div>
    </ActionForm>
  );
}
