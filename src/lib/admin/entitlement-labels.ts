import 'server-only';
import { prisma } from '@/lib/prisma';
import type { EntitlementScope } from '@/generated/prisma/enums';

export interface EntitlementRow {
  id: string;
  scope: EntitlementScope;
  targetKey: string;
}

export interface EntitlementLabel {
  /** What the grant covers, in words. */
  title: string;
  /** Where it sits, e.g. "Semester 6 · Machine Learning". */
  context: string | null;
  /** False when the target has since been deleted. */
  resolved: boolean;
}

/**
 * Turns `SUBJECT:abc123` into "Machine Learning / Semester 6" for the admin UI.
 * Batched by scope, so a user with fifty grants still costs four queries.
 */
export async function resolveEntitlementLabels(
  entitlements: EntitlementRow[],
): Promise<Map<string, EntitlementLabel>> {
  const byScope: Record<string, string[]> = { SEMESTER: [], SUBJECT: [], UNIT: [], NOTE: [] };

  for (const entitlement of entitlements) {
    const targetId = entitlement.targetKey.split(':').slice(1).join(':');
    if (entitlement.scope !== 'ALL' && targetId) byScope[entitlement.scope]?.push(targetId);
  }

  const [semesters, subjects, units, notes] = await Promise.all([
    byScope.SEMESTER.length
      ? prisma.semester.findMany({
          where: { id: { in: byScope.SEMESTER } },
          select: { id: true, name: true },
        })
      : [],
    byScope.SUBJECT.length
      ? prisma.subject.findMany({
          where: { id: { in: byScope.SUBJECT } },
          select: { id: true, name: true, semester: { select: { name: true } } },
        })
      : [],
    byScope.UNIT.length
      ? prisma.unit.findMany({
          where: { id: { in: byScope.UNIT } },
          select: {
            id: true,
            name: true,
            subject: { select: { name: true, semester: { select: { name: true } } } },
          },
        })
      : [],
    byScope.NOTE.length
      ? prisma.note.findMany({
          where: { id: { in: byScope.NOTE } },
          select: {
            id: true,
            title: true,
            subject: { select: { name: true, semester: { select: { name: true } } } },
          },
        })
      : [],
  ]);

  const semesterMap = new Map(semesters.map((row) => [row.id, row]));
  const subjectMap = new Map(subjects.map((row) => [row.id, row]));
  const unitMap = new Map(units.map((row) => [row.id, row]));
  const noteMap = new Map(notes.map((row) => [row.id, row]));

  const labels = new Map<string, EntitlementLabel>();

  for (const entitlement of entitlements) {
    const targetId = entitlement.targetKey.split(':').slice(1).join(':');

    if (entitlement.scope === 'ALL') {
      labels.set(entitlement.id, {
        title: 'Everything in the catalogue',
        context: 'Includes anything published later',
        resolved: true,
      });
      continue;
    }

    if (entitlement.scope === 'SEMESTER') {
      const row = semesterMap.get(targetId);
      labels.set(entitlement.id, {
        title: row?.name ?? 'Deleted semester',
        context: row ? 'All subjects and notes' : null,
        resolved: Boolean(row),
      });
      continue;
    }

    if (entitlement.scope === 'SUBJECT') {
      const row = subjectMap.get(targetId);
      labels.set(entitlement.id, {
        title: row?.name ?? 'Deleted subject',
        context: row?.semester.name ?? null,
        resolved: Boolean(row),
      });
      continue;
    }

    if (entitlement.scope === 'UNIT') {
      const row = unitMap.get(targetId);
      labels.set(entitlement.id, {
        title: row?.name ?? 'Deleted unit',
        context: row ? `${row.subject.semester.name} · ${row.subject.name}` : null,
        resolved: Boolean(row),
      });
      continue;
    }

    const row = noteMap.get(targetId);
    labels.set(entitlement.id, {
      title: row?.title ?? 'Deleted note',
      context: row ? `${row.subject.semester.name} · ${row.subject.name}` : null,
      resolved: Boolean(row),
    });
  }

  return labels;
}
