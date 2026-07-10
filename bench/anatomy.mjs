/**
 * Table 2 — where the penalty lands (the key table for the WG). Chrome only:
 * it dissects chromedriver's --verbose CDP log. Firefox implements BiDi
 * natively (no CDP mapper), so there is nothing to dissect there.
 *
 * Splits New Session into:
 *   - Chrome process boot   (launch --> first CDP command): identical both ways
 *   - post-boot setup        (first CDP command --> ready):  the BiDi mapper tax
 * and lists the extra CDP commands the BiDi session issues (the mapper bring-up:
 * a hidden "BiDi-CDP Mapper" tab, exposing CDP into its JS, etc.).
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { resolveBrowser, isHeadless, configuredBinary } from '../lib/browsers.mjs';
import { withDriver, resolveDriver } from '../lib/driver.mjs';
import { newSession, deleteSession } from '../lib/session.mjs';
import { parseChromedriverLog, extraCommands, mapperStartupPhases } from '../lib/cdlog.mjs';
import { ms, table } from '../lib/stats.mjs';

const WARMUP = Number(process.env.WARMUP ?? 2);

// A few of the extra CDP methods, annotated so the table reads without context.
const ANNOTATIONS = {
  'Target.createTarget': 'creates the hidden "BiDi-CDP Mapper" tab',
  'Target.exposeDevToolsProtocol': "wires CDP into the mapper's JavaScript",
  'Runtime.addBinding': 'mapper <-> driver message channel',
  'Target.setAutoAttach': 'attach mapper to page targets',
  'Runtime.evaluate': 'mapper initialization / bootstrap',
};

async function warmup(browser) {
  for (let i = 0; i < WARMUP; i++) {
    await withDriver(browser, async (port) => {
      const s = await newSession(port, browser, { bidi: true });
      await deleteSession(port, s.sessionId);
    });
  }
}

async function loggedSession(browser, bidi, logPath) {
  return withDriver(
    browser,
    async (port) => {
      const s = await newSession(port, browser, { bidi });
      await deleteSession(port, s.sessionId);
      return s.ms;
    },
    { verboseLog: logPath }
  );
}

export async function main(browser = resolveBrowser()) {
  console.log(`\n== Table 2: New Session anatomy — where the BiDi penalty lands (${browser.name}) ==`);
  if (!browser.supportsAnatomy) {
    console.log(
      `  Skipped: ${browser.name} implements BiDi natively (no CDP mapper to dissect).\n`
    );
    return;
  }
  console.log(
    `driver=${resolveDriver(browser)}\n` +
      `binary=${configuredBinary(browser)}  headless=${isHeadless()}  (warm log, 1 sample each)\n`
  );

  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-perf-'));
  const parsed = {};
  const wall = {};
  for (const bidi of [true, false]) {
    await warmup(browser);
    const logPath = path.join(outdir, bidi ? 'bidi.log' : 'classic.log');
    wall[bidi ? 'bidi' : 'classic'] = await loggedSession(browser, bidi, logPath);
    parsed[bidi ? 'bidi' : 'classic'] = parseChromedriverLog(logPath);
  }

  const boot = (p) => (p.tFirstCmd - p.tLaunch) * 1000;
  const post = (p) => (p.tReady - p.tFirstCmd) * 1000;
  const b = parsed.bidi;
  const c = parsed.classic;

  const fmtDelta = (d) => {
    const r = Math.round(d);
    return r === 0 ? '±0ms' : `${r > 0 ? '+' : ''}${r}ms`;
  };
  const dRow = (label, bv, cv) => [label, ms(bv), ms(cv), fmtDelta(bv - cv)];
  table(
    ['segment', 'BiDi', 'Classic', 'delta'],
    [
      dRow('Chrome process boot (launch -> 1st CDP cmd)', boot(b), boot(c)),
      dRow('post-boot setup (BiDi mapper bring-up)', post(b), post(c)),
      dRow('New Session wall time', wall.bidi, wall.classic),
      [
        'CDP commands issued during New Session',
        String(b.commands.length),
        String(c.commands.length),
        `+${b.commands.length - c.commands.length}`,
      ],
    ]
  );

  console.log('\n  Extra CDP commands the BiDi session issues (the mapper bring-up):');
  for (const { method, count } of extraCommands(b.commands, c.commands)) {
    const note = ANNOTATIONS[method] ? `  — ${ANNOTATIONS[method]}` : '';
    console.log(`    ${String(count).padStart(2)}x  ${method.padEnd(32)}${note}`);
  }

  console.log('\n  BiDi post-boot critical path (one contiguous timeline):');
  const phases = mapperStartupPhases(b);
  const total = phases.reduce((sum, phase) => sum + phase.seconds, 0) * 1000;
  table(
    ['phase', 'time', '% of BiDi post-boot'],
    phases.map((phase) => [
      phase.label,
      ms(phase.seconds * 1000),
      `${((phase.seconds * 1000 * 100) / total).toFixed(0)}%`,
    ])
  );
  console.log(
    '\n  The phase rows are contiguous and sum to BiDi post-boot setup. The Classic\n' +
      '  post-boot row above is the baseline; their difference is the mapper tax.\n'
  );

  console.log(`\n  Logs: ${path.join(outdir, 'bidi.log')}\n        ${path.join(outdir, 'classic.log')}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
