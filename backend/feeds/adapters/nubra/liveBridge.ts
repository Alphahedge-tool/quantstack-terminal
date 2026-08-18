/**
 * Process supervisor for `scripts/nubra_ws_bridge.py`.
 *
 * Nubra's realtime feed only exists behind their Python SDK, so a live
 * subscription is a child process rather than a socket we own. Everything
 * broker-shaped about that — the base64 argv handshake, NDJSON framing, which
 * python to run — stops at this file; callers get typed events and a stop().
 *
 * Deliberately NOT part of MarketDataFeed. `subscribe(keys, cb)` in
 * feeds/types.ts is the contract a second broker would implement, and it speaks
 * InstrumentKey. This speaks Nubra refIds and chain payloads, which is exactly
 * the kind of thing the adapter boundary exists to contain. Phase 3 can lift it
 * behind `subscribe()` once there is a second live feed to generalise against.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Event shapes ─────────────────────────────────────────────────────────────

/** One line of the bridge's stdout. `data` stays raw — the consumer normalises. */
export interface BridgeEvent {
  event:            'status' | 'error' | 'log' | 'option' | 'orderbook' | 'greeks' | 'ohlcv' | 'index';
  received_at_ms?:  number;
  status?:          string;
  message?:         string;
  data?:            unknown;
  [extra: string]:  unknown;
}

export interface BridgeConfig {
  environment: 'prod' | 'uat';
  token:       string;
  deviceId:    string;
  exchange:    string;
  refIds:      string[];

  /**
   * Which subscription shape the bridge should open.
   *
   *   straddle  (default) one chain: option + ohlcv + orderbook + greeks,
   *             around a single symbol/expiry. What the live straddle engine
   *             needs, and the historical behaviour of this file.
   *   quotes    per-contract: `greeks` by refId plus `index` for whatever
   *             underlyings were named. Addresses arbitrary contracts across
   *             assets, which a chain key (ASSET:EXPIRY) cannot express, and
   *             costs 1 session-weight per contract against the chain's 20 per
   *             key. This is what `NubraFeed.subscribe()` opens.
   */
  mode?:       'straddle' | 'quotes';

  /** Underlyings to stream over `index`, for a spot that ticks. Quotes mode. */
  indexSymbols?: string[];

  /**
   * Ask Nubra for static end-of-day data instead of live ticks.
   *
   * Outside market hours every channel is silent, so a subscription succeeds
   * and then never publishes — indistinguishable downstream from a broken
   * feed. This swaps to the post-market snapshot so the terminal has something
   * to show and to test against after the close. Never set during market
   * hours: the data does not update.
   */
  postMarket?: boolean;

  // ── straddle mode only ──
  symbol?:     string;
  spotSymbol?: string;
  interval?:   string;
  /** Compact YYYYMMDD — the form Nubra's option subscription expects. */
  expiry?:     string;
}

export interface BridgeHandle {
  stop(): void;
  readonly alive: boolean;
}

// ── Script + interpreter resolution ──────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));

/**
 * Both layouts, because both are real: `tsx main.ts` puts this file at
 * backend/feeds/adapters/nubra/, and `node dist/main.js` puts it at
 * backend/dist/feeds/adapters/nubra/ — where there is no scripts/ alongside.
 * Same failure mode the .env loader in main.ts already guards against.
 */
const SCRIPT_CANDIDATES = [
  resolve(__dir, '..', '..', '..', 'scripts', 'nubra_ws_bridge.py'),
  resolve(__dir, '..', '..', '..', '..', 'scripts', 'nubra_ws_bridge.py'),
];

function scriptPath(): string {
  const hit = SCRIPT_CANDIDATES.find((p) => existsSync(p));
  if (!hit) {
    throw new Error(
      `nubra_ws_bridge.py not found. Looked in: ${SCRIPT_CANDIDATES.join(', ')}`,
    );
  }
  return hit;
}

/** Override when python is not on PATH, or to pin a venv that has the SDK. */
function pythonExe(): string {
  return process.env.QT_PYTHON || 'python';
}

// ── Supervisor ───────────────────────────────────────────────────────────────

export function startBridge(
  config: BridgeConfig,
  onEvent: (e: BridgeEvent) => void,
  onExit: (code: number | null) => void,
): BridgeHandle {
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');

  let proc: ChildProcess;
  try {
    proc = spawn(pythonExe(), [scriptPath(), encoded], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    onEvent({ event: 'error', message: `Could not start live bridge: ${(err as Error).message}` });
    onExit(null);
    return { stop() {}, get alive() { return false; } };
  }

  // `proc` stays non-null for the wiring below; `child` is the lifecycle handle
  // that goes null once the process is gone.
  const child = proc;
  let running = true;
  let stopped = false;

  // stdout is NDJSON, but a chunk boundary lands mid-line often enough that
  // parsing per-chunk silently drops ticks. Buffer the tail until its newline.
  let buffer = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as BridgeEvent);
      } catch {
        // Anything the SDK prints that isn't ours — surfaced, not swallowed:
        // a stray traceback here is usually the whole explanation for silence.
        onEvent({ event: 'log', message: line.slice(0, 500) });
      }
    }
  });

  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    const message = chunk.trim();
    if (message) onEvent({ event: 'log', message: message.slice(0, 500) });
  });

  // ENOENT here means no python on PATH — by far the most common setup failure,
  // and worth saying in those words rather than passing the raw errno up.
  child.on('error', (err: NodeJS.ErrnoException) => {
    onEvent({
      event: 'error',
      message: err.code === 'ENOENT'
        ? `Python not found (tried "${pythonExe()}"). Live ticks need python with nubra_python_sdk installed; set QT_PYTHON to override.`
        : `Live bridge failed: ${err.message}`,
    });
  });

  child.on('exit', (code) => {
    running = false;
    if (!stopped) onExit(code);
  });

  return {
    stop() {
      stopped = true;
      if (running && !child.killed) child.kill();
      running = false;
    },
    get alive() { return running; },
  };
}
