/**
 * Browser definitions. Each entry knows its driver binary, how to build a
 * WebDriver capabilities object (Classic vs BiDi), and a couple of quirks.
 *
 * The point of the whole repo lives here: for BOTH browsers, the only
 * difference between a Classic and a BiDi session is `caps.webSocketUrl = true`.
 * Chrome answers that flag by spinning up chromium-bidi's mapper (a cost);
 * Firefox answers it with its native, in-engine BiDi implementation (no mapper).
 */
import fs from 'node:fs';

/** Headless unless HEADLESS=0/false. */
export function isHeadless() {
  const v = process.env.HEADLESS;
  return v !== '0' && v !== 'false';
}

function firstExisting(paths) {
  for (const p of paths) if (p && fs.existsSync(p)) return p;
  return undefined;
}

export const BROWSERS = {
  chrome: {
    name: 'chrome',
    binaryEnv: 'CHROME_BINARY',
    driverName: 'chromedriver', // on PATH if $CHROMEDRIVER unset
    driverEnv: 'CHROMEDRIVER',
    // chromedriver writes a timestamped CDP log we can dissect (Table 2).
    supportsAnatomy: true,
    driverLogArgs: (logPath) => ['--verbose', `--log-path=${logPath}`],
    // Chrome's per-session BiDi mapper can leave the browser briefly alive after
    // the driver is killed; a small gap avoids port/profile contention.
    teardownDelayMs: 80,
    implementation: 'chromium-bidi mapper (CDP)',
    buildCaps({ bidi }) {
      const args = [];
      if (isHeadless()) args.push('--headless=new');
      args.push('--window-size=1280,800');
      const chromeOptions = { args };
      if (process.env.CHROME_BINARY) chromeOptions.binary = process.env.CHROME_BINARY;
      const caps = { browserName: 'chrome', 'goog:chromeOptions': chromeOptions };
      if (bidi) caps.webSocketUrl = true; // <-- the only difference
      return caps;
    },
  },

  firefox: {
    name: 'firefox',
    binaryEnv: 'FIREFOX_BINARY',
    driverName: 'geckodriver', // on PATH if $GECKODRIVER unset
    driverEnv: 'GECKODRIVER',
    // Firefox implements BiDi natively — there is no CDP mapper to dissect, so
    // the anatomy table (Table 2) does not apply.
    supportsAnatomy: false,
    driverLogArgs: null,
    // Firefox's BiDi remote agent holds a port that must be released before the
    // next Firefox+BiDi launch; give it a larger settle window than Chrome.
    teardownDelayMs: 400,
    implementation: 'native BiDi (no mapper)',
    buildCaps({ bidi }) {
      const args = [];
      if (isHeadless()) args.push('-headless');
      const ffOptions = { args };
      const bin =
        process.env.FIREFOX_BINARY ||
        firstExisting([
          '/Applications/Firefox.app/Contents/MacOS/firefox',
          '/usr/bin/firefox',
          '/snap/bin/firefox',
          'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
        ]);
      if (bin) ffOptions.binary = bin;
      const caps = { browserName: 'firefox', 'moz:firefoxOptions': ffOptions };
      if (bidi) caps.webSocketUrl = true; // <-- the only difference
      return caps;
    },
  },
};

/** Pick the browser from an explicit name or $BROWSER (default: chrome). */
export function resolveBrowser(name = process.env.BROWSER || 'chrome') {
  const b = BROWSERS[name];
  if (!b) {
    throw new Error(`Unknown BROWSER=${name}. Supported: ${Object.keys(BROWSERS).join(', ')}.`);
  }
  return b;
}

/** Human-readable configured binary path for benchmark provenance. */
export function configuredBinary(browser) {
  return process.env[browser.binaryEnv] || 'driver default';
}
