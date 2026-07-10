/**
 * The headline table — WebDriver Classic vs WebDriver BiDi startup.
 *
 * Measures New Session (the step where Classic and BiDi differ) for one browser,
 * BiDi vs Classic. Uses paired/interleaved sampling (BiDi and Classic back-to-
 * back each iteration so drift cancels). The headline is the median of paired
 * BiDi-minus-Classic deltas. Robust MAD-based spread prevents one multi-second
 * OS/browser-launch outlier from erasing an otherwise stable signal.
 *
 * Browser via $BROWSER (default chrome). Chrome pays the chromium-bidi mapper
 * tax; Firefox (native BiDi) is the control and pays ~nothing.
 */
import { resolveBrowser, isHeadless, configuredBinary } from '../lib/browsers.mjs';
import { resolveDriver } from '../lib/driver.mjs';
import { sampleNewSessionPaired } from '../lib/sample.mjs';
import { median, p95, mad, ms, table } from '../lib/stats.mjs';

const ITERS = Number(process.env.ITERS ?? 8);
const WARMUP = Number(process.env.WARMUP ?? 2);

export async function main(browser = resolveBrowser()) {
  console.log(`\n== WebDriver Classic vs BiDi — startup (New Session), ${browser.name} ==`);
  console.log(
    `driver=${resolveDriver(browser)}\n` +
      `binary=${configuredBinary(browser)}  headless=${isHeadless()}  iters=${ITERS}  warmup=${WARMUP}  (paired)\n`
  );

  const { bidi, classic } = await sampleNewSessionPaired(browser, { iters: ITERS, warmup: WARMUP });

  table(
    ['startup', 'median', 'p95', 'samples (ms)'],
    [
      ['WebDriver BiDi (webSocketUrl:true)', ms(median(bidi)), ms(p95(bidi)), bidi.map((x) => x.toFixed(0)).join(' ')],
      ['WebDriver Classic', ms(median(classic)), ms(p95(classic)), classic.map((x) => x.toFixed(0)).join(' ')],
    ]
  );

  const deltas = bidi.map((value, i) => value - classic[i]);
  const penalty = median(deltas);
  const ratio = median(bidi) / median(classic);
  // 1.4826 scales MAD to a standard-deviation estimate for normal data.
  const pairedJitter = 1.4826 * mad(deltas);
  const sameDirection = deltas.filter((value) => Math.sign(value) === Math.sign(penalty)).length;
  const verdict =
    classic.length < 5
      ? 'n/a (raise ITERS>=5)'
      : sameDirection / deltas.length >= 0.75 &&
          Math.abs(penalty) > Math.max(25, 1.5 * pairedJitter)
        ? 'CONSISTENT penalty'
        : Math.abs(penalty) <= Math.max(25, 1.5 * pairedJitter)
          ? 'noisy / within paired jitter'
          : 'mixed result; collect more samples';

  console.log(
    `\n  BiDi startup penalty:  ${penalty >= 0 ? '+' : ''}${penalty.toFixed(0)}ms  (${ratio.toFixed(2)}x)` +
      `   paired jitter ±${pairedJitter.toFixed(0)}ms  =>  ${verdict}`
  );
  console.log(
    `  paired deltas (BiDi - Classic): ${deltas.map((x) => `${x >= 0 ? '+' : ''}${x.toFixed(0)}`).join(' ')}ms` +
      `   same sign ${sameDirection}/${deltas.length}`
  );
  console.log(`  [${browser.implementation}]\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
