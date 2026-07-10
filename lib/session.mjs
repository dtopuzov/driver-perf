/**
 * Minimal WebDriver New Session — the whole point of the demo.
 *
 * The BiDi and Classic sessions are IDENTICAL except for one capability,
 * `webSocketUrl: true` (see each browser's buildCaps in lib/browsers.mjs).
 * That single flag is what makes chromedriver spin up the chromium-bidi
 * "BiDi-CDP Mapper"; Firefox handles it natively. Everything the benchmarks
 * measure is the cost of that flag.
 */
import { httpJson } from './driver.mjs';

/** POST /session, timed. Returns { ms, sessionId, wsUrl }. */
export async function newSession(port, browser, { bidi }) {
  const caps = browser.buildCaps({ bidi });
  const t0 = performance.now();
  const res = await httpJson(port, 'POST', '/session', {
    capabilities: { alwaysMatch: caps },
  });
  const ms = performance.now() - t0;

  const value = res.json?.value;
  const sessionId = value?.sessionId;
  if (!sessionId) {
    throw new Error(
      `New Session failed (HTTP ${res.status}). ` +
        `Common cause: driver/browser version mismatch.\n  ${res.raw?.slice(0, 400)}`
    );
  }
  return { ms, sessionId, wsUrl: value?.capabilities?.webSocketUrl };
}

export async function deleteSession(port, sessionId) {
  if (sessionId) await httpJson(port, 'DELETE', `/session/${sessionId}`).catch(() => {});
}
