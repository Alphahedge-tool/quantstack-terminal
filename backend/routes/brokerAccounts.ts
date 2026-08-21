/**
 * `/api/brokers/accounts` — the credentials already stored in Supabase,
 * shaped for the connect form.
 *
 * Picking a broker in the UI should fill the form in, not ask you to retype an
 * MPIN and a base32 TOTP secret that are already sitting in `broker_accounts`.
 *
 * ── This route returns NO secrets ──
 *
 * It used to hand the browser MPINs, TOTP secrets and API secrets to pre-fill
 * the form, which was defensible while the terminal was localhost-only and
 * became a credential dump the moment it was reachable from a network — there
 * is no auth in front of it.
 *
 * Secret VALUES are now replaced by `stored`, a list of the keys a row has a
 * secret for. The form pre-fills and marks those fields "stored" exactly as
 * before, because it never needed the values: `save()` in LoginPage sends an
 * identity and an account id, never a credential, and auto-login reads Supabase
 * server-side. Nothing downstream was using them.
 *
 * The Supabase SERVICE KEY has never left the backend, and now neither does any
 * credential it fetches.
 *
 * ── Why the mapping lives here ──
 *
 * The table has one column set; each broker's form has its own field names
 * (Kotak calls its API key a "consumer key", Zerodha's client code is a "user
 * ID"). Mapping on the server keeps the browser free of per-broker column
 * knowledge, and means a column rename is one edit rather than five.
 */

import { route, ApiError } from '../server.js';
import { listBrokerAccounts } from '../lib/credentialStore.js';
import type { BrokerAccountRow } from '../lib/supabase.js';

/**
 * Row `broker` → the UI's broker id.
 *
 * Prefix matching, not equality: the live table holds `Angel`, `KotakNeoV3`,
 * `Nubra` and `nubra` for what the UI calls four brokers. An exact-match table
 * silently returns "no saved account" for a row that is plainly there, which
 * looks identical to having never configured it.
 */
function uiBrokerOf(raw: string): string | null {
  const b = String(raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!b) return null;
  if (b.startsWith('angel') || b.startsWith('smartapi')) return 'angelone';
  if (b.startsWith('zerodha') || b.startsWith('kite'))   return 'zerodha';
  if (b.startsWith('kotak')   || b.startsWith('neo'))    return 'kotak';
  if (b.startsWith('upstox'))                            return 'upstox';
  if (b.startsWith('nubra'))                             return 'nubra';
  return null;
}

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * UI field key → value, per broker.
 *
 * Mirrors `src/lib/brokers/config.ts`. A field with no column behind it — a web
 * password, Upstox's redirect URI — is deliberately absent rather than empty
 * string, so the client can tell "nothing is stored for this" apart from
 * "stored as blank" and say which fields still need typing.
 */
function fieldsFor(ui: string, row: BrokerAccountRow): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: string) => { if (value) out[key] = value; };

  const clientCode = str(row.client_code) || str(row.username);

  switch (ui) {
    case 'angelone':
      put('api_key',     str(row.api_key));
      put('client_id',   clientCode);
      put('pin',         str(row.pin));
      put('totp_secret', str(row.totp_secret));
      break;

    case 'zerodha':
      put('api_key',     str(row.api_key));
      put('api_secret',  str(row.api_secret));
      put('user_id',     clientCode);
      put('totp_secret', str(row.totp_secret));
      // `password` has no column — Kite's web password is not stored here.
      break;

    case 'upstox':
      put('api_key',    str(row.api_key));
      put('api_secret', str(row.api_secret));
      put('mobile',     str(row.phone));
      // `redirect_uri` is an app setting, not a credential.
      break;

    case 'kotak':
      put('consumer_key',    str(row.api_key));
      put('consumer_secret', str(row.api_secret));
      put('mobile',          str(row.phone));
      put('mpin',            str(row.pin));
      // `password` has no column.
      break;

    case 'nubra':
      put('phone',       str(row.phone));
      put('mpin',        str(row.pin));
      put('totp_secret', str(row.totp_secret));
      break;

    default:
      break;
  }

  return out;
}

/**
 * Field keys whose VALUE never leaves the server.
 *
 * Mirrors the `password` and `totp_secret` field types in `src/lib/brokers.ts`.
 * Everything else — an API key, a client code, a mobile number — identifies the
 * account rather than authenticating it, and the form genuinely needs those:
 * `identityFrom` in LoginPage reads `client_id` / `user_id` / `phone` to work
 * out which account is being linked.
 */
const SECRET_KEYS = new Set([
  'api_secret', 'consumer_secret', 'pin', 'mpin', 'totp_secret', 'password',
]);

export interface SavedAccount {
  id:        string;
  broker:    string;
  /** Display label — alias, client code, or the broker's own name. */
  label:     string;
  clientCode: string;
  /** PROD or UAT. Two rows can differ ONLY by this. */
  env:       string;
  enabled:   boolean;
  autoLogin: boolean;
  /** Non-secret values, keyed as the connect form names them. */
  fields:    Record<string, string>;
  /**
   * Keys the row HAS a secret for, without the secret itself.
   *
   * This is what lets the form say "MPIN — stored" and stop asking, which is
   * the whole job the plaintext value used to do. The browser is told a secret
   * exists; it is not told what it is.
   */
  stored:    string[];
  updatedAt: string;
}

function toSaved(ui: string, row: BrokerAccountRow): SavedAccount {
  const clientCode = str(row.client_code) || str(row.username);
  const all = fieldsFor(ui, row);

  const fields: Record<string, string> = {};
  const stored: string[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (SECRET_KEYS.has(key)) stored.push(key);
    else fields[key] = value;
  }

  return {
    id:         row.id,
    broker:     ui,
    label:      str(row.alias) || clientCode || ui,
    clientCode,
    env:        str(row.broker_env).toUpperCase() === 'UAT' ? 'UAT' : 'PROD',
    enabled:    Boolean(row.enabled),
    autoLogin:  Boolean(row.auto_login),
    fields,
    stored,
    updatedAt:  str(row.updated_at),
  };
}

/**
 * Every stored account the UI can pre-fill from.
 *
 * `?broker=angelone` narrows it. Ordered so the account a form should default
 * to comes first: enabled and auto-login before the rest, production before
 * UAT. The live table holds a UAT Nubra row and a production one whose client
 * codes differ by a single character, and defaulting to the sandbox would show
 * data that looks entirely plausible and is not real.
 */
route('GET', '/api/brokers/accounts', async (_req, _res, { query }) => {
  const want = String(query.get('broker') ?? '').trim().toLowerCase();

  const saved: SavedAccount[] = [];
  for (const row of await listBrokerAccounts()) {
    const ui = uiBrokerOf(row.broker);
    if (!ui) continue;
    if (want && ui !== want) continue;
    saved.push(toSaved(ui, row));
  }

  saved.sort((a, b) =>
    Number(b.enabled && b.autoLogin) - Number(a.enabled && a.autoLogin)
    || Number(a.env === 'UAT') - Number(b.env === 'UAT')
    || a.label.localeCompare(b.label));

  return { status: true, accounts: saved };
});
