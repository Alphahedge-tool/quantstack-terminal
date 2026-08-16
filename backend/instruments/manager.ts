/**
 * Master loading — who downloads what, and when.
 *
 * Loaders split by whether they need a session:
 *
 *   angel     public JSON, no auth. Warmed at boot.
 *   zerodha   needs apiKey + accessToken.
 *   kotak     needs the Neo access token.
 *   upstox    public gzipped JSON, no auth.
 *
 * Session-bound masters therefore cannot be warmed at boot — they load on the
 * first authenticated call for that broker. `ensure()` handles both cases, and
 * every path is single-flighted: a 30 MB download must not run four times
 * because four requests arrived while it was in progress.
 */

import { instruments, type InstrumentStore } from './store.js';
import { loadAngelMaster } from './loaders/angel.js';
import { loadZerodhaMaster } from './loaders/zerodha.js';
import { loadKotakMaster } from './loaders/kotak.js';
import type { InstrumentRow } from './types.js';

/** Credentials a session-bound loader needs. Only the fields it actually uses. */
export interface MasterCredentials {
  apiKey?:      string;
  accessToken?: string;
  baseUrl?:     string;
}

type Loader = (creds: MasterCredentials) => Promise<InstrumentRow[]>;

/**
 * Registered loaders. A broker with no entry here simply has no master, which
 * is a supported state — its adapter can still trade using symbols resolved
 * through another broker's canonical rows.
 */
const LOADERS: Record<string, { load: Loader; needsSession: boolean }> = {
  angel:   { load: () => loadAngelMaster(),      needsSession: false },
  zerodha: { load: (c) => loadZerodhaMaster(c),  needsSession: true  },
  kotak:   { load: (c) => loadKotakMaster(c),    needsSession: true  },
};

const inFlight = new Map<string, Promise<string>>();

function singleflight(broker: string, work: () => Promise<string>): Promise<string> {
  const existing = inFlight.get(broker);
  if (existing) return existing;
  const p = work().finally(() => inFlight.delete(broker));
  inFlight.set(broker, p);
  return p;
}

/**
 * Make sure `broker`'s master is loaded.
 *
 * Order: in-memory → disk cache → download. Returns a short status string for
 * logs; throws only when a download was required and failed.
 */
export async function ensureMaster(
  broker: string,
  creds: MasterCredentials = {},
  { force = false, store = instruments }: { force?: boolean; store?: InstrumentStore } = {},
): Promise<string> {
  const key = broker.toLowerCase();
  const entry = LOADERS[key];
  if (!entry) throw new Error(`No instrument master loader for ${broker}`);

  if (!force && (store.isFresh(key) || store.loadCache(key))) return 'cached';

  return singleflight(key, async () => {
    const rows = await entry.load(creds);
    return `loaded ${store.set(key, rows)}`;
  });
}

/** Which brokers can have a master loaded at all. */
export function loadableBrokers(): string[] {
  return Object.keys(LOADERS);
}

/** Brokers whose master needs no credentials — safe to warm at boot. */
export function publicMasterBrokers(): string[] {
  return Object.entries(LOADERS)
    .filter(([, v]) => !v.needsSession)
    .map(([k]) => k);
}

/**
 * Warm every credential-free master, in the background.
 *
 * Never rejects. A master that fails at boot is retried by `ensureMaster` on the
 * first request that needs it, so a download failure must not take the process
 * down — but it does get logged, because silently running with no canonical
 * table makes every later "instrument not found" impossible to diagnose.
 */
export function warmPublicMasters(): void {
  for (const broker of publicMasterBrokers()) {
    ensureMaster(broker)
      .then((status) => console.log(`[instruments] ${broker} master ${status}`))
      .catch((err) => console.warn(
        `[instruments] ${broker} master unavailable at boot — will retry on demand: ${(err as Error).message}`,
      ));
  }
}

/** Registration seam for loaders added later (zerodha, kotak, upstox). */
export function registerLoader(broker: string, load: Loader, needsSession: boolean): void {
  LOADERS[broker.toLowerCase()] = { load, needsSession };
}
