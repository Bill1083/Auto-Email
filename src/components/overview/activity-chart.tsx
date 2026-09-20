'use client';

import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { DaySeries } from '@/lib/stats';

/** Fixed series order and colours: the entity owns its hue, never its rank. */
const SERIES = [
  { key: 'kept', label: 'Kept', color: 'var(--chart-kept)' },
  { key: 'trashed', label: 'Trashed', color: 'var(--chart-trashed)' },
  { key: 'archived', label: 'Archived', color: 'var(--chart-archived)' },
  { key: 'attention', label: 'Attention', color: 'var(--chart-attention)' },
] as const;

/** The chart's numbers as text, for screen readers and low-contrast cases. */
function ToggleRow({ table, setTable }: { table: boolean; setTable: (value: boolean) => void }) {
  return (
    <div className="absolute right-0 top-0 z-10 flex gap-1 text-[11px]">
      <button
        type="button"
        onClick={() => setTable(false)}
        className={!table ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}
      >
        Chart
      </button>
      <span className="text-muted-foreground">·</span>
      <button
        type="button"
        onClick={() => setTable(true)}
        className={table ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}
      >
        Table
      </button>
    </div>
  );
}

function dayLabel(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(d)}/${Number(m)}`;
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { dataKey: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce((sum, p) => sum + (p.value ?? 0), 0);
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium text-foreground">
        {label} · {total} email{total === 1 ? '' : 's'}
      </p>
      <ul className="space-y-0.5">
        {SERIES.map((series) => {
          const entry = payload.find((p) => p.dataKey === series.key);
          if (!entry || !entry.value) return null;
          return (
            <li key={series.key} className="flex items-center gap-2 text-muted-foreground">
              <span className="size-2 rounded-sm" style={{ background: series.color }} />
              <span className="flex-1">{series.label}</span>
              <span className="tnum text-foreground">{entry.value}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ActivityChart({ series }: { series: DaySeries[] }) {
  const [table, setTable] = useState(false);
  const data = series.map((row) => ({ ...row, label: dayLabel(row.day) }));
  const empty = data.every((row) => row.kept + row.archived + row.trashed + row.attention === 0);

  if (table) {
    return (
      <div className="relative">
        <ToggleRow table={table} setTable={setTable} />
        <div className="max-h-56 overflow-y-auto pt-5 scrollbar-thin">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-medium">Day</th>
                {SERIES.map((s) => (
                  <th key={s.key} className="py-1 pr-2 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tnum">
              {data.map((row) => (
                <tr key={row.day} className="border-t">
                  <td className="py-1 pr-2">{row.day}</td>
                  {SERIES.map((s) => (
                    <td key={s.key} className="py-1 pr-2 text-right">
                      {row[s.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    // min-w-0 lets the chart shrink with its column, and overflow-hidden keeps
    // Recharts from reporting a width the layout then has to grow to.
    <div className="relative h-56 w-full min-w-0 overflow-hidden">
      <ToggleRow table={table} setTable={setTable} />
      {empty ? (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Nothing processed in the last 14 days yet.
        </p>
      ) : null}
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: -18, bottom: 0 }} barCategoryGap="30%">
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="2 4" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
            interval={1}
          />
          <YAxis
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
            width={40}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'hsl(var(--muted) / 0.5)' }} />
          <Legend
            iconType="square"
            iconSize={8}
            wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
            formatter={(value: string) => (
              <span className="text-muted-foreground">{value}</span>
            )}
          />
          {SERIES.map((s, index) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="day"
              fill={s.color}
              stroke="hsl(var(--card))"
              strokeWidth={1}
              radius={index === SERIES.length - 1 ? [3, 3, 0, 0] : 0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
