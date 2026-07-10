/**
 * Table 3 — the client-side BiDi bring-up (initBiDi) cost, attributed.
 *
 * After New Session returns, a BiDi client opens the WebSocket and issues its
 * first commands (typically browsingContext.getTree + session.subscribe). This
 * measures each first-command cost on a FRESH (cold-mapper) session to show:
 *   - a trivial command (session.status) is ~instant, so there's no generic
 *     "cold socket" penalty;
 *   - the first command that actually touches the page/CDP pays a one-time
 *     mapper warm-up (~tens of ms), independent of which command or how many
 *     events are subscribed;
 *   - running getTree + subscribe in parallel already hides one under the other.
 */
import { resolveBrowser } from '../lib/browsers.mjs';
import { withDriver } from '../lib/driver.mjs';
import { newSession, deleteSession } from '../lib/session.mjs';
import { openBidi, STARTUP_SUBSCRIPTIONS } from '../lib/bidi.mjs';
import { median, ms1, table } from '../lib/stats.mjs';

const ITERS = Number(process.env.ITERS ?? 6);

/** Run `fn(bidi)` on a fresh cold BiDi session, ITERS times; collect labeled ms. */
async function measure(browser, fn) {
  const acc = new Map();
  const push = (k, v) => (acc.get(k) ?? acc.set(k, []).get(k)).push(v);
  for (let i = 0; i < ITERS; i++) {
    await withDriver(browser, async (port) => {
      const s = await newSession(port, browser, { bidi: true });
      const bidi = await openBidi(s.wsUrl);
      try {
        for (const [k, v] of await fn(bidi)) push(k, v);
      } finally {
        bidi.close();
        await deleteSession(port, s.sessionId);
      }
    });
  }
  return acc;
}

export async function main(browser = resolveBrowser()) {
  console.log(`\n== Table 3: client BiDi bring-up (initBiDi) — mapper warm-up (${browser.name}) ==`);
  console.log(`fresh cold-mapper session per sample  iters=${ITERS}\n`);

  const results = new Map();
  const merge = (acc) => {
    for (const [k, v] of acc) results.set(k, median(v));
  };

  // status (trivial) -> getTree (first real cmd) -> subscribe (warm, 2nd real cmd)
  merge(
    await measure(browser, async (bidi) => {
      const st = await bidi.send('session.status');
      const gt = await bidi.send('browsingContext.getTree', { maxDepth: 0 });
      const sub = await bidi.send('session.subscribe', { events: STARTUP_SUBSCRIPTIONS });
      return [
        ['session.status (trivial, cold)', st.ms],
        ['getTree — first real command', gt.ms],
        ['2nd real command (warm)', sub.ms],
      ];
    })
  );

  // subscribe (11 events) as the literal first command
  merge(
    await measure(browser, async (bidi) => {
      const sub = await bidi.send('session.subscribe', { events: STARTUP_SUBSCRIPTIONS });
      return [['subscribe 11 events — first real command', sub.ms]];
    })
  );

  // subscribe (5 events) as the literal first command — is it event-count driven?
  merge(
    await measure(browser, async (bidi) => {
      const sub = await bidi.send('session.subscribe', {
        events: STARTUP_SUBSCRIPTIONS.slice(0, 5),
      });
      return [['subscribe 5 events — first real command', sub.ms]];
    })
  );

  // getTree + subscribe in parallel — what a real client does at startup
  merge(
    await measure(browser, async (bidi) => {
      const t0 = performance.now();
      await Promise.all([
        bidi.send('browsingContext.getTree', { maxDepth: 0 }),
        bidi.send('session.subscribe', { events: STARTUP_SUBSCRIPTIONS }),
      ]);
      return [['Promise.all([getTree, subscribe]) — real startup', performance.now() - t0]];
    })
  );

  const row = (label) => [label, ms1(results.get(label))];
  table(
    ['first BiDi command(s) on a cold session', 'median'],
    [
      row('session.status (trivial, cold)'),
      row('getTree — first real command'),
      row('subscribe 11 events — first real command'),
      row('subscribe 5 events — first real command'),
      row('2nd real command (warm)'),
      row('Promise.all([getTree, subscribe]) — real startup'),
    ]
  );
  console.log(
    '\n  Takeaway: the first real command pays a one-time mapper warm-up; the\n' +
      '  parallel getTree+subscribe a client does is already near that floor.\n'
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
