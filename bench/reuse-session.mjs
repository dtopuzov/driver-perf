/**
 * Practical alternative to paying New Session + mapper startup per test.
 *
 * Keeps one BiDi browser session alive and measures cheap context bootstrap:
 * a plain tab, and an isolated user context (incognito profile) plus a tab.
 */
import { resolveBrowser, configuredBinary } from '../lib/browsers.mjs';
import { withDriver, resolveDriver } from '../lib/driver.mjs';
import { newSession, deleteSession } from '../lib/session.mjs';
import { openBidi } from '../lib/bidi.mjs';
import { median, p95, ms1, table } from '../lib/stats.mjs';

const ITERS = Number(process.env.ITERS ?? 10);
const WARMUP = Number(process.env.WARMUP ?? 2);

async function call(bidi, method, params = {}) {
  const response = await bidi.send(method, params);
  if (response.msg.error) {
    throw new Error(`${method}: ${response.msg.error}: ${response.msg.message}`);
  }
  return response.msg.result;
}

async function sample(iters, warmup, operation) {
  const values = [];
  for (let i = 0; i < warmup + iters; i++) {
    const t0 = performance.now();
    const cleanup = await operation();
    const elapsed = performance.now() - t0;
    await cleanup();
    if (i >= warmup) values.push(elapsed);
  }
  return values;
}

export async function main(browser = resolveBrowser()) {
  console.log(`\n== Reuse one BiDi session — context bootstrap (${browser.name}) ==`);
  console.log(
    `driver=${resolveDriver(browser)}\n` +
      `binary=${configuredBinary(browser)}  iters=${ITERS}  warmup=${WARMUP}\n`
  );

  await withDriver(browser, async (port) => {
    const session = await newSession(port, browser, { bidi: true });
    const bidi = await openBidi(session.wsUrl);
    try {
      // Pay the one-time mapper command warm-up outside the measurements.
      await call(bidi, 'browsingContext.getTree', { maxDepth: 0 });

      const tabs = await sample(ITERS, WARMUP, async () => {
        const result = await call(bidi, 'browsingContext.create', {
          type: 'tab',
          background: true,
        });
        return () => call(bidi, 'browsingContext.close', { context: result.context });
      });

      const isolated = await sample(ITERS, WARMUP, async () => {
        const { userContext } = await call(bidi, 'browser.createUserContext');
        await call(bidi, 'browsingContext.create', {
          type: 'tab',
          userContext,
          background: true,
        });
        // Removing the user context closes all of its browsing contexts.
        return () => call(bidi, 'browser.removeUserContext', { userContext });
      });

      table(
        ['ready-to-use context', 'median', 'p95', 'samples (ms)'],
        [
          [
            'new tab in existing profile',
            ms1(median(tabs)),
            ms1(p95(tabs)),
            tabs.map((x) => x.toFixed(1)).join(' '),
          ],
          [
            'new isolated user context + tab',
            ms1(median(isolated)),
            ms1(p95(isolated)),
            isolated.map((x) => x.toFixed(1)).join(' '),
          ],
        ]
      );
      console.log(
        `\n  The containing BiDi New Session took ${ms1(session.ms)} once. Context cleanup is\n` +
          '  deliberately outside these ready-to-use timings. User contexts isolate browser\n' +
          '  storage, but are not equivalent to a new browser process.\n'
      );
    } finally {
      bidi.close();
      await deleteSession(port, session.sessionId);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
