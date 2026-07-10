import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseChromedriverLog, mapperStartupPhases } from '../lib/cdlog.mjs';

test('correlates responses and splits a contiguous mapper startup path', () => {
  const log = `
[1.000][INFO]: COMMAND InitSession {
[1.010][INFO]: Launching chrome: /browser
[1.100][DEBUG]: DevTools WebSocket Command: Target.getTargets (id=1) (session_id=) browser {
}
[1.110][DEBUG]: DevTools WebSocket Response: Target.getTargets (id=1) (session_id=) browser {
}
[1.120][DEBUG]: DevTools WebSocket Command: Runtime.enable (id=2) (session_id=page) page {
}
[1.130][DEBUG]: DevTools WebSocket Response: Runtime.enable (id=2) (session_id=page) page {
}
[1.150][DEBUG]: DevTools WebSocket Command: Target.createTarget (id=3) (session_id=) browser {
  "hidden": true
}
[1.160][DEBUG]: DevTools WebSocket Response: Target.createTarget (id=3) (session_id=) browser {
}
[1.200][DEBUG]: DevTools WebSocket Command: Page.enable (id=4) (session_id=mapper) mapper {
}
[1.500][DEBUG]: DevTools WebSocket Response: Page.enable (id=4) (session_id=mapper) mapper {
}
[1.510][DEBUG]: DevTools WebSocket Command: Runtime.evaluate (id=5) (session_id=mapper) mapper {
  "expression": "(function(){ function mitt() {} })()"
}
[1.570][DEBUG]: DevTools WebSocket Response: Runtime.evaluate (id=5) (session_id=mapper) mapper {
}
[1.580][DEBUG]: DevTools WebSocket Command: Runtime.evaluate (id=6) (session_id=mapper) mapper {
  "expression": "window.runMapperInstance('mapper')"
}
[1.610][DEBUG]: DevTools WebSocket Response: Runtime.evaluate (id=6) (session_id=mapper) mapper {
}
[1.620][DEBUG]: DevTools WebSocket Command: Runtime.evaluate (id=7) (session_id=mapper) mapper {
  "expression": "onBidiMessage('session.new')"
}
[1.630][DEBUG]: DevTools WebSocket Response: Runtime.evaluate (id=7) (session_id=mapper) mapper {
}
[1.650][INFO]: RESPONSE InitSession {
[2.000][INFO]: RESPONSE Quit
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-perf-test-'));
  const logPath = path.join(dir, 'chromedriver.log');
  fs.writeFileSync(logPath, log);

  const parsed = parseChromedriverLog(logPath);
  assert.equal(parsed.tReady, 1.65);
  assert.equal(parsed.tLast, 2);
  assert.equal(parsed.commands[0].responseT, 1.11);

  const phases = mapperStartupPhases(parsed);
  assert.deepEqual(
    phases.map((phase) => [phase.key, Math.round(phase.seconds * 1000)]),
    [
      ['initialTarget', 30],
      ['initialNavigation', 20],
      ['hiddenTarget', 50],
      ['hiddenRenderer', 300],
      ['bridge', 10],
      ['bundle', 60],
      ['runMapper', 40],
      ['sessionNew', 40],
    ]
  );
  assert.equal(
    Math.round(phases.reduce((sum, phase) => sum + phase.seconds, 0) * 1000),
    550
  );
});
