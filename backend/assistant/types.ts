/**
 * IRIS — shared shapes.
 *
 * One file for every type that crosses a layer boundary inside the assistant,
 * so the NLU, the tools, the monitor and the socket all agree on what a slot,
 * a card and an alert are without importing each other.
 *
 * ── Naming ──
 *
 * IRIS is the assistant's identity, not a module: it is what the user says out
 * loud ("hey iris, track the oi on nifty twenty five thousand call"), what the
 * orb is labelled, and what the wake word matches. Keeping the name in one
 * constant means renaming it later is a one-line change rather than a grep.
 */

export const IRIS_NAME = 'Iris';

// ── Slots ────────────────────────────────────────────────────────────────────

/** Which side of the chain. `''` for a non-option instrument. */
export type OptionSide = 'CE' | 'PE';

/**
 * A metric the engine can read, track and alert on.
 *
 * Deliberately a closed union rather than a free string: every metric here has
 * a known source field on the chain payload, a known unit, and a known
 * significance profile (OI moves in lakhs, delta moves in hundredths). A free
 * string would let the NLU invent "momentum" and the monitor would silently
 * track undefined forever.
 */
export type MetricName =
  | 'oi'        // open interest — contracts
  | 'ltp'       // last traded price — rupees
  | 'iv'        // implied volatility — percent
  | 'volume'    // traded volume — contracts
  | 'delta'
  | 'gamma'
  | 'vega'
  | 'theta'
  | 'pcr'       // put/call ratio — chain-level, no strike
  | 'spot';     // underlying — chain-level, no strike

/** Metrics that describe the whole chain rather than one contract. */
export const CHAIN_METRICS: readonly MetricName[] = ['pcr', 'spot'];

/** How a threshold is expressed. */
export type ThresholdMode =
  | 'pct'       // "moves 5%"
  | 'abs'       // "moves 20000 contracts"
  | 'auto';     // "tell me if anything significant happens" — adaptive, see significance.ts

/** Which direction of move the user cares about. */
export type Direction = 'up' | 'down' | 'either';

/**
 * Everything the NLU can pull out of one utterance.
 *
 * All optional: a turn like "what about the 25100 put" fills two slots and
 * inherits the rest from conversation memory. The tools declare which slots
 * they require, and `understand()` reports what is still missing rather than
 * guessing — guessing a strike is how an assistant reports the wrong contract
 * with total confidence.
 */
export interface Slots {
  symbol?:    string;        // NIFTY, BANKNIFTY, RELIANCE
  exchange?:  string;        // NSE | BSE | MCX
  expiry?:    string;        // compact YYYYMMDD, as refdata and Nubra both key on
  strike?:    number;        // rupees
  side?:      OptionSide;
  /**
   * Both legs, when the utterance named them.
   *
   * "iv of 24200 ce and pe" is one question about two contracts — the straddle
   * — and answering it with only the call is answering a different question.
   * Set alongside `side` (which holds the first named leg) so every consumer
   * that only understands one side still works unchanged.
   */
  sides?:     OptionSide[];
  metric?:    MetricName;
  /** Lookback / evaluation window in ms — "last 10 min" → 600_000. */
  windowMs?:  number;
  /** Historical range in ms, for chart-style questions — "last week". */
  rangeMs?:   number;
  /** Candle interval for history requests — '1m', '5m', '1d'. */
  interval?:  string;
  threshold?: number;
  mode?:      ThresholdMode;
  direction?: Direction;
  /** A watch id the user named — "cancel the second one" resolves to this. */
  watchId?:   string;
  /** Free-text remainder, kept for echoing back in clarifications. */
  rest?:      string;
}

// ── Intents ──────────────────────────────────────────────────────────────────

export type IntentName =
  | 'quote.get'         // "what's nifty 25000 ce trading at"
  | 'metric.get'        // "what's the oi on banknifty 56000 pe"
  | 'change.get'        // "how much has the oi moved in the last 10 minutes"
  | 'chain.summary'     // "show me the nifty chain" / "pcr" / "max pain"
  | 'chain.watchlist'   // "what's building up in nifty"
  | 'history.get'       // "get me 5 minute iv for nifty last week"
  | 'watch.create'      // "track the oi on ... tell me if it moves 5% in 10 min"
  | 'watch.list'
  | 'watch.cancel'
  | 'alerts.recent'
  | 'subscribe.chain'
  | 'unsubscribe.chain'
  | 'help'
  | 'greeting'
  | 'stop'              // voice barge-in: "stop", "quiet", "cancel that"
  | 'unknown';

/** What `understand()` returns. */
export interface Interpretation {
  intent:     IntentName;
  slots:      Slots;
  /** 0..1. Below CONFIDENCE_FLOOR the engine asks rather than acts. */
  confidence: number;
  /** Required slots the utterance and memory together could not supply. */
  missing:    (keyof Slots)[];
  /** The normalised text the scorer actually saw — surfaced for debugging. */
  normalized: string;
  /** Runner-up intents, for "did you mean" phrasing. */
  alternates: Array<{ intent: IntentName; confidence: number }>;
}

// ── Replies ──────────────────────────────────────────────────────────────────

/**
 * A structured result attached to a reply.
 *
 * The spoken text and the card are separate on purpose. Speech has to be a
 * sentence — "nifty twenty five thousand call open interest is up four point
 * two percent over ten minutes" — while the card is a table the eye scans. One
 * payload serving both makes the speech read like a spreadsheet.
 */
export type Card =
  | { kind: 'quote';    title: string; rows: CardRow[] }
  | { kind: 'change';   title: string; metric: MetricName; from: number; to: number;
      deltaPct: number; windowMs: number; significance?: Significance; rows: CardRow[] }
  | { kind: 'chain';    title: string; spot?: number; atm?: number; pcr?: number;
      maxPain?: number; strikes: ChainStrikeRow[] }
  | { kind: 'series';   title: string; metric: MetricName; unit?: string;
      points: Array<{ ts: number; v: number }> }
  | { kind: 'watches';  title: string; watches: WatchSummary[] }
  | { kind: 'alerts';   title: string; alerts: AlertEvent[] }
  | { kind: 'buildup';  title: string; rows: BuildupRow[] }
  | { kind: 'note';     title: string; body: string };

export interface CardRow {
  label: string;
  value: string;
  /** Drives colour: positive green, negative red, neutral default. */
  tone?: 'up' | 'down' | 'neutral';
}

export interface ChainStrikeRow {
  strike:   number;
  ceOi?:    number;
  peOi?:    number;
  ceOiChg?: number;
  peOiChg?: number;
  ceLtp?:   number;
  peLtp?:   number;
  ceIv?:    number;
  peIv?:    number;
  atm?:     boolean;
}

/** OI-vs-price interpretation for one contract. */
export type BuildupKind =
  | 'long-buildup'      // OI ↑  price ↑  — new longs
  | 'short-buildup'     // OI ↑  price ↓  — new shorts
  | 'short-covering'    // OI ↓  price ↑  — shorts closing
  | 'long-unwinding'    // OI ↓  price ↓  — longs closing
  | 'flat';

export interface BuildupRow {
  strike:   number;
  side:     OptionSide;
  kind:     BuildupKind;
  oiChgPct: number;
  ltpChgPct: number;
  oi:       number;
}

/**
 * One reply turn.
 *
 * `speak` is what the voice says; `text` is what the bubble shows. They differ
 * more than you would expect — the bubble can say "OI 1,24,500 (+4.2%)" and the
 * voice has to say "open interest one lakh twenty four thousand five hundred,
 * up four point two percent".
 */
export interface Reply {
  /** Echoes the request id so the client can match it to its pending turn. */
  id:       string;
  text:     string;
  speak?:   string;
  cards?:   Card[];
  /** Set when the engine needs one more slot before it can act. */
  awaiting?: keyof Slots;
  intent:   IntentName;
  confidence: number;
  /** True when the turn failed and the text is an explanation, not an answer. */
  error?:   boolean;
}

// ── Watches + alerts ─────────────────────────────────────────────────────────

export interface WatchTarget {
  exchange: string;
  symbol:   string;
  expiry:   string;
  /** Absent for chain-level metrics (pcr, spot) and for "watch every strike". */
  strike?:  number;
  side?:    OptionSide;
}

export interface Watch extends WatchTarget {
  id:        string;
  metric:    MetricName;
  windowMs:  number;
  threshold: number;
  mode:      ThresholdMode;
  direction: Direction;
  /** Silence window after a fire, so one drifting contract cannot spam. */
  cooldownMs: number;
  createdAt: number;
  lastFiredAt?: number;
  firedCount: number;
  /** Human phrase, echoed in the watch list and the alert. */
  label:     string;
  /** Owning conversation, so a client only hears its own alerts. */
  sessionId: string;
  /** Paused watches stay in the store but are not evaluated. */
  paused?:   boolean;
}

export interface WatchSummary extends Watch {
  /** Latest observed value, so the list shows where the metric is now. */
  current?:  number;
  /** Change over the watch's own window, right now. */
  deltaPct?: number;
}

/** How far outside its own normal a move landed. */
export interface Significance {
  /** Robust z-score of the window-delta against its own recent distribution. */
  z:        number;
  /** 'normal' never fires; the rest do, with escalating language. */
  level:    'normal' | 'notable' | 'significant' | 'extreme';
  /** Samples backing the estimate — below MIN_SAMPLES z is not trustworthy. */
  samples:  number;
}

export interface AlertEvent {
  id:        string;
  watchId:   string;
  sessionId: string;
  firedAt:   number;
  target:    WatchTarget;
  metric:    MetricName;
  from:      number;
  to:        number;
  deltaPct:  number;
  windowMs:  number;
  direction: 'up' | 'down';
  significance?: Significance;
  buildup?:  BuildupKind;
  /** Screen line. */
  text:      string;
  /** Voice line. */
  speak:     string;
}
