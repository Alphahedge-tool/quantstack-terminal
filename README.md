# QuantStack UI

A React + Vite frontend for the existing `qt-backend` service. This repo is
**frontend only** — every byte of data comes from the backend that already lives
in `D:\Quantstack\trading-terminal\backend`, and the visual system is ported
from that project's token ladder.

## Running it

```bash
npm install
npm run dev     # http://localhost:5273
```

The backend must be running separately:

```bash
cd D:\Quantstack\trading-terminal\backend
npm run dev     # http://localhost:3101
```

Vite proxies `/api` and `/ws` to port 3101, so the browser stays on one origin
and the WebSocket upgrade behaves in dev exactly as it will behind a reverse
proxy in production. Point elsewhere with `QT_BACKEND_URL`.

| Script | Does |
|---|---|
| `npm run dev` | Dev server with HMR |
| `npm run build` | Typecheck, then production bundle into `dist/` |
| `npm run preview` | Serve the built bundle |
| `npm run lint` | Typecheck only |

## Stack

React 19 · TypeScript · Vite 6 · Tailwind CSS 4 · React Router 7 · Zustand ·
TanStack Query · Zod · Lucide · lightweight-charts 5.

## Layout

```
src/
  styles/       tokens.css → base.css → index.css (Tailwind theme bridge)
  lib/          api client, WebSocket client, formatters
  schemas/      Zod contracts mirroring the backend's types
  stores/       Zustand: UI preferences, live quote tape
  hooks/        TanStack Query declarations, live-quote channel
  components/
    ui/         Panel, Button, Badge, DataTable, Field, StatTile, States
    layout/     AppShell, TopBar, SideNav, StatusBar
    trading/    BookPanel, shared cell renderers
    chart/      LineChart (SVG, one axis), StraddleChart (canvas, two panes)
    straddle/   LayoutPicker, StraddleSlot, StatStrip, useStraddleContract
  pages/        One per route
  app/          Router and QueryClient

backend/
  analytics/    black76, syntheticFuture, straddleMetrics — pure maths
  analytics/volPass.ts   collects every modelled bar and resolves it in ONE
                         batch, through the Go sidecar or locally
  lib/computeClient.ts   the sidecar client: opt-in, fail-soft, never throws
  engine/       the session walk, band greeks, risk reversal
```

## The expiry cockpit

`/expiry` is a live view of one expiring contract, built to answer a regime
question rather than a direction one: **is this session about to go from
compression to expansion, and once it does, which side?** Almost everything on
the page serves the first half — direction on expiry day is a much weaker read,
and giving both equal weight would overstate what the data supports.

```
backend/analytics/expiryMetrics.ts   pure maths: GEX, gamma flip, walls, regime,
                                     pressure, OI flow, expected vs realized
backend/expiry/session.ts            the live store AND the recorder
backend/routes/expiry.ts             GET /api/expiry/state · /api/expiry/status
src/pages/ExpiryPage.tsx             tape · strike ladder · the read
```

### What the feed gives — and one field name that cost a whole feature

Probed one field at a time against `charts/timeseries` — `npm run verify:fields`:

```
SERVED      l1bid  l1ask  open  high  low  close  iv_bid  iv_ask  iv_mid
            delta  gamma  vega  theta
            cumulative_oi  cumulative_volume  tick_volume
            cumulative_volume_premium  cumulative_volume_delta
NOT SERVED  oi · open_interest · prev_oi · oi_change · l1bidqty · l1askqty
            cumulative_call_oi · cumulative_put_oi   (on an OPT query)
```

The first version of this probe asked for `oi`, `open_interest` and
`openInterest`, got nothing for all three, and concluded that **open interest
has no history** — so walls, migration and every gamma figure could only ever be
live. That was wrong. The documented field is **`cumulative_oi`**, it is served,
and an unrecognised name returns exactly the same silence as a missing field.

Measured, once the right name was used:

| | |
|---|---|
| per-contract OI, one session | 376 one-minute points, 363 distinct values |
| NIFTY 23950 CE, 2026-08-19 | 64,220 at the open → 420,875 at the close |
| reach at 1m | **at least 180 days** (probe each date with a contract alive *on* that date — today's weekly has no history before it was listed) |
| feed `gamma` reach | roughly a month; older sessions fall back to Black-76 |

### Replaying a past session

`GET /api/expiry/replay?symbol=&exchange=&date=` rebuilds the entire cockpit for
a day that has already happened — same metrics, same panels, from history. The
date picker on `/expiry` switches between live and replay.

```
NIFTY 2026-08-12 · 82 contracts · 376 bars · 1.4s
  09:15  fwd 24501.8  straddle 279.40  IV 10.94%  flip 24865  call wall 25000
  15:30  fwd 24447.5  straddle 244.55  IV  9.76%  flip 24625  call wall 24500
  put wall migrated 24300 → 24000
```

Two deliberate differences from the live path, both stated in the UI:

* **Spot is the synthetic forward** (`K + CE − PE` at the ATM), not the index.
  It is already in the option prices, needs no second fetch, and is the correct
  input for gamma and for the flip anyway.
* **Gamma falls back to Black-76** where the feed has none, using the vol
  inverted from the ATM straddle. The response's `gammaSource` says which —
  `feed`, `black76`, or `mixed`.

### The recorder

Still running, for the two things history cannot give: **resolution** (the
socket publishes ~1/s, history's finest useful option interval is 1m) and **what
the feed said at the time** (vendors restate history; a bar written down as it
arrived is evidence). Each minute bar, with the full strike ladder, appends to
`backend/cache/expiry/{EXCHANGE}_{SYMBOL}_{EXPIRY}_{DATE}.jsonl`.
`GET /api/expiry/status` reports what is being recorded.

### Two things to read sceptically

**The GEX sign** is the US dealer-long convention — calls positive, puts
negative — which is not obviously right on NIFTY, where much of the option
supply is retail writing both wings. What the page actually uses is the *shape*:
where net GEX crosses zero, and which side of it spot is on. A global sign flip
leaves that unchanged.

**The pressure score** normalises each component against a fixed scale, not
against this contract's own history — that history is what the recorder is
building. Until then the level is indicative and the *change* is the signal.

## Logging

The backend logs through [pino](https://getpino.io). Every line carries a level,
a timestamp and a `mod` field — the structured form of the `[module]` prefix the
code already used by convention.

```
[10:14:02.331] INFO: [ws/quotes] quotes socket listening {"path":"/ws/live/quotes"}
[10:14:02.918] INFO: [auth] feed connected {"feed":"nubra"}
[10:14:03.402] INFO: [instrument-cache] 1842 instruments loaded {"exchange":"NSE","rows":1842}
[10:31:55.117] WARN: [feeds] heartbeat delayed {"feed":"angel","misses":2}
[10:31:58.240] ERROR: [feeds] feed disconnected {"feed":"angel"}
[10:31:58.244] INFO: [live] failover → zerodha {"from":"angel","to":"zerodha","contracts":41}
```

At a terminal that is coloured and one line per event. Piped to a file or a
process manager it is one JSON object per line instead, which is what a log
shipper can index. The switch follows the TTY; `QT_LOG_PRETTY=1` or `0` forces
it either way, and `QT_LOG_LEVEL` sets the floor (`debug` outside production).

### Values go in the object, not the message

```ts
const log = logger('feeds');
log.info({ feed: id, priority }, 'feed connected');   // yes
log.info(`${id} connected (priority ${priority})`);   // no
```

The message is what gets grouped, counted and alerted on. Interpolating the feed
id into it turns one event into as many distinct messages as there are feeds, and
nothing downstream can tell they are the same thing happening again.

### Secrets are redacted before serialisation

`token`, `sessionToken`, `password`, `apiKey`, `totp` and their nested forms are
replaced with `[redacted]` by pino itself, so a credential cannot escape by being
inside an object somebody logged whole. This is not hypothetical: the live path
threads a broker token through several layers, and the likeliest moment for one
to be logged is inside an error describing a subscription that failed — which is
exactly the line that gets pasted into an issue.

### Scripts still use `console`, on purpose

Everything under `backend/scripts/` is a CLI tool whose output is the product —
`verifyGo.ts` prints a table of ✓ and ✗ for a person standing at a terminal.
Wrapping those rows in timestamps and levels would make them worse, and it would
put the pretty-printer's worker thread between the script and its own exit.
`npm run lint:logs` enforces the split in both directions.

## Metrics

Every process exposes Prometheus metrics at `/metrics` — the Node backend on its
API port, `marketd` and `computed` on theirs. `ops/prometheus.yml` scrapes all
three.

There is no flag to turn it on. A scrape endpoint that has to be enabled is one
that turns out to be off on the day it is needed.

### The five series worth a dashboard

| series | what it tells you |
| --- | --- |
| `nodejs_eventloop_lag_p99_seconds` | whether Node is blocked. Everything on the screen is late by this much. |
| `qt_feed_up{feed}` | a broker session is alive. The single most useful alert here. |
| `rate(qt_engine_points_total[5m])` | the live engine is still producing |
| `qt_engine_iv_source_total{source}` | whether vols are being **read** or **modelled** |
| `qt_http_request_duration_seconds` | what the terminal is actually waiting on |

The IV source one is the least obvious and the most valuable. When a broker's
greeks stream goes quiet the chart keeps drawing a perfectly smooth IV line —
it is just being solved from Black-76 rather than observed. Nothing in the UI
says so, and nothing else in the system notices.

### Cardinality is the one rule

Every distinct combination of label values is a time series held in memory, in
the scraper, and in storage forever. So labels here are closed sets — `feed`,
`exchange`, `channel`, `engine`, and a **registered route** — and never a
symbol, an expiry or a strike. An unrouted request is labelled `unknown` rather
than by its path, which is what stops a port scanner from minting series from
outside.

### States are collected, events are counted

Anything that is a state — is this feed up, how many sessions are running — is
read at scrape time from whatever owns it. Pushing state means every writer must
remember to update the gauge on every path, and the one path that forgets leaves
a metric that is confidently wrong forever. Counters are the opposite: nothing
retains a count of things that already happened, so those are incremented at the
event.

### Both sides measure the sidecar, on purpose

`qt_compute_request_duration_seconds` (Node) and `qt_solve_duration_seconds`
(Go) measure the same calls. Node's includes the loopback and the JSON encode of
a 22k-bar batch; Go's is the maths alone. The gap between them is the cost of
the process boundary — which is the number that decides whether more of the hot
path is worth moving across it.

## The Go compute sidecar

`backend-go/` is a second process that owns one thing: numeric work that runs in
a loop over bars. Node keeps every route, every broker session, every credential
and the whole assistant — see the module ledger in the migration plan for which
side each directory sits on.

```
backend-go/
  black76/          Black-76 pricer, IV inverter, greeks — a port of
                    backend/analytics/black76.ts, which remains the spec
  chain/            strike selection and the synthetic forward
  cmd/computed/     the HTTP service: batch endpoints, fan-out across cores
```

```bash
npm run go:test          # Go unit tests (round-trip, refusals, greek units)
npm run go:dev           # run the sidecar on 127.0.0.1:3151
npm run verify:go        # parity: Go against the TypeScript, 5,600 cases
QT_GO_COMPUTE=1 npm run dev    # make the backend actually use it
```

### It is off by default, and that is a measurement not a hedge

Measured on this machine, 22,000 bars of inversion plus greeks:

| | time |
|---|---|
| TypeScript, in process | 45 ms |
| Go compute alone | 3 ms |
| Go including the HTTP round trip | 127 ms |

The maths is 15× faster in Go and the round trip is 3× slower than not making
it. That is not a defect in the sidecar — it is what it looks like when the
work was never the bottleneck. A cold session walk is ~14.8 s, of which
`optionSeries` (waiting on the broker) is ~13.4 s and the whole vol pass is
under 10 ms.

So `QT_GO_COMPUTE=1` is worth turning on when you want to keep that CPU off the
event loop — it is the thread serving every live socket — and not for
throughput. The sidecar earns its keep properly at stage 2, when the walk and
its data both move across and nothing has to be serialised back.

### The parity gate

`npm run verify:go` runs both implementations over the same 5,613 cases — a
grid, a seeded random sweep, and the edge cases the guards exist for — and
requires agreement to 1e-9, with refusals matching **exactly**. A bar one side
calls unsolvable and the other answers is a failure whatever the number is.

End to end, the two paths were diffed on real sessions through
`/api/straddle/history`:

* NIFTY 2026-08-20 (feed greeks, 22,500 points) — **byte-identical**, 351 roll
  events identical.
* CRUDEOIL 2026-03-10 (100% modelled greeks, 870 points) — identical to 1.8e-15
  relative, i.e. one or two ulp of double-precision noise out of the Newton
  iteration. All 266 roll events at the same times and strikes.

### If the sidecar is down

Nothing happens. `lib/computeClient.ts` probes once, times out fast, and any
failure takes the sidecar out of rotation for 60 s — callers get `null` and run
the TypeScript path, which is the same maths and is what runs by default anyway.

## The design system

Everything resolves to a variable in `src/styles/tokens.css`. Components consume
**roles** (`--surface-panel`, `--text-secondary`), never a raw hex, so one edit
there moves the whole product.

**Surface ladder.** Panels separate by luminance, not by a colour cast. The warm
bias is deliberate but tiny (R−B of +2 to +6). Steps between neighbours are
1.07:1 and 1.10:1 — below roughly 1.05:1 a boundary stops existing to the eye no
matter what the hex says, and the page reads as one flat sheet with only the 1px
borders carrying structure. **If you change one stop, re-check its neighbours.**

**Card on ground.** A container is *darker* than the surface it sits on, so a
drop shadow alone cannot lift it. Two edges do the work: `--container-edge` is
the rim catching light from above, and `--container-halo` is the occlusion ring
painted behind the card. Both are keyed to `--surface-blue` and must move with
it.

**Text emphasis.** Four steps, dimmed by luminance only — each keeps the
ladder's warm signature exactly (R = B+7, G = B+5), because a step that loses
its warmth as it darkens reads as a different, cooler grey rather than as less
of the same ink. The floor is 3:1 against the surface the text actually sits on,
and the binding surface is not a panel but `--surface-blue`, the **ground** they
sit on: tertiary is under 3:1 there, so tertiary is panels-only and page-level
text outside a panel uses secondary. See `tokens.css` for the measured table.

**Typography.** Sans carries prose and labels; mono carries every number, so
digits align in a column and a changing price does not make the row jitter. Six
sizes and four weights are the whole vocabulary — emphasis is carried by weight
and colour before size, which keeps the vertical rhythm intact.

**Spacing.** A 4px grid, `--space-1` through `--space-12`. Arbitrary values are
how spacing stops being a system.

### Chart colours are validated, not chosen

`--chart-1/2/3` are the categorical slots for plotted marks, distinct from the
`--series-*` UI accents (which are too light to sit on the chart surface). They
were rebuilt in OKLCH at L≈0.60, C≥0.13 and checked against the `#1c1b19` chart
surface: inside the dark lightness band, above the chroma floor, worst adjacent
CVD separation ΔE 24.8 (deuteranopia) / 11.7 (tritanopia), all ≥3:1 contrast.
**Re-run the validator if any of them move.** Slots are assigned in fixed order
and never cycled; a fourth series becomes small multiples, not a new hue.

`LineChart` (inline SVG) takes one y-axis by construction. Series handed to it
must share a unit, because a dual axis makes every crossing an artefact of the
scaling choice rather than a fact about the market.

`StraddleChart` (lightweight-charts, canvas) keeps that rule and pays less for
it. Panes share **one time scale and one crosshair** while keeping separate
price scales, so the straddle page is a single chart instead of three stacked
ones that each had their own zoom state:

| Pane | Right scale | Left scale |
|---|---|---|
| 0 (stretch 3) | straddle premium as candles, bid, ask — rupees | ATM IV — percent |
| 1 (stretch 1) | synthetic future, spot — index points | — |

Spot overlays the synthetic future because those two genuinely share a unit and
the *gap* between them is the number worth reading. IV shares a pane with
premium — reading them together is the job — but never the axis.

The canvas engine takes literal colours, so `lib/chartTheme.ts` reads the
`--series-*` tokens out of the computed style once per mount and hands them
over. Nothing hardcodes a hex; the ladder stays the single source.

Candles are aggregated from the engine's raw 1-second walk at the selected
interval (1s → 5m), so a wick is the bucket's **true** high and low and changing
the interval re-aggregates from full data. The SVG chart had to min/max decimate
22k points to ~900 first, which made every view a resample of a resample.

It is the one lazily-loaded route: the charting engine is ~180kB that a trader
watching the order book never needs.

### Chart layouts

The straddle page is a grid of independent slots — 1, 2 across, 2 stacked, or
2×2 — picked with a glyph selector, because "2 across" and "2 stacked" are two
words that differ by one and the choice is really a shape.

Each slot owns its **underlying and expiry**; the **session date** stays on the
page. The point of four charts is comparing four different contracts, so the
contract selector belongs in the slot — but letting each slot wander to its own
*day* would put four unrelated sessions under one heading and invite a
comparison that means nothing.

Splitting clones the last slot's contract rather than resetting to the default:
the next thing you do is change one field of it, and cloning makes that one
edit where resetting makes three.

Slot heights are `clamp()` on `dvh`, not fixed pixels — a fixed height left a
third of a 1080p window empty while the plot was cramped, and overflowed on a
laptop. `LayoutPicker` documents the measured chrome it subtracts; **if you add
a row to the chart header, or to the shell, update `CHROME` with it.** Note what
under-counting looks like: the panel clips, so the first thing lost off the
bottom is the time axis, and a chart with no time on it does not read as a
chart that overflowed.

The crosshair readout is a reserved 22px row above the plot, not an overlay in
its top-left corner. TradingView puts it in the corner because TradingView has
no left price scale there — here IV owns it, and the overlay landed on both the
axis labels and the pane caption.

The stat strip follows the **focused** slot (click any chart), using the same
`useStraddleContract` hook the slot itself calls — the keys match, so Query
serves both from one request and the strip costs nothing. Aggregating all four
into one strip would produce numbers true of no contract on screen.

## Talking to the backend

The backend's envelope is uniform and encoded once in `lib/api.ts`: every
response carries a `status` boolean, `status: false` means the request failed,
and `code` is the field to branch on. `FEED_AUTH_REQUIRED` is surfaced as
`ApiFailure.isAuth` so an expired session renders a sign-in prompt instead of a
red banner the user cannot act on.

Responses are parsed with Zod at the edge. These payloads cross a repo boundary
and the two sides deploy independently — parsing means a contract drift shows up
named, at the boundary, rather than as `undefined is not an object` three
components deep during a fast market.

**Partial failure is a first-class state.** The book routes query every broker in
parallel and return whatever succeeded alongside an `errors` array. The UI shows
those as a strip *above* the table, never instead of it: one account being down
must not blank rows that other accounts answered for.

**Funds are never aggregated.** Cash in one account cannot margin a position in
another, so a combined total would be true of no account and misleading about
all of them. The funds page renders one card per account, matching the backend's
own decision.

### Live prices

`/ws/live/quotes` carries the tape. The socket is a module-level singleton
mounted once by `AppShell`, because a hook-owned connection would tear down on
every route change — dropping the subscription set and several seconds of
prices each time.

Frames are keyed by canonical symbol, the same field `/api/trading/positions`
puts on every row, so joining a tick to a position is a map lookup. Positions
are re-marked from the live price rather than trusting the broker's `pnl` field,
which is only as fresh as the last poll.

Quotes live in Zustand rather than the query cache: they arrive at up to 4Hz, and
writing them through TanStack Query would re-render every subscriber of the book
on each flush. Components select the one symbol they render.

## Routes

| Path | Page |
|---|---|
| `/` | Dashboard — net P&L, working orders, biggest movers |
| `/positions` | Position book, marked to the live tape |
| `/orders` | Order book with status filters |
| `/trades` | Fill tape |
| `/holdings` | Demat book |
| `/funds` | Margin per account |
| `/straddle` | Rolling ATM straddle — premium, IV and synthetic future on one time axis |
| `/instruments` | Instrument master search |
| `/feeds` | Feed and account connection state |
