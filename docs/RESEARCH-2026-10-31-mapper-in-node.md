# Running the BiDi mapper in Node instead of chromedriver's hidden tab — 2026-10-31

Prompted by a table from David Burns (Chrome 147, 8 paired runs) showing
chromium-bidi's mapper run **in Node** starting a usable session faster than
chromedriver Classic. This reproduces it on the 2013 Intel Mac used for the
July research, and asks two follow-up questions:

1. Is the win from moving the mapper out of the hidden tab, or from removing
   chromedriver?
2. Can a Classic-first client (craftdriver) get the win without porting every
   Classic command to BiDi?

## Executive conclusion

- **Yes, the in-Node mapper is faster to start:** −485 ms warm (20/20 paired
  runs) and −251 ms cold (10/10) against chromedriver Classic. Against
  chromedriver BiDi, the gap is about −700 ms warm and −510 ms cold.
- **Most of the win is removing chromedriver, not moving the mapper.** The
  in-Node mapper costs about 120 ms over the raw-CDP floor. chromedriver
  Classic sits about 590 ms above the same floor.
- **Per-command cost is a wash.** On navigate, evaluate, locate and heavy
  navigate, the in-Node mapper, chromedriver BiDi and Classic all land within
  a few ms, inside the paired jitter. The "BiDi navigate is ~50 ms slower on
  Chrome" result from earlier craftdriver work does not reproduce at protocol
  level, so it is client-side overhead, not the mapper.
- **Hybrid works.** In this mode we launch Chrome, chromedriver attaches via
  `debuggerAddress` for Classic, and the mapper runs in Node for BiDi.
  - It passes every interop check, including Classic element ids used as BiDi
    `sharedId`s.
  - It needs one capability, `unhandledPromptBehavior: {default: 'ignore'}`.
    Without it the mapper dismisses dialogs before Classic can see them.
  - Startup is **about Classic's (−30 ms cold, −160 ms warm), with BiDi for
    free** instead of chromedriver BiDi's +250 ms.
  - Its bottleneck is chromedriver's attach: ~900 ms after Chrome prints its
    DevTools URL, against ~500 ms for a raw CDP client.

## Setup

- MacBook Pro, Intel i7-4750HQ (4C/8T, 2013), 8 GB, macOS 15 (Darwin 24.6),
  Node 26.4.
- Chrome 156.0.8078.79 and chromedriver 156.0.8078.79 (mac-x64, native on
  this machine). Headless.
- chromium-bidi **157.0.8090-0**: the version Puppeteer pins for its own
  in-Node mapper (`puppeteer-core/src/bidi/BidiOverCdp.ts`). It is not
  necessarily the build chromedriver 156 embeds. 17.0.2 was rejected because
  it pulls a vulnerable zod.
- The machine was loaded (load average 5–11 with VS Code and a browser open).
  That is why the n=8 first pass had ±300–560 ms paired jitter. Every number
  below is n=20 warm / n=10 cold / n=40 per-command, paired, with mode order
  rotated each iteration.

The in-Node bootstrap mirrors chromium-bidi's own in-tab entry point
(`src/bidiTab/bidiTab.ts`). It uses the same `MapperCdpConnection`, the same
`createBrowserSession()`, the same `BidiServer.createAndStart` and the same
validating `BidiParser`. Chrome gets **exactly** the flags chromedriver passes,
copied from its `--verbose` "Launching chrome:" line. So the only differences
are where the mapper runs and whether chromedriver sits in between.

"Usable" means the reply to the session's first real command has arrived.
That is `GET /url` on Classic, `browsingContext.getTree` on BiDi (it pays the
mapper's one-time warm-up) and `Target.getTargets` on raw CDP.

## Startup

`MODES=classic,cd-bidi,node-mapper,hybrid node bench/mapper-startup.mjs`
(raw-cdp from the run without hybrid; its medians are stable across runs)

**Warm** (same Node process, mapper module loaded; a test runner's 2nd..Nth
session):

| mode | median | vs Classic (paired) | same sign |
|---|---:|---:|---:|
| chromedriver Classic | 1898 ms | — | |
| chromedriver BiDi (mapper in hidden tab) | 2108 ms | +252 ms | 15/20 |
| **chromium-bidi mapper in Node, no driver** | **1421 ms** | **−485 ms** | 20/20 |
| hybrid: chromedriver attached + mapper in Node | 1745 ms | −160 ms | 17/20 |
| raw CDP, no BiDi (floor) | 1304 ms | −591 ms | 20/20 |

**Cold** (fresh Node process per session, chromium-bidi import and JIT
included; a test runner's first session per worker):

| mode | median | vs Classic (paired) | same sign |
|---|---:|---:|---:|
| chromedriver Classic | 1924 ms | — | |
| chromedriver BiDi | 2154 ms | +258 ms | 10/10 |
| **mapper in Node** | **1658 ms** | **−251 ms** | 10/10 |
| hybrid | 1905 ms | −30 ms | 8/10 |

Phase medians (warm):

```
classic      driver ready 177ms  →  New Session 1715ms  →  first command 7ms
cd-bidi      driver ready 176ms  →  New Session 1913ms  →  WS connect 3ms  →  first command 3ms
node-mapper  DevTools URL 784ms  →  mapper start 570ms  →  session.new 30ms  →  first command 0ms
hybrid       driver + DevTools URL 816ms  →  attach ‖ mapper 896ms  →  first command 9ms
raw-cdp      DevTools URL 802ms  →  first command 511ms
```

How to read the phases:

- **"mapper start" is mostly Chrome still booting.** Chrome prints its
  DevTools URL at ~800 ms, but answers its first CDP command only ~510 ms
  later, even with no mapper at all (raw-cdp). The mapper itself adds about
  120 ms (1421 − 1304).
- **chromedriver's overhead is far more than its process boot.** Classic sits
  about 590 ms above the floor, and only ~175 ms of that is chromedriver
  starting. The rest is inside New Session. A verbose log shows chromedriver
  discovering Chrome by polling for `DevToolsActivePort` and then making two
  HTTP round trips (`/json/version`, `/json/list`) before its first WebSocket
  command. A direct launch reads the URL from stderr instead. Not quantified
  per step on a warm run.
- **Cold costs 143 ms for module import plus a JIT-cold mapper.** That
  narrows the in-Node advantage from −485 to −251 ms. It is paid once per Node
  process, not per session.

### Compared with David's table

| | David (Chrome 147) | here (Chrome 156, slow Intel Mac) |
|---|---:|---:|
| chromedriver BiDi vs Classic | +119 ms | +252 ms |
| mapper in Node vs Classic | −34 ms | −485 ms |
| mapper in Node vs raw-CDP floor | +109 ms | +117 ms |
| chromedriver Classic vs floor | +142 ms | +594 ms |

Two takeaways:

- **The mapper's own cost is the same on both machines** (~110–120 ms).
- **chromedriver's overhead is what scales with the machine.** On slow
  hardware it is the dominant term, which is why the in-Node win is ~14×
  larger here.

## Per-command cost

`node bench/mapper-commands.mjs` and `MODES=classic,hybrid,node-mapper node bench/mapper-commands.mjs`.
One live session per mode, n=40 (heavy n=15), paired, order rotated.

| op | Classic | chromedriver BiDi | mapper in Node | hybrid (Classic ops) |
|---|---:|---:|---:|---:|
| navigate (light) | 29.0 ms | +1.2 ±3.6 | −3.8 ±2.1 | +3.7 ±6.7 |
| evaluate | 6.0 ms | +1.7 ±2.4 | −0.6 ±1.7 | +2.1 ±3.1 |
| locate (CSS) | 5.2 ms | −2.2 ±1.4 | −1.7 ±1.0 | +0.0 ±1.3 |
| click | 31.7 ms | −25.0 ±3.1 | −25.8 ±1.7 | −0.3 ±6.5 |
| navigate heavy→heavy (40 × 30 ms images) | 264.9 ms | +7.5 ±12.7 | −0.8 ±16.9 | +5.9 ±12.1 |

The two runs each have their own Classic baseline, so compare deltas, not
absolute numbers, across columns.

- **Navigate, evaluate, locate and heavy navigate are a wash.** No
  architecture wins per command by more than a few ms.
- **Click is not like-for-like.** Classic element click does scroll-into-view
  and interactability checks; BiDi `input.performActions` does not. The ~25 ms
  is that work, not the transport.
- **The ~1.3 s heavy→heavy BiDi navigate stall seen in craftdriver
  (2026-07-05) does not reproduce** through either mapper on this page shape.
- **Hybrid's Classic ops match plain Classic.** A second CDP client in the
  browser does not slow chromedriver down.

## Hybrid interop

`node bench/hybrid-interop.mjs`. All checks pass:

```
PASS  navigate: Classic → seen by BiDi
PASS  navigate: BiDi → seen by Classic
PASS  events: BiDi browsingContext.load fires on Classic navigate
PASS  ids: Classic element id == BiDi sharedId  (f.<frame>.d.<loader>.e.<n>)
PASS  ids: Classic id usable as BiDi sharedId
PASS  alert: opened via BiDi, read + accepted via Classic
```

The alert check **fails** with the default `session.new` capabilities. The
mapper applies BiDi's default prompt handling and dismisses the dialog, so
chromedriver answers `no such alert`. Passing
`unhandledPromptBehavior: { default: 'ignore' }` to the mapper fixes it. Any
two-client setup has to pick a single owner for dialogs.

## Not covered

- **One machine.** Intel macOS. Linux CI and Apple Silicon may weigh
  chromedriver's overhead very differently (see David's numbers).
- **Headless only.**
- **One mapper version.** Not the build embedded in chromedriver.
- **No real-suite measurement.** Startup is per session; whether −250..−485 ms
  matters depends on how many sessions a suite starts.
- **Lazy attach for hybrid is untested.** The idea: return once BiDi is
  ready, finish the chromedriver attach in the background, and await it only
  on the first Classic command.
