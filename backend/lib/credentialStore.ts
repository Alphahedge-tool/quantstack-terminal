/**
 * Where broker credentials come from.
 *
 * Two sources, in order:
 *
 *   1. Supabase `broker_accounts` — the book of record. Credentials live in one
 *      place, so a second machine running this terminal auto-logs-in without
 *      anyone copying an MPIN into a .env file, and rotating a TOTP secret is
 *      one edit rather than a redeploy.
 *   2. `NUBRA_*` environment variables — the original path. Kept as a fallback
 *      so a checkout with no Supabase configured still works exactly as before,
 *      and so a broker outage in Supabase cannot lock the terminal out of a
 *      machine that already has the secrets locally.
 *
 * Brokers do not agree on what a credential IS. Nubra logs in with a phone
 * number, an MPIN and a TOTP secret; Angel wants a client code, an API key, a
 * PIN and a TOTP secret; Zerodha wants an API key and secret plus a web password
 * for the headless leg. Rather than model four shapes, this file carries the
 * union and states per broker which fields are actually REQUIRED — so a row that
 * cannot log in is rejected here, with a message naming the missing field,
 * instead of failing later as an opaque 401 from the broker.
 */

import { fetchBrokerAccounts, supabaseConfigured, type BrokerAccountRow } from './supabase.js';

export interface BrokerCredentials {
  broker:      string;
  phone:       string;
  mpin:        string;
  totpSecret:  string;
  /** Angel's `X-PrivateKey`, Zerodha's `api_key`, Kotak's consumer key. */
  apiKey?:     string;
  apiSecret?:  string;
  /** Nubra's two hosts. Absent means "whatever NUBRA_BASE_URL says". */
  env?:        'PROD' | 'UAT';
  clientCode?: string;
  /** Human label for logs — alias, username, or client code. */
  label:       string;
  source:      'supabase' | 'env';
}

/**
 * What each broker cannot log in without.
 *
 * `mpin` is the shared name for the numeric secret: Nubra calls it an MPIN,
 * Angel calls it a PIN, and both live in the table's `pin` column. Keeping one
 * field rather than aliasing per broker is what lets the row → credentials
 * mapping stay a single function.
 */
const REQUIRED: Record<string, Array<keyof BrokerCredentials>> = {
  nubra:   ['phone', 'mpin', 'totpSecret'],
  angel:   ['clientCode', 'apiKey', 'mpin', 'totpSecret'],
  zerodha: ['apiKey', 'apiSecret', 'clientCode', 'totpSecret'],
  kotak:   ['apiKey', 'clientCode', 'phone', 'mpin', 'totpSecret'],
  upstox:  ['apiKey', 'apiSecret'],
};

/** Fields a broker needs but this credential set does not have. */
function missingFields(creds: BrokerCredentials, broker: string): string[] {
  const required = REQUIRED[broker.toLowerCase()] ?? REQUIRED.nubra;
  return required.filter((f) => !String(creds[f] ?? '').trim());
}

/** Whether these credentials are complete enough to attempt a login. */
export function isComplete(creds: BrokerCredentials, broker: string): boolean {
  return missingFields(creds, broker).length === 0;
}

// ── Row → credentials ────────────────────────────────────────────────────────

/**
 * A blank `broker_env` means production.
 *
 * The table holds both a UAT row (client I0LI8) and a live row (I01LI8) for the
 * same phone number, distinguished only by this column. Treating blank as
 * "don't care" would make the pick order-dependent and could log the terminal
 * into the sandbox, where the data looks plausible and is not real.
 */
function normalizeEnv(raw: string | null | undefined): 'PROD' | 'UAT' {
  return String(raw ?? '').trim().toUpperCase() === 'UAT' ? 'UAT' : 'PROD';
}

/**
 * Same broker family, whatever the row spelled it.
 *
 * Compared through `normalizeBroker` so a row saved as `AngelOne` matches an
 * adapter asking for `angel`.
 */
function sameBroker(row: BrokerAccountRow, broker: string): boolean {
  return normalizeBroker(String(row.broker ?? '')) === normalizeBroker(broker);
}

function toCredentials(row: BrokerAccountRow): BrokerCredentials {
  return {
    broker:     String(row.broker ?? '').toLowerCase(),
    phone:      String(row.phone ?? '').replace(/[^\d]/g, '').slice(-10),
    mpin:       String(row.pin ?? ''),
    totpSecret: String(row.totp_secret ?? ''),
    apiKey:     row.api_key    ?? undefined,
    apiSecret:  row.api_secret ?? undefined,
    env:        normalizeEnv(row.broker_env),
    // Angel's client code is the LOGIN INPUT, not something resolved after the
    // fact, so `username` is accepted as a synonym — that is where the admin UI
    // puts it for brokers whose "client code" column was only ever filled in
    // post-login.
    clientCode: row.client_code || row.username || undefined,
    label:      row.alias || row.username || row.client_code || row.id,
    source:     'supabase',
  };
}

/**
 * Broker aliases.
 *
 * The UI and the Supabase rows say `angelone`; the adapter, the env prefix and
 * the feed id all say `angel`. Normalising in one place means neither side has
 * to know about the other's spelling.
 */
const BROKER_ALIASES: Record<string, string> = {
  angelone: 'angel',
  smartapi: 'angel',
  kite:     'zerodha',
  neo:      'kotak',
  kotakneo: 'kotak',
};

export function normalizeBroker(broker: string): string {
  const b = String(broker ?? '').trim().toLowerCase();
  return BROKER_ALIASES[b] ?? b;
}

// ── Cache ────────────────────────────────────────────────────────────────────

/**
 * Rows are cached because `connect()` can be called on any request that finds
 * no session, and a broker outage should not become one Supabase round-trip per
 * request. Short TTL: editing a credential in Supabase should take effect
 * within a minute, not on the next restart.
 */
const TTL_MS = 60_000;

let cached: { rows: BrokerAccountRow[]; at: number } | null = null;
let inFlight: Promise<BrokerAccountRow[]> | null = null;

/** Forget the cache so the next read hits Supabase. */
export function invalidateBrokerAccounts(): void {
  cached = null;
}

/**
 * Cached rows, single-flighted.
 *
 * Returns `[]` rather than throwing when Supabase is unconfigured or unwell —
 * every caller's next move is the env fallback, and making them each write the
 * same try/catch invites one of them to get it wrong and take a route down.
 */
async function rows(): Promise<BrokerAccountRow[]> {
  if (!supabaseConfigured()) return [];
  if (cached && Date.now() - cached.at < TTL_MS) return cached.rows;
  if (inFlight) return inFlight;

  inFlight = fetchBrokerAccounts()
    .then((fresh) => {
      cached = { rows: fresh, at: Date.now() };
      console.log(`[credentials] Loaded ${fresh.length} broker account(s) from Supabase`);
      return fresh;
    })
    .catch((err) => {
      console.warn(`[credentials] Supabase read failed — falling back to env: ${(err as Error).message}`);
      // Serve stale rather than nothing: an expired cache still beats dropping
      // to env vars that may not be set on this machine at all.
      return cached?.rows ?? [];
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Every account in the table, for reporting. Never throws. */
export async function listBrokerAccounts(): Promise<BrokerAccountRow[]> {
  return rows();
}

/**
 * The env-var fallback, for a machine with no Supabase configured.
 *
 * Reads the union of fields and lets `isComplete` decide whether this broker has
 * what it needs — so `ANGEL_CLIENT_CODE` + `ANGEL_API_KEY` + `ANGEL_PIN` +
 * `ANGEL_TOTP_SECRET` works without this function knowing anything about Angel.
 * `PIN` and `MPIN` are both accepted because the two brokers already in play
 * each use a different word for the same secret.
 */
function envCredentials(broker: string, prefix: string): BrokerCredentials | null {
  const env = process.env[`${prefix}ENV`];
  const creds: BrokerCredentials = {
    broker,
    phone:      process.env[`${prefix}PHONE`]        || '',
    mpin:       process.env[`${prefix}MPIN`]         || process.env[`${prefix}PIN`] || '',
    totpSecret: process.env[`${prefix}TOTP_SECRET`]  || '',
    apiKey:     process.env[`${prefix}API_KEY`]      || undefined,
    apiSecret:  process.env[`${prefix}API_SECRET`]   || undefined,
    clientCode: process.env[`${prefix}CLIENT_CODE`]  || process.env[`${prefix}USER_ID`] || undefined,
    env:        env ? normalizeEnv(env) : undefined,
    label:      `${prefix}* env`,
    source:     'env',
  };
  return isComplete(creds, broker) ? creds : null;
}

export interface CredentialQuery {
  /** Target environment. Defaults to NUBRA_ENV, then PROD. */
  env?: string;
  /** Pick a specific row by client code or alias — used by `nubra#<instance>` feeds. */
  select?: string;
  /** Env-var prefix for the fallback. Defaults to `<BROKER>_`. */
  envPrefix?: string;
}

/**
 * Credentials for one broker, Supabase first.
 *
 * Returns null when neither source can produce a complete set, so the caller
 * can raise an error that names what is actually missing.
 */
export async function credentialsFor(
  rawBroker: string,
  query: CredentialQuery = {},
): Promise<BrokerCredentials | null> {
  const broker = normalizeBroker(rawBroker);
  const prefix = query.envPrefix ?? `${broker.toUpperCase()}_`;
  const want   = normalizeEnv(query.env ?? process.env[`${prefix}ENV`]);

  const enabled = (await rows())
    .filter((r) => sameBroker(r, broker) && r.enabled && r.auto_login)
    .map(toCredentials);

  const candidates = enabled.filter((c) => isComplete(c, broker));

  // A row that is enabled but incomplete is a configuration mistake, not an
  // absence — say which column is blank rather than falling through to env vars
  // and reporting "no credentials" for an account that is plainly sitting there.
  for (const c of enabled) {
    const missing = missingFields(c, broker);
    if (missing.length) {
      console.warn(
        `[credentials] ${broker} account "${c.label}" is enabled but missing: ${missing.join(', ')}`,
      );
    }
  }

  // `select` addresses one row explicitly; environment is then not a filter but
  // whatever that row says, because the caller asked for that account by name.
  const chosen = query.select
    ? candidates.find((c) =>
        c.clientCode?.toLowerCase() === query.select!.toLowerCase()
        || c.label.toLowerCase() === query.select!.toLowerCase())
    : candidates.find((c) => c.env === want);

  if (chosen) return chosen;

  const fallback = envCredentials(broker, prefix);
  if (fallback) return fallback;

  // Nothing usable. Say which side came up empty — "credentials missing" with
  // six rows sitting in Supabase sends people to the wrong file.
  if (candidates.length === 0 && (await rows()).length > 0) {
    // Name THIS broker's requirements. The message used to hard-code Nubra's
    // phone/pin/totp trio, which told someone debugging a Zerodha row to go
    // looking for a phone number it does not need.
    const need = (REQUIRED[broker] ?? REQUIRED.nubra).join(', ');
    console.warn(
      `[credentials] Supabase has rows but none usable for ${broker}`
      + ` (need enabled + auto_login + ${need})`,
    );
  }
  return null;
}
