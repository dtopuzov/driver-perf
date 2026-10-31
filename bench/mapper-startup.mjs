/**
 * Does running chromium-bidi's mapper in Node (no chromedriver) beat the
 * chromedriver paths at startup — and if so, is the win from moving the
 * mapper out of the hidden tab, or from dropping chromedriver?
 *
 * Every mode is timed from before the first process spawn until the reply to
 * the session's first real command (see lib/modes.mjs). Two tables:
 *
 *   warm  All modes in this one Node process, paired: every iteration runs
 *         every mode, in an order rotated each iteration so drift and
 *         ordering effects cancel. The chromium-bidi module is already loaded
 *         and JIT-warm — a test runner's 2nd..Nth session.
 *   cold  Each session in a fresh Node process, module import included — a
 *         test runner's first session per worker. Skip with COLD_ITERS=0.
 *
 * Env: ITERS (8), WARMUP (2), COLD_ITERS (5), MODES (all, comma-separated),
 *      CHROMEDRIVER, CHROME_BINARY, HEADLESS.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isHeadless } from '../lib/browsers.mjs';
import { resolveDriver } from '../lib/driver.mjs';
import { BROWSERS } from '../lib/browsers.mjs';
import { MODES } from '../lib/modes.mjs';
import { loadMapper } from '../lib/chrome-direct.mjs';
import { median, p95, mad, ms, table } from '../lib/stats.mjs';

const ITERS = Number(process.env.ITERS ?? 8);
const WARMUP = Number(process.env.WARMUP ?? 2);
const COLD_ITERS = Number(process.env.COLD_ITERS ?? 5);
const NAMES = process.env.MODES ? process.env.MODES.split(',') : Object.keys(MODES);
const BASELINE = 'classic';

const rotate = (arr, n) => arr.map((_, i) => arr[(i + n) % arr.length]);
const signed = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(0)}ms`;

async function startOnce(name) {
  const s = await MODES[name].start();
  await s.close();
  return s;
}

function report(title, samples, names) {
  console.log(`\n${title}`);
  table(
    ['mode', 'median', 'p95', `vs ${BASELINE} (paired)`, 'same sign', 'jitter'],
    names.map((name) => {
      const totals = samples[name].map((s) => s.total);
      if (name === BASELINE) return [MODES[name].label, ms(median(totals)), ms(p95(totals)), '—', '', ''];
      const deltas = totals.map((t, i) => t - samples[BASELINE][i].total);
      const d = median(deltas);
      const same = deltas.filter((x) => Math.sign(x) === Math.sign(d)).length;
      return [
        MODES[name].label,
        ms(median(totals)),
        ms(p95(totals)),
        signed(d),
        `${same}/${deltas.length}`,
        `±${(1.4826 * mad(deltas)).toFixed(0)}ms`,
      ];
    })
  );

  console.log('\n  phase medians');
  for (const name of names) {
    const phaseNames = Object.keys(samples[name][0].phases);
    const parts = phaseNames.map((p) => `${p} ${ms(median(samples[name].map((s) => s.phases[p])))}`);
    console.log(`  ${name.padEnd(12)} ${parts.join('  →  ')}`);
  }
}

async function warm() {
  await loadMapper();
  const samples = Object.fromEntries(NAMES.map((n) => [n, []]));
  for (let i = 0; i < WARMUP + ITERS; i++) {
    for (const name of rotate(NAMES, i)) {
      const s = await startOnce(name);
      if (i >= WARMUP) samples[name].push(s);
    }
    process.stdout.write(i < WARMUP ? 'w' : '.');
  }
  report(`warm: same Node process, mapper module loaded (paired, order rotated, n=${ITERS})`, samples, NAMES);
}

/** Child-process entry: one session, module import timed in for node-mapper. */
async function oneShot(name) {
  const t0 = performance.now();
  let importMs = 0;
  if (name === 'node-mapper' || name === 'hybrid') {
    await loadMapper();
    importMs = performance.now() - t0;
  }
  const s = await startOnce(name);
  const phases = importMs ? { 'module import': importMs, ...s.phases } : s.phases;
  process.stdout.write(JSON.stringify({ total: importMs + s.total, phases }));
}

function cold() {
  // raw-cdp is a floor reference, not something a client would ship.
  const names = NAMES.filter((n) => n !== 'raw-cdp');
  const samples = Object.fromEntries(names.map((n) => [n, []]));
  const self = fileURLToPath(import.meta.url);
  for (let i = 0; i < COLD_ITERS; i++) {
    for (const name of rotate(names, i)) {
      const r = spawnSync(process.execPath, [self, '--one-shot', name], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`one-shot ${name} failed:\n${r.stderr}`);
      samples[name].push(JSON.parse(r.stdout));
    }
    process.stdout.write('.');
  }
  report(
    `cold: fresh Node process per session, chromium-bidi import + JIT included (paired, order rotated, n=${COLD_ITERS})`,
    samples,
    names
  );
}

export async function main() {
  console.log('\n== Chrome startup: where should the BiDi mapper run? ==');
  console.log(
    `driver=${resolveDriver(BROWSERS.chrome)}  headless=${isHeadless()}  ` +
      `iters=${ITERS}  warmup=${WARMUP}  cold_iters=${COLD_ITERS}`
  );
  if (ITERS > 0) await warm();
  if (COLD_ITERS > 0) cold();
  console.log();
}

const oneShotIdx = process.argv.indexOf('--one-shot');
if (oneShotIdx !== -1) {
  await oneShot(process.argv[oneShotIdx + 1]);
  process.exit(0);
} else if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
  process.exit(0);
}
