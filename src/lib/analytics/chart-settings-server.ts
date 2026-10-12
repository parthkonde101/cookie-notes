import 'server-only';
import {
  parseCustom,
  parseMonths,
  parseOffset,
  parseRange,
  type CustomSpan,
  type StudyRange,
} from '@/lib/analytics/study';

/** The chart choices read back from the cookie, every value validated again. */
export interface ChartChoices {
  hours: { range: StudyRange; offset: number; custom: CustomSpan | null };
  subjects: { range: StudyRange; offset: number; custom: CustomSpan | null };
  activeMonths: number;
  registrationMonths: number;
}

const DEFAULTS: ChartChoices = {
  hours: { range: 'day', offset: 0, custom: null },
  subjects: { range: 'day', offset: 0, custom: null },
  activeMonths: 12,
  registrationMonths: 12,
};

function period(value: unknown): ChartChoices['hours'] {
  if (typeof value !== 'object' || value === null) return DEFAULTS.hours;
  const record = value as Record<string, unknown>;
  const custom = parseCustom(record.from, record.to);
  const wanted = parseRange(record.range);
  // A custom choice without both dates is not a choice: back to today.
  if (wanted === 'custom' && !custom) return DEFAULTS.hours;
  return {
    range: wanted,
    offset: wanted === 'custom' ? 0 : parseOffset(record.offset),
    custom: wanted === 'custom' ? custom : null,
  };
}

export function readChartChoices(raw: string | undefined): ChartChoices {
  if (!raw) return DEFAULTS;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
    const months = (key: string) => {
      const entry = parsed[key];
      return parseMonths(typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).months : undefined);
    };
    return {
      hours: period(parsed.hours),
      subjects: period(parsed.subjects),
      activeMonths: months('active'),
      registrationMonths: months('registrations'),
    };
  } catch {
    return DEFAULTS;
  }
}
