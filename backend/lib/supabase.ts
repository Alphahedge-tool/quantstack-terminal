/**
 * Supabase (PostgREST) reader for the `broker_accounts` table.
 *
 * Hand-rolled over `fetch` rather than `@supabase/supabase-js`: the backend is
 * deliberately dependency-free (see run-stack.mjs), and all this needs is one
 * authenticated GET. The SDK would pull in a realtime client and a websocket
 * stack to do it.
 *
 * Read-only on purpose. Credentials flow one way — Supabase is the book of
 * record, this process never writes back to it.
 *
 * Configure in backend/.env:
 *   SUPABASE_URL=https://<project>.supabase.co
 *   SUPABASE_SERVICE_KEY=sb_secret_…
 *
 * The service key bypasses row-level security, so it belongs in .env (already
 * gitignored) and nowhere near the browser bundle. Nothing here is imported by
 * the frontend, and no route returns a credential field.
 */

/** One row of `public.broker_accounts`. Columns not used here are omitted. */
export interface BrokerAccountRow {
  id:           string;
  position:     number;
  enabled:      boolean;
  alias:        string | null;
  client_code:  string | null;
  broker:       string;
  api_key:      string | null;
  api_secret:   string | null;
  totp_secret:  string | null;
  pin:          string | null;
  phone:        string | null;
  auto_login:   boolean;
  broker_env:   string | null;
  username:     string | null;
  updated_at:   string;
}

/**
 * Supabase refuses a secret key when the caller looks like a browser, and
 * answers 401 `Forbidden use of secret API key in browser` — which reads like a
 * bad key rather than a bad User-Agent. Any UA without a browser token passes;
 * naming ourselves also makes this process identifiable in Supabase's logs.
 */
const USER_AGENT = 'quantstack-backend';

const TIMEOUT_MS = 10_000;

export function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

/** Host:key pair, or null when unconfigured. Read per call so .env order never matters. */
function config(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  return url && key ? { url, key } : null;
}

/**
 * Every broker account, ordered as the user arranged them.
 *
 * Throws on transport or HTTP failure — the caller decides whether that is
 * fatal or merely a reason to fall back to env vars.
 */
export async function fetchBrokerAccounts(): Promise<BrokerAccountRow[]> {
  const cfg = config();
  if (!cfg) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set');

  const url = `${cfg.url}/rest/v1/broker_accounts`
    + '?select=id,position,enabled,alias,client_code,broker,api_key,api_secret'
    + ',totp_secret,pin,phone,auto_login,broker_env,username,updated_at'
    + '&order=position.asc';

  const res = await fetch(url, {
    headers: {
      apikey:         cfg.key,
      Authorization:  `Bearer ${cfg.key}`,
      Accept:         'application/json',
      'User-Agent':   USER_AGENT,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    // PostgREST puts the real reason in the body; the status alone is rarely
    // enough to tell a bad key from a missing table.
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }

  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('Supabase returned a non-array body');
  return rows as BrokerAccountRow[];
}
