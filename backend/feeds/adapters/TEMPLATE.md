# Adding a feed

Everything a second broker needs lives in one directory. No consumer file
changes — if you find yourself editing the straddle engine to add a feed,
something in the contract is wrong and the fix belongs there, not in a special
case.

## 1. Write the adapter

Create `feeds/adapters/<broker>/index.ts` exporting a class that implements
`MarketDataFeed`. Copy the shape from `adapters/nubra/index.ts`; the parts that
are genuinely per-broker are marked below.

```ts
export class YourFeed implements MarketDataFeed {
  readonly id = 'yourbroker';
  readonly capabilities: Capabilities = {
    exchanges:   ['NSE'],          // ONLY what it actually serves
    intervals:   ['1m'],           // ditto — see note on honesty below
    historyDays: 60,
    optionChain: true,
    greeks:      false,            // false if you must solve for IV yourself
    live:        false,
    maxSymbolsPerRequest: 50,      // the upstream cap, not a tuning knob
  };

  async connect()   { /* login. Idempotent. Throw FeedError('AUTH') on bad creds. */ }
  async disconnect(){ }
  isConnected()     { return …; }
  async ping()      { /* cheapest authenticated call you have */ }

  async assets(exchange, date)                  { … }
  async expiries(asset, exchange, date)         { … }   // ISO, ascending
  async chain(asset, exchange, date, expiry?)   { … }
  async underlyings(asset, exchange, date, expiry?) { … }
  async candles(req)                            { … }
  async optionSeries(req)                       { … }
}
```

## 2. Register it

```ts
// feeds/registry.ts
const AVAILABLE = {
  nubra:      (i) => (i ? nubraFeed.withInstance(i) : nubraFeed),
  yourbroker: () => yourFeed,        // ← one line
};
```

```bash
# backend/.env
QT_FEEDS=nubra:1,yourbroker:2
```

That is the whole integration.

## 3. The five things that will bite you

**Units.** Timestamps out of an adapter are epoch **milliseconds**; prices are
**rupees**; IV is a plain decimal (`0.13`, not `13`). Nubra sends nanoseconds
and paise, and converting those is the adapter's job, not the engine's. Getting
this wrong does not throw — it silently produces a chart that is off by 100×.

**Keys, not symbols.** `chain()` returns `InstrumentKey`s, and `optionSeries()`
is handed keys back. Keep your own symbol table inside the adapter and never let
a broker symbol escape; that mapping is precisely what failover replaces.
Round-trip it in a test the way `verify.ts` does for Nubra — if
`key → symbol → key` is not the identity, failover will resolve the wrong
contract rather than fail loudly.

**Expiries.** Normalise through `normalizeExpiry()`. A key built from your feed
must equal a key built from Nubra's for the same contract, or the compute cache
will double-key and the router will look like it is losing data.

**Error classification.** Wrap every throw in `classify(err, this.id)`. Then
check what your broker actually means by each status — Nubra returns `403` for
a request burst, not an authorisation failure, and calling that AUTH would fire
a TOTP login on every rate-limited batch. Getting this wrong is how a working
feed gets marked dead.

**Capability honesty.** Declaring an interval or exchange you cannot really
serve is worse than declaring less. The router trusts `capabilities` to skip
feeds without penalty; a lie turns a free skip into a failed request, three of
which trip your breaker.

## 4. Verify it

Add a section to `feeds/verify.ts` mirroring the Nubra one, and a `MockFeed`
case for whatever your broker does differently. Then:

```bash
npm --prefix backend run verify:feeds
```

The bar is the round-trip test and the unit assertions. Everything else the
router already covers.
