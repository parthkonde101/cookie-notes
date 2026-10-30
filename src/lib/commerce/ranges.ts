/**
 * Date ranges for the sales dashboard.
 *
 * "Today" is today on the STORE's clock (ANALYTICS_TIMEZONE, Asia/Kolkata by default), not on
 * the server's or the admin browser's: a sale at 11:50 pm in Pune belongs to that day however
 * the server is configured. Every range is a half-open interval [start, end) of real instants,
 * so a sale exactly at midnight belongs to exactly one day, never two and never none.
 *
 * Pure (no database, no environment), so the boundary rules can be tested directly.
 */

export type RangeKey = 'today' | '7d' | '30d' | 'month' | 'custom';

export interface SalesRange {
  key: RangeKey;
  label: string;
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
  /** For the custom form: the calendar days as typed, YYYY-MM-DD. */
  from: string;
  to: string;
}

interface Day {
  y: number;
  m: number;
  d: number;
}

/** A real calendar date in YYYY-MM-DD form, or null. */
export function parseDay(value: unknown): Day | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  if (y < 2000 || y > 2100) return null;
  return { y, m, d };
}

const pad = (n: number) => String(n).padStart(2, '0');
export const formatDay = (day: Day) => `${day.y}-${pad(day.m)}-${pad(day.d)}`;

export function addDays(day: Day, delta: number): Day {
  const moved = new Date(Date.UTC(day.y, day.m - 1, day.d + delta));
  return { y: moved.getUTCFullYear(), m: moved.getUTCMonth() + 1, d: moved.getUTCDate() };
}

/** Minutes east of UTC that `timeZone` is at the given instant. */
function offsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

/** The instant a calendar day begins on `timeZone`'s clock. */
export function startOfDay(day: Day, timeZone: string): Date {
  const guess = Date.UTC(day.y, day.m - 1, day.d);
  let start = guess - offsetMinutes(guess, timeZone) * 60_000;
  // Correct once more if the offset differs at the instant we landed on (a DST change).
  start = guess - offsetMinutes(start, timeZone) * 60_000;
  return new Date(start);
}

/** Today's calendar day on `timeZone`'s clock. */
export function today(now: Date, timeZone: string): Day {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

const MAX_SPAN_DAYS = 400;

export function resolveSalesRange(
  input: { range?: string | null; from?: string | null; to?: string | null },
  now: Date,
  timeZone: string,
): SalesRange {
  const t = today(now, timeZone);
  const make = (key: RangeKey, label: string, first: Day, last: Day): SalesRange => ({
    key,
    label,
    start: startOfDay(first, timeZone),
    end: startOfDay(addDays(last, 1), timeZone),
    from: formatDay(first),
    to: formatDay(last),
  });

  switch (input.range) {
    case 'today':
      return make('today', 'Today', t, t);
    case '7d':
      return make('7d', 'Last 7 days', addDays(t, -6), t);
    case 'month':
      return make('month', 'This month', { y: t.y, m: t.m, d: 1 }, t);
    case 'custom': {
      const from = parseDay(input.from);
      const to = parseDay(input.to);
      if (from && to) {
        const [first, last] = formatDay(from) <= formatDay(to) ? [from, to] : [to, from];
        const days = Math.round((Date.UTC(last.y, last.m - 1, last.d) - Date.UTC(first.y, first.m - 1, first.d)) / 86_400_000) + 1;
        if (days <= MAX_SPAN_DAYS) return make('custom', `${formatDay(first)} to ${formatDay(last)}`, first, last);
      }
      return make('30d', 'Last 30 days', addDays(t, -29), t);
    }
    case '30d':
    default:
      return make('30d', 'Last 30 days', addDays(t, -29), t);
  }
}
