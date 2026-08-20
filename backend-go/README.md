# backend-go

Two binaries, one module. Both are optional: the Node backend runs without
either, and every path they serve has a TypeScript implementation behind it.

| binary | port | what it owns |
| --- | --- | --- |
| `computed` | 3151 | the batch solver, and nothing else |
| `marketd` | 3152 | the batch solver **plus** the whole live path |

Run one or the other, not both — `marketd` serves every endpoint `computed`
does, so the second process would only be a second thing to keep running.
`computed` still exists for a deployment that wants the solver alone.

## The cut line

Node keeps what only Node can do: logins, credentials, the instrument cache,
the routes, the assistant, the database. Go takes the hot path.

```
 broker socket ──► marketd ──────────────────────────────► Node ──► browser
                   ingest → book → OI/volume → ATM →       proxy    chart
                   straddle rule → IV → greeks →           only
                   bars → replay window
```

Node hands `marketd` a contract table and a token, and reads finished points
back. `marketd` never authenticates, never stores a credential, never touches
the database and never reads refdata — a second copy of any of those would be a
second thing to keep correct, and the two would drift.

## Packages

| package | what it is |
| --- | --- |
| `black76` | the closed forms and the vol inversion |
| `chain` | strike grid, ATM selection, synthetic forward by put-call parity |
| `tick` | broker payload → numbers the engine will plot, or nothing |
| `book` | order book state, spread, imbalance, microprice |
| `agg` | OHLC bars, cumulative-counter deltas, fixed-memory ring |
| `market` | the IST session clock and market state |
| `feed` | sources, reconnect, staleness watchdog, breakers, failover |
| `straddle` | the live rolling-ATM straddle engine |
| `hub` | sessions keyed by contract, subscriber fan-out, grace, replay |
| `api` | the stateless batch endpoints both binaries serve |

Each package's doc comment says why it exists and what it refuses to do. Start
with `feed` and `straddle`; the rest is in service of those two.

## Running it

```bash
# from backend/
npm run go:marketd          # go run ./cmd/marketd
npm run go:build:marketd    # → backend/bin/marketd.exe
npm run go:test             # go test ./...
npm run verify:engine       # smoke test against a running marketd
npm run verify:go           # Go ⇄ TypeScript parity on the solver
```

Then turn it on for the Node backend:

```bash
QT_GO_ENGINE=1              # route live straddle sessions to marketd
QT_GO_COMPUTE=1             # route batch solves there too
```

Both are **off by default**, and that is deliberate. The two engines are
verified to agree, but "agrees today on my contract" is not "agrees on every
expiry in every session". Opt-in means this ships beside the TypeScript engine
and is turned off from an env var rather than a rollback.

## Environment

| variable | default | what it does |
| --- | --- | --- |
| `QT_MARKETD_PORT` | `3152` | port `marketd` binds, and the one Node dials |
| `QT_MARKETD_HOST` | `127.0.0.1` | loopback by default — the socket carries a broker token |
| `QT_MARKETD_URL` | — | wins outright, for an engine on another host |
| `QT_GO_COMPUTE_PORT` | `3151` | the same pairing for `computed` |
| `QT_PYTHON` | `python` | interpreter for the Nubra bridge |
| `QT_BRIDGE_SCRIPT` | searched | path to `nubra_ws_bridge.py` |
| `QT_FEED_SILENCE_SEC` | `60` | silence past this counts as a dead subscription |
| `QT_LIVE_GRACE_SEC` | `120` | how long a session outlives its last subscriber |
| `QT_MARKET_ALWAYS_OPEN` | — | report the market open, for after-hours work |

## Metrics

Both binaries expose Prometheus metrics at `/metrics`, alongside the Go runtime
and process collectors.

| series | what it answers |
| --- | --- |
| `qt_feed_frames_total{feed,channel}` | is the socket actually carrying data |
| `qt_feed_frames_dropped_total{feed}` | is the engine loop behind the feed |
| `qt_feed_restarts_total{feed,reason}` | `silent`, `crashed`, `never_started`, `exited` |
| `qt_feed_active{feed}` / `qt_feed_breaker_open{feed}` | who is serving, who is parked |
| `qt_engine_points_total` / `qt_engine_rolls_total` | is the engine producing |
| `qt_engine_compute_duration_seconds` | one pass of the selection rule |
| `qt_engine_iv_source_total{source}` | fed vs modelled vol — a data-quality series |
| `qt_engine_skips_total{reason}` | quiet on purpose, or quiet because broken |
| `qt_hub_sessions` / `qt_hub_subscribers` | read from the hub at scrape time |
| `qt_solve_bars_total{outcome}` | solved vs genuinely unsolvable |
| `qt_market_open{exchange}` | the context every other series is read in |

Two decisions are load-bearing:

**Nothing is ever labelled by strike, expiry or refId.** Every distinct label
combination is a permanent time series. `feed`, `channel` and `exchange` are
closed sets; a contract identifier is not, and would take the monitoring stack
down with it. The same reason `Instrument()` labels by the registered route and
never by the request path — otherwise a port scanner mints series from outside.

**States are collected, events are counted.** `qt_hub_sessions` is a
`GaugeFunc` reading the hub at scrape time, because a session ends through four
different paths and the one that forgot to decrement would leave the gauge
wrong for the life of the process. Counters are the opposite: nothing retains a
count of things that already happened, so those are incremented at the event.

`metrics.Seed()` gives the fixed label sets a zero at startup. Without it a
fresh process exposes nothing, a dashboard shows "No data" — indistinguishable
from a broken scrape — and `rate()` reads a counter's first appearance as a
reset and reports a spike that never happened.

## Two things worth knowing before changing anything

**Feeds are judged on data, not on liveness.** A socket that errors is easy; the
failure that costs money is the one where the connection is fine, the broker
acknowledges the subscription, and no tick ever arrives. So the backoff resets
on a data frame, never on a successful connect, and a source that goes quiet
past `QT_FEED_SILENCE_SEC` is torn down and reopened.

**Absent is not zero.** An unquoted leg, an unpopulated greek and a straddle
with no recoverable vol all come back as null, everywhere, on both sides of the
wire. A zero in any of those places gets drawn as a real observation — of a
market with no volatility, or an option worth nothing — and that is the class of
bug this codebase spends the most effort refusing to have.

## Known gaps

- `go test -race` needs cgo and a C compiler, which the Windows dev box does not
  have. The concurrency here is worth a race run on a machine that does.
- One live source (the Nubra Python bridge). The failover router, the breakers
  and the promotion logic are all exercised by tests, but no second broker is
  wired in yet — that is what `feed.Source` is shaped for.
