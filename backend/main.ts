/**
 * QuantStack Backend — entry point.
 *
 * Startup sequence:
 *   1. Import all route modules (registers routes on the route table)
 *   2. Auto-login to Nubra from env vars (if credentials present)
 *   3. Start HTTP server on port 3001
 *
 * Run:
 *   Development:  npx tsx watch main.ts          (hot-reload)
 *   Production:   npx tsc && node dist/main.js
 *
 * Environment variables (create backend/.env):
 *   NUBRA_PHONE=9XXXXXXXXX
 *   NUBRA_MPIN=XXXX
 *   NUBRA_TOTP_SECRET=XXXXXXXXXXXXXXXXXX
 *   NUBRA_BASE_URL=https://api2.nubra.io        (optional override)
 *   QT_BACKEND_PORT=3001                         (optional)
 */

// Load .env from backend directory
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Manual .env loader (no dotenv dependency)
//
// Two candidate locations, and BOTH are needed. `tsx main.ts` puts __dirname at
// backend/, but the compiled `node dist/main.js` puts it at backend/dist/ —
// where there is no .env. Resolving only against __dirname therefore meant
// production silently ran with no credentials at all: the failure was swallowed
// by the catch below, auto-login failed with "credentials missing", and the only
// way in was to retype the MPIN in the browser on every restart.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_CANDIDATES = [
  resolve(__dirname, '.env'),          // tsx: backend/.env
  resolve(__dirname, '..', '.env'),    // dist: backend/dist/../.env
];

let envLoadedFrom: string | null = null;
for (const candidate of ENV_CANDIDATES) {
  let envFile: string;
  try {
    envFile = readFileSync(candidate, 'utf8');
  } catch {
    continue;   // not here — try the next location
  }
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
  envLoadedFrom = candidate;
  break;
}

if (envLoadedFrom) {
  console.log(`[qt-backend] Loaded .env from ${envLoadedFrom}`);
} else if (process.env.NUBRA_PHONE) {
  console.log('[qt-backend] No .env file — using environment variables from the shell');
} else {
  // Say so loudly. The old silent catch is what let production run credential-
  // less for as long as it did.
  console.warn(
    `[qt-backend] No .env found and no NUBRA_PHONE in the environment.\n`
    + `  Looked in: ${ENV_CANDIDATES.join(', ')}\n`
    + '  Auto-login will fail; the app will ask for credentials in the browser.',
  );
}

// ── Register routes (order doesn't matter; they all write to the route table) ─
import './routes/nubra.js';
import './routes/straddle.js';
import './routes/instruments.js';
import './routes/backtest.js';
import './routes/feeds.js';
import './routes/trading.js';
import './routes/optionMarks.js';
import './routes/ivSurface.js';
import './routes/brokerAccounts.js';
import './routes/zerodhaLogin.js';

// ── Feeds + server ────────────────────────────────────────────────────────────
import { feeds } from './feeds/registry.js';
import { ensureConnected } from './feeds/authManager.js';
import { startHealthProbe } from './feeds/health.js';
import { warmPublicMasters } from './instruments/manager.js';
import { startServer } from './server.js';
import { attachLiveStraddleSocket } from './live/wsStraddle.js';
import { attachLiveOrdersSocket } from './live/wsOrders.js';
import { attachLiveQuotesSocket } from './live/wsQuotes.js';

const PORT = Number(process.env.QT_BACKEND_PORT || 3101);

console.log('[qt-backend] Starting QuantStack backend …');

// Connect every configured feed. Non-blocking, and a failure here is not fatal:
// routes call activeFeed(), which logs in on demand, so a feed that is down at
// boot recovers on its first request rather than requiring a restart.
for (const { feed, priority } of feeds()) {
  ensureConnected(feed)
    .then(() => console.log(`[qt-backend] ${feed.id} ready (priority ${priority})`))
    .catch((e) => console.warn(
      `[qt-backend] ${feed.id} not connected at boot — will retry on first request: ${(e as Error).message}`,
    ));
}

// Warm the canonical instrument table.
//
// Deliberately BEFORE any feed needs it and independent of login: Angel's master
// is public, and having it loaded is what lets the live router prove a broker
// can carry a contract before switching to it. A terminal with no canonical
// table can still serve history, but it cannot switch feeds safely.
warmPublicMasters();

// Recover downed feeds without waiting for a request to arrive.
startHealthProbe();

// Start HTTP server, then bolt the live channels onto the same listener so they
// share the port (and the CORS-free same-origin story) with the REST API.
//
// Both attach their own `upgrade` handler and ignore paths that are not theirs,
// so order is irrelevant and neither can steal the other's sockets.
const server = startServer(PORT);
attachLiveStraddleSocket(server);
attachLiveOrdersSocket(server);
attachLiveQuotesSocket(server);
