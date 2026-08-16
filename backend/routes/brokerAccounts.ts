/**
 * `/api/brokers/accounts` — the credentials already stored in Supabase,
 * shaped for the connect form.
 *
 * Picking a broker in the UI should fill the form in, not ask you to retype an
 * MPIN and a base32 TOTP secret that are already sitting in `broker_accounts`.
 *
 * ── This route returns SECRETS ──
 *
 * `lib/supabase.ts` says credentials flow one way and no route returns a
 * credential field. This route is the deliberate exception, and it is the only
 * one: it hands the browser MPINs, TOTP secrets and API secrets so the form can
 * be pre-filled. That is safe for a terminal on localhost and NOT safe on a
 * host anyone else can reach — there is no auth in front of it, so exposing the
 * port exposes every broker credential in the table.
 *
 * The Supabase SERVICE KEY still never leaves the backend. Only the row values
 * do, and only for brokers the UI knows how to ask about.
 *
 * ── Why the mapping lives here ──
 *
 * The table has one column set; each broker's form has its own field names
 * (Kotak calls its API key a "consumer key", Zerodha's client code is a "user
 * ID"). Mapping on the server keeps the browser free of per-broker column
 * knowledge, and means a column rename is one edit rather than five.
 */

import { route } from '../server.js';
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
  /** Credential values, keyed as the connect form names them. */
  fields:    Record<string, string>;
  updatedAt: string;
}

function toSaved(ui: string, row: BrokerAccountRow): SavedAccount {
  const clientCode = str(row.client_code) || str(row.username);
  return {
    id:         row.id,
    broker:     ui,
    label:      str(row.alias) || clientCode || ui,
    clientCode,
    env:        str(row.broker_env).toUpperCase() === 'UAT' ? 'UAT' : 'PROD',
    enabled:    Boolean(row.enabled),
    autoLogin:  Boolean(row.auto_login),
    fields:     fieldsFor(ui, row),
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
