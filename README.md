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
```

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
