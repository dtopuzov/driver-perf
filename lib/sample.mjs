/**
 * Sample New Session wall time for a browser: fresh driver + fresh browser per
 * iteration, DELETE session each time, discard `warmup` leading iterations so
 * the first cold-browser launch doesn't skew the median.
 */
import { withDriver } from './driver.mjs';
import { newSession, deleteSession } from './session.mjs';

async function timeOne(browser, bidi) {
  return withDriver(browser, async (port) => {
    const s = await newSession(port, browser, { bidi });
    await deleteSession(port, s.sessionId);
    return s.ms;
  });
}

/**
 * Paired/interleaved sampling: each iteration times BiDi and Classic
 * back-to-back, so slow drift (thermal, cache warmth) hits both equally and
 * cancels in the delta. Important for Firefox, whose New Session is slow and
 * noisy enough that block-sampling can flip the sign of a near-zero delta.
 */
export async function sampleNewSessionPaired(browser, { iters, warmup }) {
  const bidi = [];
  const classic = [];
  for (let i = 0; i < warmup + iters; i++) {
    const tb = await timeOne(browser, true);
    const tc = await timeOne(browser, false);
    if (i >= warmup) {
      bidi.push(tb);
      classic.push(tc);
    }
  }
  return { bidi, classic };
}
