/**
 * Driverless Chrome: spawn the browser ourselves and talk CDP to it directly,
 * optionally running chromium-bidi's BiDi-CDP mapper *in this Node process*
 * instead of in the hidden tab chromedriver creates.
 *
 * This is how Puppeteer runs `protocol: 'webDriverBiDi'` on Chrome
 * (puppeteer-core/src/bidi/BidiOverCdp.ts). The bootstrap below mirrors
 * chromium-bidi's own in-tab entry point (src/bidiTab/bidiTab.ts) line for
 * line — same MapperCdpConnection, same createBrowserSession, same
 * BidiServer.createAndStart, same validating BidiParser — so the only thing
 * that changes versus chromedriver is WHERE the mapper runs (and that no
 * chromedriver sits in between).
 *
 * The chromium-bidi import is lazy: it's the repo's only dependency, and only
 * the mapper-in-node benchmarks need it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isHeadless } from './browsers.mjs';
import { sleep } from './driver.mjs';

const DEFAULT_CHROME = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};

/**
 * Exactly the flags chromedriver passes (captured from `chromedriver --verbose`,
 * "Launching chrome:" line, chromedriver 156), so both paths boot the same
 * browser. Only --user-data-dir differs (ours, theirs are both fresh temp dirs).
 */
function chromeArgs(userDataDir) {
  const args = [
    '--allow-pre-commit-input',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-features=IgnoreDuplicateNavs,Prewarm',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--enable-automation',
    '--enable-logging',
    '--log-level=0',
    '--no-first-run',
    '--no-service-autorun',
    '--password-store=basic',
    '--remote-debugging-port=0',
    '--test-type=webdriver',
    '--use-mock-keychain',
    `--user-data-dir=${userDataDir}`,
    '--window-size=1280,800',
  ];
  if (isHeadless()) args.push('--headless=new');
  args.push('data:,');
  return args;
}

/**
 * Spawn Chrome and resolve once it prints its DevTools WebSocket URL.
 * Returns { proc, wsUrl, close() }.
 */
export async function launchChrome() {
  const bin = process.env.CHROME_BINARY || DEFAULT_CHROME[process.platform];
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-perf-chrome-'));
  const proc = spawn(bin, chromeArgs(userDataDir), { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        proc.stderr.off('data', onData);
        proc.stderr.resume(); // keep draining so Chrome never blocks on a full pipe
        resolve(m[1]);
      }
    };
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    proc.on('exit', (code) => reject(new Error(`Chrome exited (${code}) before DevTools was ready`)));
  });

  return {
    proc,
    wsUrl,
    async close() {
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGKILL');
      await exited;
      // Helper processes can still be flushing into the profile for a moment
      // after the main process dies.
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await sleep(80); // same settle gap the chromedriver paths get
    },
  };
}

/** Open a WebSocket and resolve when it is connected. */
function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', (e) => reject(new Error(`WebSocket error: ${e?.message ?? e}`)), {
      once: true,
    });
  });
}

/** Minimal raw CDP client on the browser endpoint. send() resolves with { ms, msg }. */
export async function openCdp(wsUrl) {
  const ws = await openSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      const t0 = performance.now();
      return new Promise((res) => {
        pending.set(id, (msg) => res({ ms: performance.now() - t0, msg }));
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

let mapperModules;
/** Load chromium-bidi once per process — a real client pays this once, not per session. */
export async function loadMapper() {
  if (!mapperModules) {
    const base = 'chromium-bidi/out/Default/gen/src';
    const [{ BidiServer }, { MapperCdpConnection }, { BidiParser }] = await Promise.all([
      import(`${base}/bidiMapper/BidiMapper.js`),
      import(`${base}/cdp/CdpConnection.js`),
      import(`${base}/bidiTab/BidiParser.js`),
    ]);
    mapperModules = { BidiServer, MapperCdpConnection, BidiParser };
  }
  return mapperModules;
}

/**
 * Connect to Chrome's CDP endpoint and start the chromium-bidi mapper in this
 * process. Returns a BiDi client with the same shape as lib/bidi.mjs's
 * openBidi(): send(method, params) → { ms, msg }, close().
 *
 * Messages cross the mapper boundary as objects — no WebSocket and no JSON
 * between client and mapper. That is a real property of this architecture,
 * not a benchmark shortcut: it's one of the hops it removes.
 */
export async function startNodeMapper(wsUrl) {
  const { BidiServer, MapperCdpConnection, BidiParser } = await loadMapper();
  const ws = await openSocket(wsUrl);

  const cdpTransport = {
    onMessage: null,
    setOnMessage(handler) {
      this.onMessage = handler;
    },
    sendMessage(message) {
      ws.send(message);
    },
    close() {
      ws.close();
    },
  };
  ws.addEventListener('message', (ev) => cdpTransport.onMessage?.(ev.data));

  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  const bidiTransport = {
    onMessage: null,
    setOnMessage(handler) {
      this.onMessage = handler;
    },
    sendMessage(message) {
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.type === 'event') {
        for (const fn of listeners) fn(message);
      }
    },
    close() {},
  };

  const cdpConnection = new MapperCdpConnection(cdpTransport);
  const server = await BidiServer.createAndStart(
    bidiTransport,
    cdpConnection,
    await cdpConnection.createBrowserSession(),
    /* selfTargetId= */ '',
    new BidiParser()
  );

  return {
    send(method, params = {}) {
      const id = ++nextId;
      const t0 = performance.now();
      return new Promise((res) => {
        pending.set(id, (msg) => res({ ms: performance.now() - t0, msg }));
        bidiTransport.onMessage({ id, method, params });
      });
    },
    /** Listen for BiDi events (after session.subscribe). Returns an unsubscribe fn. */
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      server.close();
      cdpConnection.close();
    },
  };
}
