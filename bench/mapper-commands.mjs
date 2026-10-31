/**
 * Per-command cost of the same session modes as bench/mapper-startup.mjs —
 * startup is paid once, commands are paid thousands of times per suite, so
 * this is the table that decides whether a driverless path is worth having.
 *
 * One live session per mode (classic, cd-bidi, node-mapper), all against the
 * same local HTTP server. Each iteration runs every op on every mode, mode
 * order rotated per iteration, so drift cancels in the paired deltas.
 *
 *   navigate        light page → light page, waits for load
 *   evaluate        document.title
 *   locate          one CSS lookup
 *   click           a button (Classic element click vs BiDi pointer actions)
 *   navigate heavy  heavy → heavy: 40 images at 30ms each. Earlier craftdriver
 *                   work saw BiDi navigate stall ~1.3s here via chromedriver;
 *                   this shows whether that is the mapper or chromedriver.
 *
 * hybrid runs its Classic ops (via the attached chromedriver): it answers
 * whether a second CDP client in the browser slows Classic down.
 *
 * Env: ITERS (30), WARMUP (5), HEAVY_ITERS (10), MODES (classic,cd-bidi,node-mapper),
 *      CHROMEDRIVER, CHROME_BINARY, HEADLESS.
 */
import http from 'node:http';
import { isHeadless } from '../lib/browsers.mjs';
import { MODES } from '../lib/modes.mjs';
import { median, mad, ms1, table } from '../lib/stats.mjs';

const ITERS = Number(process.env.ITERS ?? 30);
const WARMUP = Number(process.env.WARMUP ?? 5);
const HEAVY_ITERS = Number(process.env.HEAVY_ITERS ?? 10);
const NAMES = (process.env.MODES ?? 'classic,cd-bidi,node-mapper').split(',');
const BASELINE = 'classic';

const rotate = (arr, n) => arr.map((_, i) => arr[(i + n) % arr.length]);

const page = (title, body = '') =>
  `<!doctype html><title>${title}</title>` +
  `<button id="btn" onclick="this.dataset.n=(+this.dataset.n||0)+1">click</button>${body}`;

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/img') {
      // A slow subresource; 1x1 transparent GIF.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
        res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
      }, 30);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    if (url.pathname === '/heavy') {
      const imgs = Array.from({ length: 40 }, (_, i) => `<img src="/img?i=${i}&r=${Math.random()}">`);
      res.end(page('heavy', imgs.join('')));
    } else {
      res.end(page(url.pathname.slice(1) || 'root'));
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  );
}

async function timed(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

export async function main() {
  console.log('\n== Chrome per-command cost: where should the BiDi mapper run? ==');
  console.log(`headless=${isHeadless()}  iters=${ITERS}  warmup=${WARMUP}  heavy_iters=${HEAVY_ITERS}  (paired, order rotated)`);

  const { server, base } = await startServer();
  const sessions = {};
  try {
    for (const name of NAMES) sessions[name] = await MODES[name].start();

    const ops = ['navigate', 'evaluate', 'locate', 'click'];
    const samples = Object.fromEntries(NAMES.map((n) => [n, Object.fromEntries(ops.map((o) => [o, []]))]));
    for (let i = 0; i < WARMUP + ITERS; i++) {
      for (const name of rotate(NAMES, i)) {
        const s = sessions[name].ops;
        const row = {
          navigate: await timed(() => s.navigate(`${base}/${i % 2 ? 'a' : 'b'}`)),
          evaluate: await timed(() => s.evaluate('document.title')),
        };
        row.locate = await timed(() => s.locate('#btn'));
        row.click = await timed(() => s.click(row.locate.value));
        if (i >= WARMUP) for (const o of ops) samples[name][o].push(row[o].ms);
      }
    }

    const heavy = Object.fromEntries(NAMES.map((n) => [n, []]));
    for (const name of NAMES) await sessions[name].ops.navigate(`${base}/heavy`); // first heavy load, untimed
    for (let i = 0; i < HEAVY_ITERS; i++) {
      for (const name of rotate(NAMES, i)) {
        heavy[name].push((await timed(() => sessions[name].ops.navigate(`${base}/heavy`))).ms);
      }
    }
    for (const name of NAMES) samples[name]['navigate heavy'] = heavy[name];

    for (const op of [...ops, 'navigate heavy']) {
      console.log(`\n${op}`);
      table(
        ['mode', 'median', `vs ${BASELINE} (paired)`, 'jitter'],
        NAMES.map((name) => {
          const xs = samples[name][op];
          if (name === BASELINE) return [MODES[name].label, ms1(median(xs)), '—', ''];
          const deltas = xs.map((x, i) => x - samples[BASELINE][op][i]);
          const d = median(deltas);
          return [
            MODES[name].label,
            ms1(median(xs)),
            `${d >= 0 ? '+' : ''}${d.toFixed(1)}ms`,
            `±${(1.4826 * mad(deltas)).toFixed(1)}ms`,
          ];
        })
      );
    }
    console.log();
  } finally {
    for (const s of Object.values(sessions)) await s.close();
    server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
  process.exit(0);
}
