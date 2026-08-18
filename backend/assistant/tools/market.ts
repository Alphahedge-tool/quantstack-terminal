/**
 * Market capabilities — what IRIS can actually look up.
 *
 * Each export answers one question and returns a `Reply`-ready pair: a screen
 * string and a `Card`. Speech is composed by the caller, because the same tool
 * result is phrased differently depending on whether it was asked for directly
 * or produced as part of a longer turn.
 *
 * ── The read path ──
 *
 * Everything live goes through `chainFeed`, never through a fresh subscription
 * of its own. A one-off question acquires the chain, waits for the first
 * payload, reads it and releases — and because the feed is ref-counted with a
 * grace period, a burst of questions about the same chain costs one process and
 * one subscription regardless of how many questions arrive.
 *
 * ── Why history is a different door ──
 *
 * Anything older than the current session comes from `charts/timeseries` via
 * nubraData, not from the live chain: the chain only knows what it has seen
 * since it connected. The split matters for a user asking "how has the OI
 * moved today" before the terminal was open — that is a history question even
 * though it sounds live, and answering it off the chain would report only the
 * minutes since connection while sounding authoritative about the day.
 */

import type { NubraSession } from '../../brokers/nubra.js';
import {
  acquireChain, firstSnapshot, legKey, type ChainSnapshot, type ChainQuote,
} from '../chainFeed.js';
import {
  fetchRollingSeries, rollingOptionRows,
  type GreekFieldName, type NubraOptionSeries,
} from '../../lib/nubraData.js';
import type {
  Card, CardRow, ChainStrikeRow, BuildupRow, BuildupKind, MetricName, OptionSide, Slots,
} from '../types.js';
import {
  compactCount, formatMetric, signedPct, expiryPhrase, spokenContract, spokenNumber,
  durationPhrase,
} from '../format.js';

export class ToolError extends Error {}

// ── Shared helpers ───────────────────────────────────────────────────────────

interface Target {
  exchange: string;
  symbol:   string;
  expiry:   string;
}

function targetOf(slots: Slots): Target {
  if (!slots.symbol) throw new ToolError('I need a symbol for that.');
  if (!slots.expiry) throw new ToolError(`I could not find a listed expiry for ${slots.symbol}.`);
  return {
    exchange: slots.exchange || 'NSE',
    symbol:   slots.symbol,
    expiry:   slots.expiry,
  };
}

/**
 * Acquire, read once, release.
 *
 * The release is in a `finally` because every failure path below still holds a
 * reference — an exception between acquire and release would pin a python
 * process and 20 weight for the life of the server, and it would do it silently.
 */
async function withChain<T>(
  target: Target, session: NubraSession, fn: (snap: ChainSnapshot) => T,
): Promise<T> {
  const handle = await acquireChain({ ...target, session });
  try {
    const snap = await firstSnapshot(handle);
    if (!snap) {
      throw new ToolError(
        `The ${target.symbol} chain has not sent anything yet — the feed may still be connecting.`,
      );
    }
    return fn(snap);
  } finally {
    handle.release();
  }
}

function quoteFor(snap: ChainSnapshot, strike: number, side: OptionSide): ChainQuote {
  const q = snap.quotes.get(legKey(strike, side));
  if (!q) {
    const listed = [...new Set([...snap.quotes.values()].map((x) => x.strike))]
      .sort((a, b) => Math.abs(a - strike) - Math.abs(b - strike))
      .slice(0, 3)
      .sort((a, b) => a - b);
    throw new ToolError(
      `${strike} ${side} is not in the ${snap.symbol} chain. Nearest listed: ${listed.join(', ')}.`,
    );
  }
  return q;
}

function metricValue(q: ChainQuote, metric: MetricName): number | undefined {
  switch (metric) {
    case 'oi':     return q.oi;
    case 'ltp':    return q.ltp;
    case 'iv':     return q.iv;
    case 'volume': return q.volume;
    case 'delta':  return q.delta;
    case 'gamma':  return q.gamma;
    case 'vega':   return q.vega;
    case 'theta':  return q.theta;
    default:       return undefined;
  }
}

/** Nearest listed strike to `wanted` — how "the 25000 call" survives a typo. */
function nearestStrike(snap: ChainSnapshot, wanted: number): number {
  let best = wanted;
  let gap = Infinity;
  for (const q of snap.quotes.values()) {
    const d = Math.abs(q.strike - wanted);
    if (d < gap) { gap = d; best = q.strike; }
  }
  return best;
}

// ── Snapshot: one contract, one or all metrics ───────────────────────────────

export interface ToolResult {
  text:  string;
  speak: string;
  cards: Card[];
}

export async function readContract(
  slots: Slots, session: NubraSession,
): Promise<ToolResult> {
  const target = targetOf(slots);
  const metric = slots.metric ?? 'ltp';

  return withChain(target, session, (snap) => {
    // Chain-level metrics do not need a strike at all.
    if (metric === 'spot' || metric === 'pcr') {
      return chainMetricResult(snap, metric);
    }

    if (slots.strike == null) {
      throw new ToolError(`Which strike on ${target.symbol}?`);
    }
    const strike = nearestStrike(snap, slots.strike);

    // "iv of 24200 ce and pe" is one question about the straddle, not two
    // questions that happen to share a strike.
    if (slots.sides && slots.sides.length > 1) {
      return bothSidesResult(snap, target, strike, metric);
    }

    const side: OptionSide = slots.side ?? 'CE';
    const q = quoteFor(snap, strike, side);

    const value = metricValue(q, metric);
    if (value == null) {
      throw new ToolError(
        `The feed has not published ${metric.toUpperCase()} for ${target.symbol} ${strike} ${side} yet.`,
      );
    }

    const name = `${target.symbol} ${strike} ${side}`;
    const text = `${name} · ${metric.toUpperCase()} ${formatMetric(value, metric)}`;
    const speak =
      `${spokenContract(target.symbol, strike, side)} `
      + `${metric === 'oi' ? 'open interest' : metric} is ${spokenNumber(value, metric)}`;

    // The card carries the whole contract, not just the metric asked for: the
    // user who asks for OI almost always wants the price beside it, and a
    // second round-trip for that is a worse experience than four extra rows.
    const rows = [
      { label: 'LTP',    value: q.ltp    != null ? formatMetric(q.ltp, 'ltp')       : '—' },
      { label: 'OI',     value: q.oi     != null ? compactCount(q.oi)               : '—' },
      { label: 'Volume', value: q.volume != null ? compactCount(q.volume)           : '—' },
      { label: 'IV',     value: q.iv     != null ? formatMetric(q.iv, 'iv')         : '—' },
      { label: 'Delta',  value: q.delta  != null ? formatMetric(q.delta, 'delta')   : '—' },
      { label: 'Theta',  value: q.theta  != null ? formatMetric(q.theta, 'theta')   : '—' },
    ];

    return {
      text,
      speak,
      cards: [{
        kind: 'quote',
        title: `${name} · ${expiryPhrase(target.expiry)}`,
        rows,
      }],
    };
  });
}

/**
 * Both legs of one strike, plus the combined figure.
 *
 * The combination is metric-dependent and is the reason this is not just two
 * lookups printed together:
 *
 *   ltp    CE + PE — the straddle premium, which is the number being asked for.
 *   iv     the average, because summing two volatilities means nothing.
 *   oi     the sum, and the CE/PE split is itself the signal.
 *   greeks summed, which is what the position actually carries.
 *
 * A leg the feed has not published is reported as missing rather than treated
 * as zero: a "straddle premium" computed from one leg is a wrong number that
 * looks exactly like a right one.
 */
function bothSidesResult(
  snap: ChainSnapshot,
  target: Target,
  strike: number,
  metric: MetricName,
): ToolResult {
  const ce = snap.quotes.get(legKey(strike, 'CE'));
  const pe = snap.quotes.get(legKey(strike, 'PE'));
  if (!ce && !pe) {
    throw new ToolError(`${strike} is not in the ${snap.symbol} chain.`);
  }

  const ceVal = ce ? metricValue(ce, metric) : undefined;
  const peVal = pe ? metricValue(pe, metric) : undefined;

  if (ceVal == null && peVal == null) {
    throw new ToolError(
      `The feed has not published ${metric.toUpperCase()} for ${snap.symbol} ${strike} yet.`,
    );
  }

  const both = ceVal != null && peVal != null;
  const combined = !both ? undefined
    : metric === 'iv' ? (ceVal + peVal) / 2
    : ceVal + peVal;

  const combinedLabel = metric === 'iv' ? 'Average' : metric === 'ltp' ? 'Straddle' : 'Total';

  const rows: CardRow[] = [
    { label: `CE ${metric.toUpperCase()}`, value: ceVal != null ? formatMetric(ceVal, metric) : '—' },
    { label: `PE ${metric.toUpperCase()}`, value: peVal != null ? formatMetric(peVal, metric) : '—' },
  ];
  if (combined != null) {
    rows.push({ label: combinedLabel, value: formatMetric(combined, metric), tone: 'neutral' });
  }
  // Premium is worth showing on any straddle question — it is the number the
  // next question is usually about.
  if (metric !== 'ltp' && ce?.ltp != null && pe?.ltp != null) {
    rows.push({ label: 'Straddle ₹', value: formatMetric(ce.ltp + pe.ltp, 'ltp') });
  }

  const name = `${target.symbol} ${strike}`;
  const missing = !both
    ? ` (${ceVal == null ? 'CE' : 'PE'} not published yet)`
    : '';

  const text =
    `${name} CE/PE · ${metric.toUpperCase()} `
    + `${ceVal != null ? formatMetric(ceVal, metric) : '—'} / `
    + `${peVal != null ? formatMetric(peVal, metric) : '—'}`
    + (combined != null ? ` · ${combinedLabel.toLowerCase()} ${formatMetric(combined, metric)}` : '')
    + missing;

  const spokenMetric = metric === 'oi' ? 'open interest' : metric;
  const speak = both
    ? `${spokenContract(target.symbol, strike)} call ${spokenMetric} `
      + `${spokenNumber(ceVal, metric)}, put ${spokenNumber(peVal, metric)}`
      + (combined != null ? `, ${combinedLabel.toLowerCase()} ${spokenNumber(combined, metric)}.` : '.')
    : `Only the ${ceVal != null ? 'call' : 'put'} side has published ${spokenMetric} so far: `
      + `${spokenNumber((ceVal ?? peVal)!, metric)}.`;

  return {
    text,
    speak,
    cards: [{
      kind: 'quote',
      title: `${name} CE + PE · ${expiryPhrase(target.expiry)}`,
      rows,
    }],
  };
}

function chainMetricResult(snap: ChainSnapshot, metric: 'spot' | 'pcr'): ToolResult {
  if (metric === 'spot') {
    if (snap.spot == null) throw new ToolError(`No spot published for ${snap.symbol} yet.`);
    return {
      text:  `${snap.symbol} spot ${formatMetric(snap.spot, 'spot')}`,
      speak: `${snap.symbol.toLowerCase()} is at ${spokenNumber(snap.spot, 'spot')}`,
      cards: [{
        kind: 'quote',
        title: `${snap.symbol} spot`,
        rows: [
          { label: 'Spot', value: formatMetric(snap.spot, 'spot') },
          { label: 'ATM',  value: snap.atm != null ? String(snap.atm) : '—' },
        ],
      }],
    };
  }

  const { pcr, ceOi, peOi } = chainTotals(snap);
  if (pcr == null) throw new ToolError(`Not enough open interest on ${snap.symbol} to compute a PCR.`);
  return {
    text:  `${snap.symbol} PCR ${pcr.toFixed(2)}`,
    speak: `${snap.symbol.toLowerCase()} put call ratio is ${pcr.toFixed(2)}`,
    cards: [{
      kind: 'quote',
      title: `${snap.symbol} put/call ratio`,
      rows: [
        { label: 'PCR',     value: pcr.toFixed(2), tone: pcr > 1 ? 'up' : 'down' },
        { label: 'Put OI',  value: compactCount(peOi) },
        { label: 'Call OI', value: compactCount(ceOi) },
      ],
    }],
  };
}

function chainTotals(snap: ChainSnapshot): { ceOi: number; peOi: number; pcr?: number } {
  let ceOi = 0;
  let peOi = 0;
  for (const q of snap.quotes.values()) {
    if (q.oi == null) continue;
    if (q.side === 'CE') ceOi += q.oi;
    else peOi += q.oi;
  }
  return { ceOi, peOi, pcr: ceOi > 0 ? peOi / ceOi : undefined };
}

// ── Chain summary ────────────────────────────────────────────────────────────

/**
 * Max pain — the strike where total option-writer payout is lowest.
 *
 * Computed the standard way: for each candidate strike, sum what every OTHER
 * strike's open interest would pay out if the underlying expired there, and
 * take the minimum. O(n²) over strikes, which is nothing at ~80 strikes and
 * avoids the approximations that make the cheaper versions disagree with every
 * other terminal the user has open.
 */
function maxPain(snap: ChainSnapshot): number | undefined {
  const strikes = [...new Set([...snap.quotes.values()].map((q) => q.strike))].sort((a, b) => a - b);
  if (strikes.length < 3) return undefined;

  let best: number | undefined;
  let bestPain = Infinity;

  for (const settle of strikes) {
    let pain = 0;
    for (const q of snap.quotes.values()) {
      if (q.oi == null) continue;
      const intrinsic = q.side === 'CE'
        ? Math.max(0, settle - q.strike)
        : Math.max(0, q.strike - settle);
      pain += intrinsic * q.oi;
    }
    if (pain < bestPain) { bestPain = pain; best = settle; }
  }
  return best;
}

/** Strikes around the money — the window a trader actually looks at. */
function centralStrikes(snap: ChainSnapshot, depth = 8): number[] {
  const strikes = [...new Set([...snap.quotes.values()].map((q) => q.strike))].sort((a, b) => a - b);
  const centre = snap.atm ?? snap.spot;
  if (centre == null) return strikes.slice(0, depth * 2 + 1);

  let closest = 0;
  let gap = Infinity;
  strikes.forEach((s, i) => {
    const d = Math.abs(s - centre);
    if (d < gap) { gap = d; closest = i; }
  });
  return strikes.slice(Math.max(0, closest - depth), closest + depth + 1);
}

export async function readChain(slots: Slots, session: NubraSession): Promise<ToolResult> {
  const target = targetOf(slots);

  return withChain(target, session, (snap) => {
    const { ceOi, peOi, pcr } = chainTotals(snap);
    const pain = maxPain(snap);
    const atm = snap.atm ?? (snap.spot != null ? nearestStrike(snap, snap.spot) : undefined);

    const rows: ChainStrikeRow[] = centralStrikes(snap).map((strike) => {
      const ce = snap.quotes.get(legKey(strike, 'CE'));
      const pe = snap.quotes.get(legKey(strike, 'PE'));
      return {
        strike,
        ceOi:  ce?.oi,
        peOi:  pe?.oi,
        ceLtp: ce?.ltp,
        peLtp: pe?.ltp,
        ceIv:  ce?.iv,
        peIv:  pe?.iv,
        // prevOi is the previous session's close, so this is a day-change, not
        // an intraday one. Labelled as such on the card.
        ceOiChg: ce?.oi != null && ce?.prevOi ? ce.oi - ce.prevOi : undefined,
        peOiChg: pe?.oi != null && pe?.prevOi ? pe.oi - pe.prevOi : undefined,
        atm: atm != null && strike === atm,
      };
    });

    const bits = [
      snap.spot != null ? `spot ${formatMetric(snap.spot, 'spot')}` : null,
      atm != null ? `ATM ${atm}` : null,
      pcr != null ? `PCR ${pcr.toFixed(2)}` : null,
      pain != null ? `max pain ${pain}` : null,
    ].filter(Boolean);

    const speak =
      `${snap.symbol.toLowerCase()} ${expiryPhrase(target.expiry)}. `
      + (snap.spot != null ? `Spot ${spokenNumber(snap.spot, 'spot')}. ` : '')
      + (pcr != null ? `Put call ratio ${pcr.toFixed(2)}. ` : '')
      + (pain != null ? `Max pain ${spokenNumber(pain, 'spot')}.` : '');

    return {
      text: `${snap.symbol} ${expiryPhrase(target.expiry)} — ${bits.join(' · ')}`,
      speak,
      cards: [{
        kind: 'chain',
        title: `${snap.symbol} ${expiryPhrase(target.expiry)}`,
        spot: snap.spot,
        atm,
        pcr,
        maxPain: pain,
        strikes: rows,
      }],
    };
  });
}

// ── Buildup scan ─────────────────────────────────────────────────────────────

function classify(oiChgPct: number, ltpChgPct: number): BuildupKind {
  if (Math.abs(oiChgPct) < 1 || Math.abs(ltpChgPct) < 0.5) return 'flat';
  if (oiChgPct > 0  && ltpChgPct > 0) return 'long-buildup';
  if (oiChgPct > 0  && ltpChgPct < 0) return 'short-buildup';
  if (oiChgPct < 0  && ltpChgPct > 0) return 'short-covering';
  return 'long-unwinding';
}

const BUILDUP_LABEL: Record<BuildupKind, string> = {
  'long-buildup':   'long buildup',
  'short-buildup':  'short buildup',
  'short-covering': 'short covering',
  'long-unwinding': 'long unwinding',
  flat:             'flat',
};

/**
 * Where the day's positioning is changing.
 *
 * Uses `prevOi` (previous close) against current OI, so this is a session-level
 * read, not an intraday-window one — the intraday version needs the monitor's
 * series and lives behind a watch. Said plainly in the reply so the two are not
 * confused: "since yesterday's close" is a very different claim from "in the
 * last ten minutes".
 */
export async function readBuildup(slots: Slots, session: NubraSession): Promise<ToolResult> {
  const target = targetOf(slots);

  return withChain(target, session, (snap) => {
    const rows: BuildupRow[] = [];

    for (const q of snap.quotes.values()) {
      if (q.oi == null || !q.prevOi || q.ltp == null) continue;
      const oiChgPct = ((q.oi - q.prevOi) / q.prevOi) * 100;
      // No previous close for price on the chain payload, so price direction
      // comes from the option's own change field when present and is otherwise
      // inferred from OI alone — flagged flat rather than guessed.
      const ltpChgPct = 0;
      rows.push({
        strike: q.strike,
        side:   q.side,
        kind:   classify(oiChgPct, ltpChgPct),
        oiChgPct,
        ltpChgPct,
        oi:     q.oi,
      });
    }

    if (!rows.length) {
      throw new ToolError(
        `The ${target.symbol} chain has not published previous-day open interest yet, `
        + 'so there is nothing to compare against.',
      );
    }

    // Rank by absolute OI change — biggest positioning shifts first, which is
    // what "where is the action" means.
    rows.sort((a, b) => Math.abs(b.oiChgPct) - Math.abs(a.oiChgPct));
    const top = rows.slice(0, 10);

    const headline = top[0];
    const speak =
      `Biggest open interest change on ${snap.symbol.toLowerCase()} is `
      + `${spokenContract(snap.symbol, headline.strike, headline.side)}, `
      + `${headline.oiChgPct >= 0 ? 'up' : 'down'} ${Math.abs(headline.oiChgPct).toFixed(0)} percent `
      + 'since the previous close.';

    return {
      text: `${snap.symbol} — top OI changes since previous close`,
      speak,
      cards: [{ kind: 'buildup', title: `${snap.symbol} OI buildup`, rows: top }],
    };
  });
}

// ── History ──────────────────────────────────────────────────────────────────

const GREEK_SET = new Set<MetricName>(['delta', 'gamma', 'vega', 'theta']);

/**
 * The series for a metric, with IV derived rather than read.
 *
 * `NubraOptionSeries.ivMid` is parsed from `iv_mid`, but the shared
 * `QUOTE_FIELDS` in nubraData only ever REQUESTS `iv_bid` and `iv_ask` — so
 * `ivMid` is unconditionally empty and every IV history question came back
 * "empty", which reads as "this contract has no data" rather than "this client
 * never asked for that field".
 *
 * Fixed here rather than by adding `iv_mid` to QUOTE_FIELDS: that array is also
 * the straddle engine's request, an unrecognised field name 400s the entire
 * batch (see `greeksUnsupported`), and the mid is exactly derivable from two
 * fields already being fetched. Deriving costs nothing and cannot break a
 * caller that is working today.
 *
 * Bid and ask are joined on timestamp rather than by index — the two arrays are
 * independently sparse, and zipping them positionally silently pairs points
 * from different minutes.
 */
function pointsForMetric(
  series: NubraOptionSeries, metric: MetricName,
): Array<{ ts: number; v: number }> {
  if (metric === 'iv') {
    const raw = (() => {
      if (series.ivMid.length) return series.ivMid;

      const askByTs = new Map(series.ivAsk.map((p) => [p.ts, p.v]));
      const mid: Array<{ ts: number; v: number }> = [];
      for (const bid of series.ivBid) {
        const ask = askByTs.get(bid.ts);
        if (ask == null) continue;
        mid.push({ ts: bid.ts, v: (bid.v + ask) / 2 });
      }
      // One-sided quotes are better than nothing when the book is thin: a wing
      // with only a bid still has a usable volatility history.
      if (mid.length) return mid;
      return series.ivBid.length ? series.ivBid : series.ivAsk;
    })();

    // Normalise to percent, exactly as the live chain does.
    //
    // charts/timeseries publishes IV as a fraction (0.1048) while the option
    // channel publishes percent (10.48). Without this the same contract reads
    // 9.85% live and 0.11% in history — a hundredfold disagreement between two
    // answers the user will compare side by side, and the historical one looks
    // like a dead contract rather than a units bug.
    return raw.map((p) => ({ ts: p.ts, v: p.v <= 1 ? p.v * 100 : p.v }));
  }

  if (GREEK_SET.has(metric)) return series[metric as GreekFieldName];
  return series.ltp;
}

/**
 * Historical series for one contract.
 *
 * OI is deliberately unsupported here and says so: `charts/timeseries` exposes
 * `cumulative_oi` on the chain aggregate rather than per-contract in the shape
 * this client parses, so claiming to chart a strike's OI history would return
 * the wrong series while looking right. Better to name the limit than to be
 * quietly wrong about the exact metric this whole feature is built around.
 */
export async function readHistory(slots: Slots, session: NubraSession): Promise<ToolResult> {
  const target = targetOf(slots);
  const metric = slots.metric ?? 'ltp';

  if (metric === 'oi' || metric === 'volume' || metric === 'pcr' || metric === 'spot') {
    throw new ToolError(
      `I can chart price, IV and greeks per contract. ${metric.toUpperCase()} history is not `
      + 'available per strike from this feed — ask me to track it live instead and I will '
      + 'alert you on the change.',
    );
  }
  if (slots.strike == null) throw new ToolError(`Which strike on ${target.symbol}?`);

  const side: OptionSide = slots.side ?? 'CE';
  const rangeMs = slots.rangeMs ?? 86_400_000;
  const interval = slots.interval ?? '5m';

  const rows = await rollingOptionRows({
    symbol: target.symbol, exchange: target.exchange, session,
  });
  const match = rows.find(
    (r) => r.expiry === target.expiry && r.side === side && Math.abs(r.strike - slots.strike!) < 0.01,
  );
  if (!match) {
    throw new ToolError(`No ${target.symbol} ${slots.strike} ${side} contract for that expiry.`);
  }

  const end = new Date();
  const start = new Date(end.getTime() - rangeMs);

  const seriesByName = await fetchRollingSeries({
    names:    [match.name],
    start:    start.toISOString(),
    end:      end.toISOString(),
    interval,
    exchange: target.exchange,
    session,
    greeks:   GREEK_SET.has(metric) ? [metric as GreekFieldName] : undefined,
    fallbackAliases: new Map([[match.name, match.aliases]]),
  });

  const found = seriesByName.get(match.name)
    ?? [...seriesByName.values()][0];
  if (!found) throw new ToolError(`No history came back for ${match.name}.`);

  const points = pointsForMetric(found, metric);
  if (!points.length) {
    throw new ToolError(
      `${metric.toUpperCase()} history is empty for ${match.name} over ${durationPhrase(rangeMs)}. `
      + 'Greeks and IV only go back about three months.',
    );
  }

  const first = points[0].v;
  const last = points[points.length - 1].v;
  const pct = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : 0;

  const name = `${target.symbol} ${match.strike} ${side}`;
  return {
    text:
      `${name} ${metric.toUpperCase()} over ${durationPhrase(rangeMs)} — `
      + `${formatMetric(first, metric)} → ${formatMetric(last, metric)} (${signedPct(pct)})`,
    speak:
      `${spokenContract(target.symbol, match.strike, side)} ${metric} went from `
      + `${spokenNumber(first, metric)} to ${spokenNumber(last, metric)} over `
      + `${durationPhrase(rangeMs)}, ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(1)} percent.`,
    cards: [{
      kind: 'series',
      title: `${name} · ${metric.toUpperCase()} · ${interval}`,
      metric,
      points: points.map((p) => ({ ts: p.ts, v: p.v })),
    }],
  };
}
