/**
 * Minimal WebDriver driver-process management — no external dependencies.
 *
 * Spawns the browser's driver (chromedriver / geckodriver) on a free port,
 * waits until its `/status` endpoint reports ready, runs a callback against
 * that port, then kills the process. Deliberately the smallest thing that
 * behaves like a real WebDriver client's driver lifecycle, so the benchmarks
 * measure the browser+driver, not a heavy client library.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve a browser's driver binary:
 *   1. $<driverEnv> (absolute path) if set,
 *   2. otherwise the bare driver name from $PATH.
 * The driver MUST match your installed browser's major version.
 */
export function resolveDriver(browser) {
  const fromEnv = process.env[browser.driverEnv];
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) {
      throw new Error(`${browser.driverEnv}=${fromEnv} does not exist.`);
    }
    return fromEnv;
  }
  return browser.driverName;
}

/** Ask the OS for an unused TCP port on loopback. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

/** One JSON HTTP round trip to the local driver. Returns { status, json, raw }. */
export function httpJson(port, method, path, body) {
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: data
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let json = null;
          try {
            json = b ? JSON.parse(b) : null;
          } catch {
            /* leave json null; raw is preserved */
          }
          resolve({ status: res.statusCode, json, raw: b });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Poll GET /status until the driver reports it can create sessions. */
export async function waitReady(port, driverEnv, timeoutMs = 20000, getSpawnError = () => null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const err = getSpawnError();
    if (err) {
      throw new Error(
        `Failed to start driver: ${err.message}. ` +
          `Set ${driverEnv}=/path/to/driver (matching your browser version).`
      );
    }
    try {
      const r = await httpJson(port, 'GET', '/status');
      if (r.status === 200 && r.json?.value?.ready === true) return;
    } catch {
      /* not up yet */
    }
    await sleep(15);
  }
  throw new Error(`driver /status not ready within ${timeoutMs}ms`);
}

/**
 * Spawn a fresh driver for `browser`, wait until ready, run `fn(port)`, then
 * kill it. Pass { verboseLog } to write the driver's timestamped log to a file
 * (used by the anatomy benchmark; only browsers with driverLogArgs honor it).
 */
export async function withDriver(browser, fn, { verboseLog } = {}) {
  const driver = await startDriver(browser, { verboseLog });
  try {
    return await fn(driver.port);
  } finally {
    await driver.close();
  }
}

/**
 * The same lifecycle as withDriver, as a handle — for benchmarks that keep
 * several drivers alive at once. Returns { port, close() }.
 */
export async function startDriver(browser, { verboseLog } = {}) {
  const cmd = resolveDriver(browser);
  const port = await freePort();
  const args = [`--port=${port}`];
  if (verboseLog && browser.driverLogArgs) args.push(...browser.driverLogArgs(verboseLog));

  const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] });
  let spawnError = null;
  proc.on('error', (e) => {
    spawnError = e;
  });
  const close = async () => {
    proc.kill('SIGKILL');
    await sleep(browser.teardownDelayMs ?? 80); // let port + browser fully release
  };

  try {
    await waitReady(port, browser.driverEnv, 20000, () => spawnError);
  } catch (err) {
    await close();
    throw err;
  }
  return { port, close };
}
