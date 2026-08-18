/**
 * The `/ws/assistant` wire protocol, mirrored for the browser.
 *
 * Hand-mirrored from backend/assistant/types.ts rather than shared through a
 * package: the frontend and backend are separate TS projects here (they do not
 * share a tsconfig), and every other channel in this app mirrors its frames the
 * same way. The cost is that a backend change has to be reflected here; the
 * benefit is that neither build depends on the other's compile.
 *
 * Anything the client does not model is IGNORED rather than rejected — see
 * `parseFrame`. The server is free to add event types, and a stricter client
 * would drop the whole connection over a frame it could have skipped.
 */

export const IRIS_PATH = '/ws/assistant';

export type MetricName =
  | 'oi' | 'ltp' | 'iv' | 'volume'
  | 'delta' | 'gamma' | 'vega' | 'theta'
  | 'pcr' | 'spot';

export type OptionSide = 'CE' | 'PE';

export type BuildupKind =
  | 'long-buildup' | 'short-buildup' | 'short-covering' | 'long-unwinding' | 'flat';

export interface Significance {
  z: number;
  level: 'normal' | 'notable' | 'significant' | 'extreme';
  samples: number;
}

export interface CardRow {
  label: string;
  value: string;
  tone?: 'up' | 'down' | 'neutral';
}

export interface ChainStrikeRow {
  strike: number;
  ceOi?: number;   peOi?: number;
  ceOiChg?: number; peOiChg?: number;
  ceLtp?: number;  peLtp?: number;
  ceIv?: number;   peIv?: number;
  atm?: boolean;
}

export interface BuildupRow {
  strike: number;
  side: OptionSide;
  kind: BuildupKind;
  oiChgPct: number;
  ltpChgPct: number;
  oi: number;
}

export interface WatchSummary {
  id: string;
  exchange: string;
  symbol: string;
  expiry: string;
  strike?: number;
  side?: OptionSide;
  metric: MetricName;
  windowMs: number;
  threshold: number;
  mode: 'pct' | 'abs' | 'auto';
  direction: 'up' | 'down' | 'either';
  cooldownMs: number;
  createdAt: number;
  lastFiredAt?: number;
  firedCount: number;
  label: string;
  sessionId: string;
  paused?: boolean;
  current?: number;
  deltaPct?: number;
}

export interface AlertEvent {
  id: string;
  watchId: string;
  sessionId: string;
  firedAt: number;
  target: {
    exchange: string; symbol: string; expiry: string;
    strike?: number; side?: OptionSide;
  };
  metric: MetricName;
  from: number;
  to: number;
  deltaPct: number;
  windowMs: number;
  direction: 'up' | 'down';
  significance?: Significance;
  buildup?: BuildupKind;
  text: string;
  speak: string;
}

export type Card =
  | { kind: 'quote';   title: string; rows: CardRow[] }
  | { kind: 'change';  title: string; metric: MetricName; from: number; to: number;
      deltaPct: number; windowMs: number; significance?: Significance; rows: CardRow[] }
  | { kind: 'chain';   title: string; spot?: number; atm?: number; pcr?: number;
      maxPain?: number; strikes: ChainStrikeRow[] }
  | { kind: 'series';  title: string; metric: MetricName; unit?: string;
      points: Array<{ ts: number; v: number }> }
  | { kind: 'watches'; title: string; watches: WatchSummary[] }
  | { kind: 'alerts';  title: string; alerts: AlertEvent[] }
  | { kind: 'buildup'; title: string; rows: BuildupRow[] }
  | { kind: 'note';    title: string; body: string };

export interface Reply {
  id: string;
  text: string;
  speak?: string;
  cards?: Card[];
  awaiting?: string;
  intent: string;
  confidence: number;
  error?: boolean;
}

// ── Frames ───────────────────────────────────────────────────────────────────

export type IrisFrame =
  | { event: 'hello';    sessionId: string; name: string }
  | { event: 'thinking'; id: string }
  | ({ event: 'reply' } & Reply)
  | { event: 'alert';    alert: AlertEvent }
  | { event: 'watches';  watches: WatchSummary[] }
  | { event: 'pong';     t: number };

/**
 * Narrow a raw frame, or null to ignore it.
 *
 * Only the `event` discriminant is validated. Deep-validating every field would
 * mean re-implementing the backend's types as runtime schemas, and the failure
 * it protects against — a field of the wrong type — degrades to a blank cell,
 * while the failure it CAUSES — a rejected frame — silently loses an alert.
 */
export function parseFrame(raw: unknown): IrisFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = (raw as { event?: unknown }).event;
  if (typeof event !== 'string') return null;

  switch (event) {
    case 'hello':
    case 'thinking':
    case 'reply':
    case 'alert':
    case 'watches':
    case 'pong':
      return raw as IrisFrame;
    default:
      return null;
  }
}
