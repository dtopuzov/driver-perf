/** Tiny stats + fixed-width table formatting. No dependencies. */

export function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function p95(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

/** Sample standard deviation. */
export function stdev(a) {
  if (a.length < 2) return 0;
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  const variance = a.reduce((s, x) => s + (x - mean) ** 2, 0) / (a.length - 1);
  return Math.sqrt(variance);
}

/** Median absolute deviation, a robust spread measure that is not destroyed by
 * one multi-second browser-launch outlier. */
export function mad(a) {
  const center = median(a);
  return median(a.map((x) => Math.abs(x - center)));
}

export const ms = (n) => `${n.toFixed(0)}ms`;
export const ms1 = (n) => `${n.toFixed(1)}ms`;

/**
 * Print a fixed-width table. First column left-aligned, the rest right-aligned
 * unless an explicit `align` array (of 'l' | 'r') is given.
 */
export function table(headers, rows, align) {
  const cols = headers.length;
  align = align ?? headers.map((_, i) => (i === 0 ? 'l' : 'r'));
  const all = [headers, ...rows].map((r) => r.map((c) => String(c)));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...all.map((r) => r[i].length)));
  const fmt = (r) =>
    '  ' + r.map((c, i) => (align[i] === 'r' ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('   ');

  console.log(fmt(all[0]));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('   '));
  for (const r of all.slice(1)) console.log(fmt(r));
}
