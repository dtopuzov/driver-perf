# driver-perf

A minimal, dependency-free reproduction of the **per-session cost that
chromedriver's [WebDriver BiDi mapper](https://github.com/GoogleChromeLabs/chromium-bidi)
adds to New Session**, compared to Classic WebDriver.

It exists to give the W3C Browser Testing and Tools WG a small, readable
artifact that isolates one question:

> *How much does enabling BiDi (`webSocketUrl: true`) slow down session
> creation, and where does that time go?*

The two sessions it compares are **identical except for a single
capability** — see [`lib/browsers.mjs`](lib/browsers.mjs):

```js
const caps = { browserName, /* goog:chromeOptions | moz:firefoxOptions */ };
if (bidi) caps.webSocketUrl = true;   // <-- the only difference
```

## How BiDi works on Chrome

Chrome has **no native BiDi** — it only speaks CDP (Chrome DevTools
Protocol). To offer BiDi, chromedriver runs chromium-bidi's **BiDi-CDP
Mapper**: an 831 KB JavaScript bundle loaded into a *hidden browser tab*
that translates BiDi commands into CDP and back.

So the two protocols reach the browser by different paths:

```
WebDriver Classic
  test  ──HTTP──▶  chromedriver  ──CDP──▶  Chrome

WebDriver BiDi  (webSocketUrl: true)
  test  ──BiDi/WS──▶  chromedriver  ──CDP──▶  BiDi-CDP Mapper  ──CDP──▶  Chrome
                                             (hidden tab, 831 KB JS)
```

Classic sends CDP straight to Chrome. **BiDi inserts an extra hop** — the
mapper tab — and that tab has to be built **during New Session**, before
the session is usable:

```
create hidden tab  ──▶  wait for its renderer  ──▶  inject + evaluate the
831 KB bundle  ──▶  launch the mapper  ──▶  run an internal session.new
```

That bring-up is the per-session penalty this repo measures. Firefox
speaks BiDi natively — no mapper, no hidden tab, no penalty — which is why
it's used as the control.

## What it shows

Because the mapper is built *during* New Session (see above), every BiDi
session pays for it up front. These benchmarks measure that cost and break
it down.

### The headline — WebDriver Classic vs BiDi startup

Benchmark: [`bench/newsession.mjs`](bench/newsession.mjs)

New Session is the startup step where Classic and BiDi differ.

- **Sampling:** paired/interleaved — BiDi and Classic run back-to-back each
  iteration so drift cancels out.
- **Penalty:** the median of paired BiDi-minus-Classic deltas.
- **Jitter:** robust MAD-based paired jitter, so a single multi-second
  browser-launch outlier can't hide a stable signal.

**Chrome** — pays the mapper tax:

```
== WebDriver Classic vs BiDi — startup (New Session), chrome ==
  startup                              median      p95
  WebDriver BiDi (webSocketUrl:true)   1963ms   1978ms
  WebDriver Classic                    1539ms   1560ms
  BiDi startup penalty:  +425ms (1.28x)   paired jitter ±15ms  =>  CONSISTENT penalty
```

**Firefox** — the control (native BiDi, `BROWSER=firefox`), no penalty:

```
== WebDriver Classic vs BiDi — startup (New Session), firefox ==
  startup                              median      p95
  WebDriver BiDi (webSocketUrl:true)   4706ms   4930ms
  WebDriver Classic                    4740ms   4980ms
  BiDi startup penalty:  -34ms (0.99x)   paired jitter ±243ms  =>  noisy / within paired jitter
```

Chrome's penalty is ~28x its paired jitter — reproducible on every run.

Firefox's delta is a fraction of its jitter, indistinguishable from zero
(its sign even flips run to run). **So the ~430ms is a Chromium/chromedriver
*implementation* cost — the mapper — not something the WebDriver BiDi
protocol requires.**

> This is a *per-browser* Classic-vs-BiDi measurement, not a Chrome-vs-Firefox
> race. Firefox is only a control — its slower absolute startup is a separate
> story; only each browser's own BiDi-vs-Classic *delta* matters.

### Where the penalty lives, and the client warm-up (Chrome)

| Benchmark | What it measures |
|---|---|
| [`bench/anatomy.mjs`](bench/anatomy.mjs) | Splits New Session using chromedriver's own `--verbose` log into `Chrome process boot` (identical both ways) vs `post-boot setup` (the mapper), and lists the extra CDP commands the BiDi session issues. Chrome only — Firefox has no CDP mapper to dissect. |
| [`bench/profile-mapper.mjs`](bench/profile-mapper.mjs) | Correlates verbose-log command IDs with their responses over several paired samples. Reports medians for hidden-renderer readiness, mapper-bundle evaluation, mapper launch, and internal `session.new`. |
| [`bench/initbidi.mjs`](bench/initbidi.mjs) | The one-time mapper warm-up the first BiDi command pays, and shows it isn't driven by how many events you subscribe to. |
| [`bench/reuse-session.mjs`](bench/reuse-session.mjs) | The practical alternative of keeping one BiDi session alive and creating tabs or isolated user contexts per test. |

The current deep-dive — Chromium/headless-shell comparison, architecture
source links, and a WG-ready proposal — is in
[`docs/RESEARCH-2026-07-10.md`](docs/RESEARCH-2026-07-10.md).

### Moving the mapper out of the tab: chromium-bidi in Node (Chrome)

What if the client runs the mapper itself, the way Puppeteer does, and talks
CDP to Chrome directly? These benchmarks need `npm install` (they import
chromium-bidi; nothing else in the repo does). Results and analysis:
[`docs/RESEARCH-2026-10-31-mapper-in-node.md`](docs/RESEARCH-2026-10-31-mapper-in-node.md).

| Benchmark | What it measures |
|---|---|
| [`bench/mapper-startup.mjs`](bench/mapper-startup.mjs) | Spawn-to-first-reply for chromedriver Classic, chromedriver BiDi, the mapper in Node (no driver), a hybrid (chromedriver attached for Classic + mapper in Node), and raw CDP (the floor). Warm (one process) and cold (fresh process per session) tables. |
| [`bench/mapper-commands.mjs`](bench/mapper-commands.mjs) | Per-command cost (navigate, evaluate, locate, click, heavy navigate) across the same modes. |
| [`bench/hybrid-interop.mjs`](bench/hybrid-interop.mjs) | Correctness of the hybrid: element ids across protocols, navigation and events seen from both sides, dialog ownership. |

Headline on a 2013 Intel Mac, Chrome 156 (warm, paired, n=20): mapper in Node
**−485ms** vs chromedriver Classic, chromedriver BiDi **+252ms**. Most of the
win is removing chromedriver; the mapper itself costs ~120ms wherever it runs.

Example anatomy output — the tax is entirely **post-boot**; Chrome itself
starts in the same time both ways:

```
== Table 2: New Session anatomy — where the BiDi penalty lands (chrome) ==
  segment                                         BiDi   Classic    delta
  Chrome process boot (launch -> 1st CDP cmd)   1521ms    1511ms    +10ms
  post-boot setup (BiDi mapper bring-up)         531ms      87ms   +444ms
  New Session wall time                         1994ms    1540ms   +454ms
  CDP commands issued during New Session            32        10      +22

  Extra CDP commands the BiDi session issues (the mapper bring-up):
     1x  Target.createTarget           — creates the hidden "BiDi-CDP Mapper" tab
     1x  Target.exposeDevToolsProtocol — wires CDP into the mapper's JavaScript
     2x  Runtime.addBinding            — mapper <-> driver message channel
     8x  Runtime.evaluate              — mapper initialization / bootstrap
     ... (plus Page/Target enable+attach for the mapper tab)
```

> Numbers are illustrative — Chrome 150 / Firefox 152, macOS, headless.
> **Run it on your own machine; the deltas are the point, not the
> absolutes.**

## Requirements

- **Node >= 22** (uses the built-in global `WebSocket`). No `npm install`
  needed, except for the mapper-in-Node benchmarks (chromium-bidi).
- **chromedriver matching your installed Chrome's major version**, on
  `PATH` or via `CHROMEDRIVER=/abs/path/to/chromedriver`.
- *(Firefox control, optional)* **geckodriver** on `PATH` or via
  `GECKODRIVER=/abs/path`, and Firefox found automatically or via
  `FIREFOX_BINARY=/abs/path`.

## Run

```bash
node run.mjs                  # Chrome Classic-vs-BiDi + anatomy + warm-up, then Firefox control
node bench/newsession.mjs     # the headline: Classic vs BiDi startup (Chrome by default)
node bench/anatomy.mjs        # where the penalty lives (Chrome only)
node bench/profile-mapper.mjs # multi-sample mapper phase medians
node bench/initbidi.mjs       # the client-side mapper warm-up
node bench/reuse-session.mjs  # tabs/user contexts in one warm BiDi session

npm install                       # mapper-in-Node benchmarks only
node bench/mapper-startup.mjs     # startup: chromedriver vs mapper in Node vs hybrid vs raw CDP
node bench/mapper-commands.mjs    # per-command cost across the same modes
node bench/hybrid-interop.mjs     # hybrid correctness checks

BROWSER=firefox node bench/newsession.mjs   # the Firefox control (native BiDi)
```

Environment knobs:

| var | default | meaning |
|---|---|---|
| `BROWSER` | `chrome` | `chrome` or `firefox` (single-browser benches) |
| `CHROMEDRIVER` | `chromedriver` on PATH | path to the chromedriver binary |
| `GECKODRIVER` | `geckodriver` on PATH | path to the geckodriver binary |
| `CHROME_BINARY` | driver default | path to a specific Chrome binary |
| `FIREFOX_BINARY` | auto-detected | path to a specific Firefox binary |
| `HEADLESS` | on | set `0`/`false` to run headed |
| `ITERS` | 8 (6 initbidi) | measured iterations |
| `WARMUP` | 2 | discarded warmup iterations |

## How it works (no magic)

- [`lib/browsers.mjs`](lib/browsers.mjs) — per-browser driver + capabilities;
  BiDi vs Classic differ only by `webSocketUrl: true`.
- [`lib/driver.mjs`](lib/driver.mjs) — spawn the driver on a free port, poll
  `/status`, run a callback, kill it.
- [`lib/session.mjs`](lib/session.mjs) — the timed `POST /session`.
- [`lib/sample.mjs`](lib/sample.mjs) — sampling loops (incl.
  paired/interleaved).
- [`lib/bidi.mjs`](lib/bidi.mjs) — a ~30-line BiDi WebSocket command sender.
- [`lib/cdlog.mjs`](lib/cdlog.mjs) — correlate chromedriver's timestamped CDP
  commands/responses and split mapper startup into contiguous phases.

No Selenium, Puppeteer, Playwright, or WebDriver client library is
involved — just Node built-ins and raw HTTP/WebSocket, so the numbers
reflect the browser + driver, not a client.

## Roadmap

- [x] Firefox (geckodriver) control — native BiDi, ~0 New Session penalty,
      confirming the cost is implementation-specific, not protocol.
- [ ] Optional CSV/JSON output for sharing runs.
- [ ] More engines (WebKit/Safari via `safaridriver`) if useful to the WG.
