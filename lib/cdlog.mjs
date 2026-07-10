/**
 * Parse a chromedriver `--verbose` log into a New Session timeline.
 *
 * chromedriver prefixes every line with a monotonic timestamp `[SSSSSS.mmm]`.
 * We extract the New Session boundary, correlated CDP command/response spans,
 * and the command stream. This lets the anatomy benchmarks attribute mapper
 * startup to individual synchronous phases rather than one post-boot bucket.
 */
import fs from 'node:fs';

const TS = /^\[(\d+\.\d+)\]/;
const CMD = /DevTools WebSocket Command: ([\w.:]+) \(id=(\d+)\) \(session_id=([^)]*)\)/;
const RESPONSE = /DevTools WebSocket Response: ([\w.:]+) \(id=(\d+)\) \(session_id=([^)]*)\)/;

function payloadAfter(lines, index) {
  let end = index + 1;
  while (end < lines.length && !TS.test(lines[end])) end++;
  return lines.slice(index + 1, end).join('\n');
}

export function parseChromedriverLog(path) {
  const lines = fs.readFileSync(path, 'utf8').split('\n');

  let tRequest = null; // ChromeDriver receives COMMAND InitSession
  let tLaunch = null; // "Launching chrome:" — process spawn
  let tFirstCmd = null; // first CDP command — Chrome's DevTools is reachable
  let tReady = null; // ChromeDriver emits RESPONSE InitSession
  let tLast = null; // final timestamp, retained for diagnostics only
  const commands = []; // ordered list of correlated command spans
  const byId = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = TS.exec(line);
    if (!m) continue;
    const t = parseFloat(m[1]);
    tLast = t;
    if (tRequest === null && line.includes('COMMAND InitSession')) tRequest = t;
    if (tLaunch === null && line.includes('Launching chrome:')) tLaunch = t;
    if (tReady === null && line.includes('RESPONSE InitSession')) tReady = t;
    const c = CMD.exec(line);
    if (c) {
      if (tFirstCmd === null) tFirstCmd = t;
      const command = {
        t,
        method: c[1],
        id: Number(c[2]),
        sessionId: c[3],
        payload: payloadAfter(lines, i),
        responseT: null,
      };
      commands.push(command);
      byId.set(`${command.sessionId}:${command.id}`, command);
      continue;
    }
    const response = RESPONSE.exec(line);
    if (response) {
      const command = byId.get(`${response[3]}:${Number(response[2])}`);
      if (command) command.responseT = t;
    }
  }

  return { tRequest, tLaunch, tFirstCmd, tReady, tLast, commands };
}

function required(value, label) {
  if (value === undefined || value === null) {
    throw new Error(`ChromeDriver log has no ${label}; verbose log format may have changed.`);
  }
  return value;
}

/**
 * Return contiguous phases from the first CDP command until New Session is
 * returned. Values are seconds because ChromeDriver's timestamps are seconds.
 * The phase values add up exactly to `tReady - tFirstCmd` (modulo log precision).
 */
export function mapperStartupPhases(parsed) {
  const { commands } = parsed;
  const create = required(
    commands.find((c) => c.method === 'Target.createTarget'),
    'Target.createTarget command'
  );
  const beforeCreate = commands.filter((c) => c.t < create.t);
  const commonEnd = required(
    beforeCreate.filter((c) => c.method === 'Runtime.enable').at(-1)?.responseT,
    'initial target Runtime.enable response'
  );
  const mapperPageEnable = required(
    commands.filter((c) => c.method === 'Page.enable' && c.t > create.t).at(-1),
    'mapper Page.enable command'
  );
  const runMapper = required(
    commands.find(
      (c) => c.method === 'Runtime.evaluate' && c.payload.includes('runMapperInstance')
    ),
    'runMapperInstance command'
  );
  // The bundle is the final Runtime.evaluate before runMapperInstance. Avoid
  // depending on a symbol inside the minified bundle, which changes over time.
  const mapperBundle = required(
    commands
      .filter(
        (c) =>
          c.method === 'Runtime.evaluate' &&
          c.t > mapperPageEnable.t &&
          c.t < runMapper.t
      )
      .at(-1),
    'mapper bundle Runtime.evaluate command'
  );
  const sessionNew = required(
    commands.find(
      (c) =>
        c.method === 'Runtime.evaluate' &&
        c.payload.includes('onBidiMessage') &&
        c.payload.includes('session.new')
    ),
    'internal session.new command'
  );

  const first = required(parsed.tFirstCmd, 'first CDP command');
  const ready = required(parsed.tReady, 'RESPONSE InitSession');
  const pageReady = required(mapperPageEnable.responseT, 'mapper Page.enable response');
  const bundleReady = required(mapperBundle.responseT, 'mapper bundle response');
  const mapperReady = required(runMapper.responseT, 'runMapperInstance response');

  return [
    {
      key: 'initialTarget',
      label: 'initial target attach/setup (mostly common)',
      seconds: commonEnd - first,
    },
    {
      key: 'initialNavigation',
      label: 'BiDi-only initial about:blank navigation',
      seconds: create.t - commonEnd,
    },
    {
      key: 'hiddenTarget',
      label: 'create + attach hidden mapper target',
      seconds: mapperPageEnable.t - create.t,
    },
    {
      key: 'hiddenRenderer',
      label: 'wait for hidden mapper renderer readiness',
      seconds: pageReady - mapperPageEnable.t,
    },
    {
      key: 'bridge',
      label: 'runtime/CDP bridge + bindings setup',
      seconds: mapperBundle.t - pageReady,
    },
    {
      key: 'bundle',
      label: 'parse/evaluate bundled mapper JavaScript',
      seconds: bundleReady - mapperBundle.t,
    },
    {
      key: 'runMapper',
      label: 'launch mapper instance',
      seconds: mapperReady - bundleReady,
    },
    {
      key: 'sessionNew',
      label: 'mapper internal BiDi session.new',
      seconds: ready - mapperReady,
    },
  ];
}

/** Multiset difference of CDP method names: how many MORE of each method the
 *  BiDi session issued than the Classic session (i.e. the mapper's footprint). */
export function extraCommands(bidiCommands, classicCommands) {
  const count = (cmds) => {
    const m = new Map();
    for (const { method } of cmds) m.set(method, (m.get(method) ?? 0) + 1);
    return m;
  };
  const b = count(bidiCommands);
  const c = count(classicCommands);
  const extra = [];
  for (const [method, n] of b) {
    const delta = n - (c.get(method) ?? 0);
    if (delta > 0) extra.push({ method, count: delta });
  }
  extra.sort((x, y) => y.count - x.count || x.method.localeCompare(y.method));
  return extra;
}
