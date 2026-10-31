/**
 * Correctness checks for the hybrid mode (lib/modes.mjs): chromedriver attached
 * for Classic + chromium-bidi in Node for BiDi, both on one Chrome. Two CDP
 * clients on one browser can step on each other; startup numbers mean nothing
 * if these fail. Clients like craftdriver depend on each one:
 *
 *   ids        a Classic element id is usable as a BiDi sharedId (and equal)
 *   navigate   a Classic navigation is seen by BiDi, and vice versa
 *   events     BiDi still receives browsingContext.load after Classic navigates
 *   alert      a dialog opened from BiDi can be read and accepted via Classic
 *              (i.e. the mapper does not auto-dismiss it first)
 */
import http from 'node:http';
import { MODES } from '../lib/modes.mjs';

function startServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>${req.url.slice(1)}</title><button id="btn">b</button>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push([name, 'PASS', detail ?? '']);
  } catch (err) {
    results.push([name, 'FAIL', err.message.split('\n')[0]]);
  }
}

const { server, base } = await startServer();
const s = await MODES.hybrid.start();
const classic = s.ops;
const bidi = s.bidiOps;

await check('navigate: Classic → seen by BiDi', async () => {
  await classic.navigate(`${base}/one`);
  const r = await bidi.evaluate('document.title');
  if (r.result.value !== 'one') throw new Error(`BiDi sees title "${r.result.value}"`);
});

await check('navigate: BiDi → seen by Classic', async () => {
  await bidi.navigate(`${base}/two`);
  const title = await classic.evaluate('document.title');
  if (title !== 'two') throw new Error(`Classic sees title "${title}"`);
});

await check('events: BiDi browsingContext.load fires on Classic navigate', async () => {
  await s.bidi.send('session.subscribe', { events: ['browsingContext.load'] });
  const loaded = new Promise((resolve, reject) => {
    const off = s.bidi.onEvent((e) => {
      if (e.method === 'browsingContext.load' && e.params.url.endsWith('/three')) {
        off();
        resolve();
      }
    });
    setTimeout(() => reject(new Error('no browsingContext.load within 2s')), 2000);
  });
  await classic.navigate(`${base}/three`);
  await loaded;
});

await check('ids: Classic element id == BiDi sharedId', async () => {
  const classicId = await classic.locate('#btn');
  const sharedId = await bidi.locate('#btn');
  if (classicId !== sharedId) throw new Error(`classic=${classicId} bidi=${sharedId}`);
  return classicId;
});

await check('ids: Classic id usable as BiDi sharedId', async () => {
  const classicId = await classic.locate('#btn');
  await bidi.click(classicId);
});

await check('alert: opened via BiDi, read + accepted via Classic', async () => {
  // Fire-and-forget: alert() blocks the page until handled.
  await bidi.evaluate('setTimeout(() => alert("hi"), 0), 1');
  await new Promise((r) => setTimeout(r, 200));
  const text = await classic.alertText();
  if (text !== 'hi') throw new Error(`alert text "${text}"`);
  await classic.acceptAlert();
});

await s.close();
server.close();

console.log('\n== hybrid interop: chromedriver attached (Classic) + mapper in Node (BiDi) ==');
for (const [name, status, detail] of results) console.log(`  ${status}  ${name}${detail ? `  (${detail})` : ''}`);
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
