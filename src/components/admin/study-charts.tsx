'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { HoursResult, MonthlyResult, StudyRange, SubjectsResult } from '@/lib/analytics/study';
import { saveChartSetting } from '@/lib/analytics/chart-settings';

const AXIS = 'hsl(var(--muted-foreground))';
const GRID = 'hsl(var(--border))';

const RANGES: { value: StudyRange; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'custom', label: 'Custom' },
];

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** A YYYY-MM-DD calendar day, formatted without any time-zone shifting. */
function day(value: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
}

/** Moves a YYYY-MM-DD date by whole days, without time zones getting in the way. */
function addDays(value: string, days: number): string {
  return new Date(new Date(`${value}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

function periodLabel(result: { range: StudyRange; offset: number; from: string; to: string; today: string }): string {
  const { range, offset, from, to, today } = result;
  if (range === 'custom') {
    const sameYear = from.slice(0, 4) === today.slice(0, 4) && to.slice(0, 4) === today.slice(0, 4);
    const withYear = sameYear ? {} : { year: 'numeric' as const };
    if (from === to) return day(from, { weekday: 'short', day: 'numeric', month: 'short', ...withYear });
    return `${day(from, { day: 'numeric', month: 'short', ...withYear })} – ${day(to, { day: 'numeric', month: 'short', ...withYear })}`;
  }
  if (range === 'day') {
    if (offset === 0) return 'Today';
    if (offset === -1) return 'Yesterday';
    return day(from, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  if (range === 'week') {
    if (offset === 0) return 'This week';
    if (offset === -1) return 'Last week';
    const sameMonth = from.slice(0, 7) === to.slice(0, 7);
    return sameMonth
      ? `${day(from, { day: 'numeric' })} – ${day(to, { day: 'numeric', month: 'short' })}`
      : `${day(from, { day: 'numeric', month: 'short' })} – ${day(to, { day: 'numeric', month: 'short' })}`;
  }
  if (offset === 0) return 'This month';
  return day(from, { month: 'long', year: today.slice(0, 4) === from.slice(0, 4) ? undefined : 'numeric' });
}

function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? 'AM' : 'PM'}`;
}

const PERIOD_WORD: Record<StudyRange, string> = { day: 'day', week: 'week', month: 'month', custom: 'period' };

// ---------------------------------------------------------------------------
// The card: a period selector, back/forward arrows, and whatever chart goes inside
// ---------------------------------------------------------------------------

type Window = { range: StudyRange; offset: number; from: string; to: string; today: string; hasEarlier: boolean; hasLater: boolean };

function PeriodCard<T extends Window>({
  chart,
  title,
  describe,
  initial,
  children,
}: {
  chart: 'hours' | 'subjects';
  title: string;
  describe: (data: T) => string;
  initial: T;
  children: (data: T) => React.ReactNode;
}) {
  const [range, setRange] = useState<StudyRange>(initial.range);
  const [offset, setOffset] = useState(initial.offset);
  // The span used when the range is Custom: the last seven days until the admin picks their own.
  const [custom, setCustom] = useState(
    initial.range === 'custom' ? { from: initial.from, to: initial.to } : { from: addDays(initial.today, -6), to: initial.today },
  );
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef(true);

  useEffect(() => {
    // The server already supplied the current day; only fetch once the choice changes.
    if (first.current) {
      first.current = false;
      return;
    }
    // A custom span is only fetched once both dates are real and in order.
    if (range === 'custom' && !(isDate(custom.from) && isDate(custom.to) && custom.from <= custom.to)) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const query =
      range === 'custom'
        ? `range=custom&from=${custom.from}&to=${custom.to}`
        : `range=${range}&offset=${offset}`;
    fetch(`/api/admin/analytics/study?chart=${chart}&${query}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load this period.');
        setData((await response.json()) as T);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setError(reason instanceof Error ? reason.message : 'Could not load this period.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [chart, range, offset, custom.from, custom.to]);

  // Remember the choice, so the chart is as it was left until it is changed again.
  useEffect(() => {
    if (range === 'custom') {
      if (isDate(custom.from) && isDate(custom.to) && custom.from <= custom.to) {
        saveChartSetting(chart, { range, offset: 0, from: custom.from, to: custom.to });
      }
    } else {
      saveChartSetting(chart, { range, offset });
    }
  }, [chart, range, offset, custom.from, custom.to]);

  const word = PERIOD_WORD[range];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{title}</CardTitle>
            <CardDescription className="mt-1.5">{describe(data)}</CardDescription>
          </div>

          <div role="group" aria-label={`${title} period`} className="flex items-center gap-1 rounded-md border border-border p-0.5">
            {RANGES.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={range === option.value}
                onClick={() => {
                  setRange(option.value);
                  setOffset(0);
                }}
                className={cn(
                  'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  range === option.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {range === 'custom' ? (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap items-end gap-3">
              {(['from', 'to'] as const).map((edge) => (
                <label key={edge} className="text-xs text-muted-foreground">
                  {edge === 'from' ? 'From' : 'To'}
                  <input
                    type="date"
                    value={custom[edge]}
                    max={data.today}
                    onChange={(event) => {
                      const value = event.target.value;
                      setCustom((previous) => {
                        const next = { ...previous, [edge]: value };
                        // Keep the span in order: moving one end past the other drags the other along.
                        if (isDate(value) && edge === 'from' && isDate(previous.to) && value > previous.to) next.to = value;
                        if (isDate(value) && edge === 'to' && isDate(previous.from) && value < previous.from) next.from = value;
                        return next;
                      });
                    }}
                    className="mt-1 block rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground [color-scheme:dark]"
                  />
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              <span className="font-medium text-foreground">{periodLabel(data)}</span> · pick the same date in both boxes
              for a single day, hour by hour. A span can be up to a year.
            </p>
          </div>
        ) : (
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              aria-label={`Previous ${word}`}
              disabled={!data.hasEarlier || loading}
              onClick={() => setOffset((value) => value - 1)}
              className="flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronLeft className="size-4" />
            </button>
            <p className="text-sm font-medium tabular-nums" aria-live="polite">
              {periodLabel(data)}
            </p>
            <button
              type="button"
              aria-label={`Next ${word}`}
              disabled={!data.hasLater || loading}
              onClick={() => setOffset((value) => Math.min(0, value + 1))}
              className="flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        )}
      </CardHeader>

      <CardContent>
        {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
        <div className={cn('transition-opacity', loading && 'opacity-50')}>{children(data)}</div>
      </CardContent>
    </Card>
  );
}

function Empty({ height }: { height: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground"
      style={{ height }}
    >
      Nobody read a note in this period
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart 1 — when students study
// ---------------------------------------------------------------------------

function plural(count: number, word = 'student'): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function StudyHoursCard({ initial }: { initial: HoursResult }) {
  return (
    <PeriodCard<HoursResult>
      chart="hours"
      title="When students study"
      initial={initial}
      describe={(data) =>
        data.dayPoints.length === 0
          ? `Students reading in each hour · ${data.timezone}`
          : `Students who studied on each day · ${data.timezone}`
      }
    >
      {(data) => {
        // One day (a Day, or a custom span of a single date) is shown hour by hour; longer spans day by day.
        const byDay = data.dayPoints.length > 0;
        const dayRows = data.dayPoints.map((point) => ({
          ...point,
          label:
            data.range === 'week'
              ? day(point.date, { weekday: 'short' })
              : data.range === 'custom'
                ? day(point.date, { day: 'numeric', month: 'short' })
                : String(Number(point.date.slice(8))),
          full: day(point.date, { weekday: 'short', day: 'numeric', month: 'short' }),
        }));

        return (
          <>
            {data.students === 0 ? (
              <Empty height={220} />
            ) : byDay ? (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={dayRows} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="label"
                    interval={data.range === 'week' ? 0 : 'preserveStartEnd'}
                    minTickGap={data.range === 'week' ? 0 : 12}
                    stroke={AXIS}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip
                    cursor={{ stroke: GRID }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const row = payload[0]?.payload as (typeof dayRows)[number];
                      if (row.value === null) return null;
                      return (
                        <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg">
                          <p className="text-muted-foreground">{row.full}</p>
                          <p className="mt-0.5 font-medium tabular-nums">{plural(row.value)} studied</p>
                          {row.value > 0 && (
                            <p className="text-muted-foreground">
                              {row.atOnce} at once
                              {row.peakHour !== null ? `, around ${hourLabel(row.peakHour)}` : ''}
                            </p>
                          )}
                        </div>
                      );
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={{ r: 2.5 }}
                    activeDot={{ r: 4 }}
                    connectNulls={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={data.points} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="hour"
                    type="number"
                    domain={[0, 23]}
                    ticks={[0, 3, 6, 9, 12, 15, 18, 21]}
                    tickFormatter={hourLabel}
                    stroke={AXIS}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip
                    cursor={{ stroke: GRID }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const point = payload[0]?.payload as { hour: number; value: number };
                      return (
                        <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg">
                          <p className="text-muted-foreground">
                            {hourLabel(point.hour)} – {hourLabel((point.hour + 1) % 24)}
                          </p>
                          <p className="mt-0.5 font-medium tabular-nums">{plural(point.value)}</p>
                        </div>
                      );
                    }}
                  />
                  <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {data.students === 0
                ? 'No reading recorded.'
                : byDay
                  ? data.peakDay
                    ? `Busiest day: ${day(data.peakDay.date, { weekday: 'short', day: 'numeric', month: 'short' })} — ${plural(data.peakDay.value ?? 0)} studied (${data.peakDay.atOnce} at once${
                        data.peakDay.peakHour === null ? '' : `, around ${hourLabel(data.peakDay.peakHour)}`
                      }). ${plural(data.students)} read in this ${PERIOD_WORD[data.range]}.`
                    : `${plural(data.students)} read in this ${PERIOD_WORD[data.range]}.`
                  : `${plural(data.students)} read ${data.from === data.today ? 'today' : 'that day'}${
                      data.peakHour === null
                        ? ''
                        : ` · busiest around ${hourLabel(data.peakHour)} (${plural(
                            data.points.find((point) => point.hour === data.peakHour)?.value ?? 0,
                          )})`
                    }.`}
            </p>
          </>
        );
      }}
    </PeriodCard>
  );
}

// ---------------------------------------------------------------------------
// Chart 2 — students per subject
// ---------------------------------------------------------------------------

/** Splits a subject name into at most two lines on word boundaries, so a long name is shown in full. */
function wrapName(name: string, width = 24): string[] {
  const words = name.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && `${current} ${word}`.length > width && lines.length < 1) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  lines.push(current);
  return lines;
}

/** A Y-axis label that carries the subject's real name, wrapped rather than cut. */
function SubjectTick({ x, y, payload }: { x?: number; y?: number; payload?: { value: string } }) {
  const lines = wrapName(payload?.value ?? '');
  return (
    <text x={(x ?? 0) - 6} y={y} textAnchor="end" fill={AXIS} fontSize={11}>
      {lines.map((line, index) => (
        <tspan key={index} x={(x ?? 0) - 6} dy={index === 0 ? (lines.length > 1 ? '-0.2em' : '0.35em') : '1.2em'}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

export function StudySubjectsCard({ initial }: { initial: SubjectsResult }) {
  return (
    <PeriodCard<SubjectsResult>
      chart="subjects"
      title="Students per subject"
      initial={initial}
      describe={() => 'Different students who opened a note in each subject'}
    >
      {(data) => {
        const rows = data.subjects.map((subject) => ({
          label: subject.name,
          name: subject.name,
          students: subject.students,
        }));
        const height = Math.max(220, rows.length * 44 + 24);
        return (
          <>
            {rows.length === 0 ? (
              <Empty height={220} />
            ) : (
              <ResponsiveContainer width="100%" height={height}>
                <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID} strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="label" width={170} tick={<SubjectTick />} tickLine={false} axisLine={false} interval={0} />
                  <Tooltip
                    cursor={{ fill: 'hsl(var(--muted) / 0.5)' }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const row = payload[0]?.payload as { name: string; students: number };
                      return (
                        <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg">
                          <p className="text-muted-foreground">{row.name}</p>
                          <p className="mt-0.5 font-medium tabular-nums">
                            {row.students} {row.students === 1 ? 'student' : 'students'}
                          </p>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="students" fill="hsl(var(--primary))" radius={[0, 3, 3, 0]} maxBarSize={20} />
                </BarChart>
              </ResponsiveContainer>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {data.students === 0
                ? 'No reading recorded.'
                : `${data.students} ${data.students === 1 ? 'student' : 'students'} read in this period${
                    data.subjects.length >= 12 ? ' · top 12 subjects shown' : ''
                  }. A student who read two subjects counts in both.`}
            </p>
          </>
        );
      }}
    </PeriodCard>
  );
}

// ---------------------------------------------------------------------------
// Charts 3 and 4 — month by month: students using the notes, and registrations
// ---------------------------------------------------------------------------

const MONTH_CHOICES = [6, 12, 24] as const;

function monthLabel(month: string, long = false): string {
  const date = new Date(`${month}-01T12:00:00Z`);
  return date.toLocaleDateString('en-GB', {
    month: long ? 'long' : 'short',
    ...(long ? {} : { year: '2-digit' }),
    timeZone: 'UTC',
  });
}

function MonthlyTrendCard({
  chart,
  title,
  description,
  initial,
  unit,
  summarise,
}: {
  chart: 'active' | 'registrations';
  title: string;
  description: string;
  initial: MonthlyResult;
  /** What the figure counts, for the tooltip ("students used the notes" / "new students"). */
  unit: string;
  summarise: (points: MonthlyResult['points']) => string;
}) {
  const [months, setMonths] = useState(initial.months);
  const [data, setData] = useState<MonthlyResult>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef(true);

  useEffect(() => {
    saveChartSetting(chart, { months });
    if (first.current) {
      first.current = false;
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/admin/analytics/study?chart=${chart}&months=${months}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load this chart.');
        setData((await response.json()) as MonthlyResult);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setError(reason instanceof Error ? reason.message : 'Could not load this chart.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [chart, months]);

  // Registrations are drawn as the running total of students, so the line rises as the
  // platform grows; how many joined in a month rides along for the tooltip.
  const cumulative = chart === 'registrations';
  const rows = data.points.map((point) => ({
    ...point,
    label: monthLabel(point.month),
    value: cumulative ? (point.total ?? 0) : point.value,
    joined: point.value,
  }));
  const empty = rows.every((row) => row.value === 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{title}</CardTitle>
            <CardDescription className="mt-1.5">
              {description} · {data.timezone}
            </CardDescription>
          </div>
          <div role="group" aria-label={`${title} months`} className="flex items-center gap-1 rounded-md border border-border p-0.5">
            {MONTH_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                aria-pressed={months === choice}
                onClick={() => setMonths(choice)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  months === choice ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {`${choice} months`}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
        <div className={cn('transition-opacity', loading && 'opacity-50')}>
          {empty ? (
            <Empty height={220} />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" interval="preserveStartEnd" minTickGap={16} stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip
                  cursor={{ stroke: GRID }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload[0]?.payload as (typeof rows)[number];
                    const index = rows.indexOf(row);
                    const before = index > 0 ? rows[index - 1] : null;
                    const change = before && !row.partial ? row.value - before.value : null;
                    return (
                      <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg">
                        <p className="text-muted-foreground">
                          {monthLabel(row.month, true)}
                          {row.partial ? ' (so far)' : ''}
                        </p>
                        <p className="mt-0.5 font-medium tabular-nums">
                          {row.value} {unit}
                        </p>
                        {cumulative ? (
                          <p className="text-muted-foreground">
                            {row.joined === 0 ? 'nobody joined' : `+${row.joined} joined`}
                            {row.partial ? ' so far' : ' this month'}
                          </p>
                        ) : (
                          change !== null && (
                            <p className="text-muted-foreground">
                              {change === 0 ? 'no change' : `${change > 0 ? '+' : ''}${change}`} on the month before
                            </p>
                          )
                        )}
                      </div>
                    );
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={{ r: 2.5 }}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{summarise(data.points)}</p>
      </CardContent>
    </Card>
  );
}

/** "up 12% on August", "down 4 on August", "the same as August" — for the last finished month. */
function trendSentence(points: MonthlyResult['points'], noun: string): string {
  const finished = points.filter((point) => !point.partial);
  const current = points.find((point) => point.partial);
  const last = finished[finished.length - 1];
  const before = finished[finished.length - 2];
  const parts: string[] = [];
  if (last && before) {
    const change = last.value - before.value;
    const percent = before.value > 0 ? ` (${change > 0 ? '+' : ''}${Math.round((change / before.value) * 100)}%)` : '';
    parts.push(
      `${monthLabel(last.month, true)}: ${plural(last.value, noun)}, ${
        change === 0 ? `the same as ${monthLabel(before.month, true)}` : `${change > 0 ? 'up' : 'down'} ${Math.abs(change)} on ${monthLabel(before.month, true)}${percent}`
      }.`,
    );
  } else if (last) {
    parts.push(`${monthLabel(last.month, true)}: ${plural(last.value, noun)}.`);
  }
  if (current) parts.push(`${monthLabel(current.month, true)} so far: ${current.value}.`);
  return parts.join(' ') || 'Nothing recorded yet.';
}

export function ActiveStudentsByMonthCard({ initial }: { initial: MonthlyResult }) {
  return (
    <MonthlyTrendCard
      chart="active"
      title="Active students by month"
      description="Different students who opened a note in each month"
      initial={initial}
      unit="students used the notes"
      summarise={(points) => trendSentence(points, 'active student')}
    />
  );
}

/** The running-total line: "September: 338 students in total, up 22 on August (+7%). October so far: 348 (+10)." */
function totalSentence(points: MonthlyResult['points']): string {
  const finished = points.filter((point) => !point.partial);
  const current = points.find((point) => point.partial);
  const last = finished[finished.length - 1];
  const before = finished[finished.length - 2];
  const parts: string[] = [];
  if (last) {
    const total = last.total ?? 0;
    if (before) {
      const gained = total - (before.total ?? 0);
      const percent = (before.total ?? 0) > 0 ? ` (${gained > 0 ? '+' : ''}${Math.round((gained / (before.total ?? 1)) * 100)}%)` : '';
      parts.push(
        `${monthLabel(last.month, true)}: ${plural(total, 'student')} in total, ${
          gained === 0 ? `the same as ${monthLabel(before.month, true)}` : `up ${gained} on ${monthLabel(before.month, true)}${percent}`
        }.`,
      );
    } else {
      parts.push(`${monthLabel(last.month, true)}: ${plural(total, 'student')} in total.`);
    }
  }
  if (current) {
    parts.push(
      `${monthLabel(current.month, true)} so far: ${current.total ?? 0}${current.value > 0 ? ` (+${current.value})` : ''}.`,
    );
  }
  return parts.join(' ') || 'Nobody has registered yet.';
}

export function RegistrationsByMonthCard({ initial }: { initial: MonthlyResult }) {
  return (
    <MonthlyTrendCard
      chart="registrations"
      title="Total registrations by month"
      description="All registered students at the end of each month"
      initial={initial}
      unit="students in total"
      summarise={totalSentence}
    />
  );
}
