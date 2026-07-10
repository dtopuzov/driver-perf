/**
 * Multi-sample BiDi-CDP Mapper startup profile.
 *
 * Unlike anatomy.mjs (one readable example), this collects paired BiDi and
 * Classic verbose logs and reports medians for each synchronous mapper phase.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { resolveBrowser, isHeadless, configuredBinary } from '../lib/browsers.mjs';
import { withDriver, resolveDriver } from '../lib/driver.mjs';
import { newSession, deleteSession } from '../lib/session.mjs';
import { parseChromedriverLog, mapperStartupPhases } from '../lib/cdlog.mjs';
import { median, ms, table } from '../lib/stats.mjs';

const ITERS = Number(process.env.ITERS ?? 5);
const WARMUP = Number(process.env.WARMUP ?? 1);

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

async function unloggedSession(browser, bidi) {
  return withDriver(browser, async (port) => {
    const s = await newSession(port, browser, { bidi });
    await deleteSession(port, s.sessionId);
  });
}

export async function main(browser = resolveBrowser()) {
  console.log(`\n== BiDi-CDP Mapper startup profile (${browser.name}) ==`);
  if (!browser.supportsAnatomy) {
    console.log(`  Skipped: ${browser.name} has no CDP mapper to profile.\n`);
    return;
  }
  console.log(
    `driver=${resolveDriver(browser)}\n` +
      `binary=${configuredBinary(browser)}  headless=${isHeadless()}  iters=${ITERS}  warmup=${WARMUP}\n`
  );

  for (let i = 0; i < WARMUP; i++) {
    await unloggedSession(browser, true);
    await unloggedSession(browser, false);
  }

  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-perf-profile-'));
  const bidiWall = [];
  const classicWall = [];
  const bidiPost = [];
  const classicPost = [];
  const phaseSamples = new Map();

  for (let i = 0; i < ITERS; i++) {
    const bidiLog = path.join(outdir, `bidi-${i + 1}.log`);
    const classicLog = path.join(outdir, `classic-${i + 1}.log`);
    bidiWall.push(await loggedSession(browser, true, bidiLog));
    classicWall.push(await loggedSession(browser, false, classicLog));

    const b = parseChromedriverLog(bidiLog);
    const c = parseChromedriverLog(classicLog);
    bidiPost.push((b.tReady - b.tFirstCmd) * 1000);
    classicPost.push((c.tReady - c.tFirstCmd) * 1000);
    for (const phase of mapperStartupPhases(b)) {
      const values = phaseSamples.get(phase.key) ?? [];
      values.push(phase.seconds * 1000);
      phaseSamples.set(phase.key, values);
    }
  }

  const wallDeltas = bidiWall.map((value, i) => value - classicWall[i]);
  const postDeltas = bidiPost.map((value, i) => value - classicPost[i]);
  table(
    ['paired result', 'median', 'samples (ms)'],
    [
      ['New Session BiDi - Classic', ms(median(wallDeltas)), wallDeltas.map(Math.round).join(' ')],
      ['post-boot BiDi - Classic', ms(median(postDeltas)), postDeltas.map(Math.round).join(' ')],
      ['Classic post-boot baseline', ms(median(classicPost)), classicPost.map(Math.round).join(' ')],
    ]
  );

  const representative = mapperStartupPhases(
    parseChromedriverLog(path.join(outdir, 'bidi-1.log'))
  );
  const phaseMedians = representative.map((phase) => ({
    ...phase,
    value: median(phaseSamples.get(phase.key)),
  }));
  const total = phaseMedians.reduce((sum, phase) => sum + phase.value, 0);
  console.log('\n  Median BiDi post-boot critical path:');
  table(
    ['phase', 'median', '% of path'],
    phaseMedians.map((phase) => [
      phase.label,
      ms(phase.value),
      `${((phase.value * 100) / total).toFixed(0)}%`,
    ])
  );
  console.log(`\n  Logs: ${outdir}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
