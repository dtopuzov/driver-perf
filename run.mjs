/**
 * Run the WebDriver Classic vs BiDi startup benchmarks.
 *   node run.mjs
 *
 * Chrome deep-dive (Tables 1-3), then the same Classic-vs-BiDi startup measure
 * on Firefox as a control (native BiDi, expected ~0 penalty). Each browser is
 * its own Classic-vs-BiDi table — this is NOT a browser-vs-browser comparison.
 *
 * Env knobs: CHROMEDRIVER=/path, GECKODRIVER=/path, FIREFOX_BINARY=/path,
 *            CHROME_BINARY=/path, HEADLESS=0, ITERS=n, WARMUP=n
 */
import { BROWSERS } from './lib/browsers.mjs';
import { main as newsession } from './bench/newsession.mjs';
import { main as anatomy } from './bench/anatomy.mjs';
import { main as initbidi } from './bench/initbidi.mjs';

try {
  // Chrome: the penalty, where it lands, and the client-side warm-up.
  await newsession(BROWSERS.chrome);
  await anatomy(BROWSERS.chrome);
  await initbidi(BROWSERS.chrome);

  // Firefox control: same Classic-vs-BiDi startup measure, native BiDi.
  // Optional — skipped with a note if geckodriver / Firefox isn't available.
  console.log('\n--- control: native BiDi (no mapper) ---');
  try {
    await newsession(BROWSERS.firefox);
  } catch (err) {
    console.log(
      `\n  Firefox control skipped: ${err.message.split('\n')[0]}\n` +
        `  Set GECKODRIVER=/path/to/geckodriver (and FIREFOX_BINARY if needed).\n`
    );
  }
} catch (err) {
  console.error(`\n[driver-perf] ${err.message}\n`);
  process.exit(1);
}
