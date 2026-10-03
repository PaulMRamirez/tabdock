// Percentiles for the M3 spike (A3.3), by nearest rank as docs/notes/m3/
// tunnel-qr-spike.md sets out: the p-th percentile of n sorted values is the
// value at rank ceil(p / 100 * n), counting from 1. For 50 calls p50 is the
// 25th value and p95 the 48th. No interpolation, so every figure reported is
// a time that one call really took.

export function nearestRank(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) throw new Error('no values to rank');
  if (!(percentile > 0 && percentile <= 100)) throw new Error('percentile must be in (0, 100]');
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const value = sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
  if (value === undefined) throw new Error('rank out of range');
  return value;
}

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

/** null when there is nothing to summarise. */
export function summarise(values: readonly number[]): Summary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function ms(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

export interface TableRow {
  label: string;
  summary: Summary | null;
}

/** A markdown table, ready to paste into docs/notes/spike.md. */
export function markdownTable(rows: readonly TableRow[]): string {
  const lines = [
    '| Measure (ms) | n | p50 | p95 | min | max |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const { label, summary } of rows) {
    lines.push(
      summary === null
        ? `| ${label} | 0 | n/a | n/a | n/a | n/a |`
        : `| ${label} | ${String(summary.n)} | ${ms(summary.p50)} | ${ms(summary.p95)} | ${ms(summary.min)} | ${ms(summary.max)} |`,
    );
  }
  return lines.join('\n');
}
