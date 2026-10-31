/**
 * The four ways to get a usable Chrome session that the mapper-in-node
 * benchmarks compare. Each start() is timed from before the first process
 * spawn to the reply of the session's first real command, and records phase
 * marks along the way. Each returns the same small op interface, so per-command
 * benchmarks can drive every mode identically.
 *
 *   classic      chromedriver, WebDriver Classic          test ─HTTP─▶ chromedriver ─CDP─▶ Chrome
 *   cd-bidi      chromedriver, webSocketUrl:true          test ─WS─▶ chromedriver ─CDP─▶ mapper tab ─CDP─▶ Chrome
 *   node-mapper  no driver; chromium-bidi in this process test(+mapper) ─CDP─▶ Chrome
 *   raw-cdp      no driver, no BiDi: the floor            test ─CDP─▶ Chrome
 *
 * "First real command": Classic GET /url; BiDi browsingContext.getTree (it is
 * what pays the mapper's one-time warm-up, see bench/initbidi.mjs); raw CDP
 * Target.getTargets.
 */
import { BROWSERS } from './browsers.mjs';
import { startDriver, httpJson } from './driver.mjs';
import { newSession, deleteSession } from './session.mjs';
import { openBidi } from './bidi.mjs';
import { launchChrome, openCdp, startNodeMapper, loadMapper } from './chrome-direct.mjs';

const chrome = BROWSERS.chrome;

function marker() {
  const t0 = performance.now();
  const phases = {};
  let last = t0;
  return {
    phases,
    mark(name) {
      const now = performance.now();
      phases[name] = now - last;
      last = now;
    },
    total: () => performance.now() - t0,
  };
}

function classicOps(port, sessionId) {
  const cmd = async (method, path, body) => {
    const r = await httpJson(port, method, `/session/${sessionId}${path}`, body);
    if (r.status !== 200) throw new Error(`${method} ${path} → HTTP ${r.status}: ${r.raw.slice(0, 200)}`);
    return r.json.value;
  };
  return {
    navigate: (url) => cmd('POST', '/url', { url }),
    evaluate: (expression) => cmd('POST', '/execute/sync', { script: `return ${expression}`, args: [] }),
    async locate(css) {
      const el = await cmd('POST', '/element', { using: 'css selector', value: css });
      return Object.values(el)[0];
    },
    click: (ref) => cmd('POST', `/element/${ref}/click`, {}),
    alertText: () => cmd('GET', '/alert/text'),
    acceptAlert: () => cmd('POST', '/alert/accept', {}),
  };
}

function bidiOps(bidi, context) {
  const cmd = async (method, params) => {
    const { msg } = await bidi.send(method, params);
    if (msg.type === 'error') throw new Error(`${method}: ${msg.error} ${msg.message}`);
    return msg.result;
  };
  return {
    navigate: (url) => cmd('browsingContext.navigate', { context, url, wait: 'complete' }),
    evaluate: (expression) =>
      cmd('script.evaluate', { expression, target: { context }, awaitPromise: false }),
    async locate(css) {
      const r = await cmd('browsingContext.locateNodes', {
        context,
        locator: { type: 'css', value: css },
        maxNodeCount: 1,
      });
      return r.nodes[0].sharedId;
    },
    // What a BiDi client does for click: pointer move to the element's centre, down, up.
    click: (sharedId) =>
      cmd('input.performActions', {
        context,
        actions: [
          {
            type: 'pointer',
            id: 'mouse',
            parameters: { pointerType: 'mouse' },
            actions: [
              { type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId } } },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      }),
  };
}

export const MODES = {
  classic: {
    label: 'chromedriver Classic',
    async start() {
      const m = marker();
      const driver = await startDriver(chrome);
      m.mark('driver ready');
      const s = await newSession(driver.port, chrome, { bidi: false });
      m.mark('New Session');
      const ops = classicOps(driver.port, s.sessionId);
      await httpJson(driver.port, 'GET', `/session/${s.sessionId}/url`);
      m.mark('first command');
      return {
        total: m.total(),
        phases: m.phases,
        ops,
        async close() {
          await deleteSession(driver.port, s.sessionId);
          await driver.close();
        },
      };
    },
  },

  'cd-bidi': {
    label: 'chromedriver BiDi (mapper in hidden tab)',
    async start() {
      const m = marker();
      const driver = await startDriver(chrome);
      m.mark('driver ready');
      const s = await newSession(driver.port, chrome, { bidi: true });
      m.mark('New Session');
      const bidi = await openBidi(s.wsUrl);
      m.mark('WS connect');
      const { msg } = await bidi.send('browsingContext.getTree', {});
      m.mark('first command');
      return {
        total: m.total(),
        phases: m.phases,
        ops: bidiOps(bidi, msg.result.contexts[0].context),
        async close() {
          bidi.close();
          await deleteSession(driver.port, s.sessionId);
          await driver.close();
        },
      };
    },
  },

  'node-mapper': {
    label: 'chromium-bidi mapper in Node (no driver)',
    async start() {
      // Module load is a once-per-process cost, measured separately by the
      // cold-process table; keep it out of the per-session number.
      await loadMapper();
      const m = marker();
      const browser = await launchChrome();
      m.mark('DevTools URL');
      const bidi = await startNodeMapper(browser.wsUrl);
      m.mark('mapper start');
      // chromedriver runs this same command against its mapper inside New Session.
      await bidi.send('session.new', { capabilities: {} });
      m.mark('session.new');
      const { msg } = await bidi.send('browsingContext.getTree', {});
      m.mark('first command');
      return {
        total: m.total(),
        phases: m.phases,
        ops: bidiOps(bidi, msg.result.contexts[0].context),
        async close() {
          bidi.close();
          await browser.close();
        },
      };
    },
  },

  // Keep Classic, swap only the BiDi transport: we launch Chrome, chromedriver
  // attaches to it (debuggerAddress) for Classic commands, and the mapper runs
  // in Node for BiDi. chromedriver boots while Chrome does, and the attach and
  // mapper bring-up run concurrently once Chrome's DevTools endpoint is up.
  hybrid: {
    label: 'hybrid: chromedriver attached (Classic) + mapper in Node (BiDi)',
    async start() {
      await loadMapper();
      const m = marker();
      const [driver, browser] = await Promise.all([startDriver(chrome), launchChrome()]);
      m.mark('driver + DevTools URL');
      const debuggerAddress = new URL(browser.wsUrl).host;
      const [attach, bidi] = await Promise.all([
        httpJson(driver.port, 'POST', '/session', {
          capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { debuggerAddress } } },
        }),
        startNodeMapper(browser.wsUrl).then(async (b) => {
          // BiDi's default prompt handling is to dismiss; with two clients on
          // one browser that races Classic's alert commands. Leave dialogs to
          // whoever handles them explicitly.
          await b.send('session.new', {
            capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: 'ignore' } } },
          });
          return b;
        }),
      ]);
      const sessionId = attach.json?.value?.sessionId;
      if (!sessionId) throw new Error(`attach failed (HTTP ${attach.status}): ${attach.raw.slice(0, 300)}`);
      m.mark('attach ‖ mapper');
      const [{ msg }] = await Promise.all([
        bidi.send('browsingContext.getTree', {}),
        httpJson(driver.port, 'GET', `/session/${sessionId}/url`),
      ]);
      m.mark('first command');
      return {
        total: m.total(),
        phases: m.phases,
        ops: classicOps(driver.port, sessionId),
        bidiOps: bidiOps(bidi, msg.result.contexts[0].context),
        bidi,
        async close() {
          bidi.close();
          await deleteSession(driver.port, sessionId); // attached: does not close Chrome
          await driver.close();
          await browser.close();
        },
      };
    },
  },

  'raw-cdp': {
    label: 'raw CDP, no BiDi (the floor)',
    async start() {
      const m = marker();
      const browser = await launchChrome();
      m.mark('DevTools URL');
      const cdp = await openCdp(browser.wsUrl);
      await cdp.send('Target.getTargets');
      m.mark('first command');
      return {
        total: m.total(),
        phases: m.phases,
        ops: null,
        async close() {
          cdp.close();
          await browser.close();
        },
      };
    },
  },
};
