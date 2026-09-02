'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface SeriesPoint {
  date: string;
  value: number;
}

const AXIS = 'hsl(var(--muted-foreground))';
const GRID = 'hsl(var(--border))';

function shortDate(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function ChartTooltip({
  active,
  payload,
  label,
  suffix,
}: {
  active?: boolean;
  payload?: { value?: number }[];
  label?: string;
  suffix: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="text-muted-foreground">{label ? shortDate(label) : ''}</p>
      <p className="mt-0.5 font-medium tabular-nums">
        {payload[0]?.value ?? 0} {suffix}
      </p>
    </div>
  );
}

/**
 * All series are dense (one point per day, zeros included), so a flat stretch
 * means "nothing happened", never "no data collected".
 */
export function TrendChart({
  data,
  suffix = '',
  color = 'hsl(var(--primary))',
  height = 200,
  variant = 'area',
}: {
  data: SeriesPoint[];
  suffix?: string;
  color?: string;
  height?: number;
  variant?: 'area' | 'bar';
}) {
  const empty = data.every((point) => point.value === 0);

  if (data.length === 0 || empty) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground"
        style={{ height }}
      >
        No activity recorded in this period yet
      </div>
    );
  }

  const gradientId = `grad-${color.replace(/[^a-z0-9]/gi, '')}`;

  return (
    <ResponsiveContainer width="100%" height={height}>
      {variant === 'bar' ? (
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -18 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={shortDate}
            stroke={AXIS}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: 'hsl(var(--muted) / 0.5)' }}
            content={<ChartTooltip suffix={suffix} />}
          />
          <Bar dataKey="value" fill={color} radius={[3, 3, 0, 0]} maxBarSize={28} />
        </BarChart>
      ) : (
        <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={shortDate}
            stroke={AXIS}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip
            cursor={{ stroke: GRID }}
            content={<ChartTooltip suffix={suffix} />}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            /* Mark days that actually had activity, so a single busy day in an
               otherwise quiet month is still visible. */
            dot={(props: { cx?: number; cy?: number; payload?: SeriesPoint; key?: string }) =>
              props.payload && props.payload.value > 0 ? (
                <circle
                  key={props.key ?? `${props.payload.date}`}
                  cx={props.cx}
                  cy={props.cy}
                  r={2.5}
                  fill={color}
                  stroke="hsl(var(--card))"
                  strokeWidth={1}
                />
              ) : (
                <g key={props.key ?? Math.random()} />
              )
            }
            activeDot={{ r: 4, strokeWidth: 0 }}
          />
        </AreaChart>
      )}
    </ResponsiveContainer>
  );
}
