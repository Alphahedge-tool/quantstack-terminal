# Backend architecture — target layout

This tree is a **plan, not the current state**. Every directory below is empty except for a
`README.md` saying what belongs there and which files it should come from. No code has moved.
The backend still runs entirely out of the flat layout — `routes/`, `live/`, `feeds/`,
`engine/`, `lib/`, `assistant/` and so on — and will keep doing so until each subsystem is
migrated deliberately.

Read a directory's `README.md` for one of two things:

- **`## Migrate from`** — the real files that belong there today. This is a move waiting to happen.
- **`## Status`** — nothing exists for it. The directory marks a decision not yet made, not
  pending work. Roughly a third of the tree is this, and that is worth knowing before treating
  the shape as a to-do list.

## Three deviations from the proposed diagram

**1. Everything is nested under `backend/`, not the repo root.**
The diagram places `src/` at the repository root, but the root `src/` is already the React
frontend (`src/pages`, `src/components`, `src/hooks`). Two different `src/` trees cannot share
one root, so the backend's version lives at `backend/src/`. Same for `apps/`, `tests/`,
`config/` and `data/`.

**2. `backend-go/` is left exactly where it is.**
The diagram lists `apps/marketd/main.go` and `apps/computed/main.go` *alongside*
`backend-go/cmd/{marketd,computed}/main.go` — the same two binaries in two places. It also
proposes `backend-go/internal/{market,decoder,compute,greeks,volatility,protocol}`, but the Go
tree already has `agg/`, `api/`, `book/`, `feed/`, `hub/`, `market/`, `metrics/`, `straddle/`
and `tick/`, **with tests**. Reshaping that would discard working code to satisfy a diagram, so
`backend-go/` stays as-is and `backend/apps/` covers only the Node process.

**3. `zerodha` exists and `upstox` does not.**
The diagram lists brokers `nubra`, `kotak`, `angelone`, `upstox`. The actual adapters are
`nubra`, `kotak`, `angel`, `zerodha`. `src/brokers/zerodha/` has been added because it is real
and registered; `src/brokers/upstox/` is present but marked as having nothing behind it.

## Two things to settle before migrating

**Path aliases.** `backend/tsconfig.json` has no `baseUrl` or `paths`. Nesting code three or
four levels deep without them turns every cross-module import into `../../../`, which is both
unreadable and a merge-conflict magnet. Add something like `"@/*": ["src/*"]` **before** the
first move, not after.

**Timing against the remote.** This repo is taking frequent pushes — three large commits in the
last few days. A migration rewrites the import line of nearly every backend file, so anything
landing upstream in the meantime will conflict with almost all of it. Migrate a subsystem when
you know nothing large is in flight, and finish it in one sitting rather than leaving a tree
half-moved.

## Suggested order

Leaf-first, so each step touches the fewest importers and can be verified with
`npm run lint` before the next one:

| # | Subsystem | Why here |
|---|-----------|----------|
| 1 | `src/observability` | `logger.ts` / `metrics.ts` are self-contained and newly added |
| 2 | `src/core/types`, `src/core/errors` | Types have no runtime behaviour to break |
| 3 | `src/storage/**` | `parquetStore.ts` is one file with few importers |
| 4 | `src/analytics/**` | Mostly pure functions |
| 5 | `src/instruments/**` | Self-contained, one clear boundary |
| 6 | `src/market/**` | Depends on 2 and 5 |
| 7 | `src/brokers/**` | The largest and most-imported; do it once the layers under it are stable |
| 8 | `src/trading/**` | Depends on brokers |
| 9 | `apps/api/**` | Last — everything else imports *into* it, so moving it first breaks the most |

`scripts/` stays where it is until the code it probes has moved, since every verify script
imports from across the tree.
