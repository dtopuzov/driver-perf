/**
 * Minimal WebDriver BiDi client over the browser's BiDi WebSocket.
 *
 * Uses Node's built-in global `WebSocket` (Node >= 22) so the repo stays
 * dependency-free. Only the initBiDi benchmark needs this; the New Session and
 * anatomy benchmarks are pure HTTP.
 */

/** Open the BiDi WebSocket and return a tiny command sender. */
export function openBidi(wsUrl) {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      'Global WebSocket is unavailable. Use Node >= 22 (needed only for the initBiDi benchmark).'
    );
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });

    ws.addEventListener('open', () =>
      resolve({
        /** Send one BiDi command; resolves with { ms, msg } when its reply lands. */
        send(method, params = {}) {
          const id = ++nextId;
          const t0 = performance.now();
          return new Promise((res) => {
            pending.set(id, (msg) => res({ ms: performance.now() - t0, msg }));
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      })
    );

    ws.addEventListener('error', (e) =>
      reject(new Error(`BiDi WebSocket error: ${e?.message ?? e}`))
    );
  });
}

/**
 * The event set a real BiDi client subscribes to at startup (this is exactly
 * craftdriver's launch subscribe list). Used to measure the subscribe cost.
 */
export const STARTUP_SUBSCRIPTIONS = [
  'browsingContext.load',
  'browsingContext.domContentLoaded',
  'browsingContext.userPromptOpened',
  'browsingContext.contextCreated',
  'browsingContext.contextDestroyed',
  'network.beforeRequestSent',
  'network.responseStarted',
  'network.responseCompleted',
  'network.fetchError',
  'network.authRequired',
  'log.entryAdded',
];
