/**
 * The broker catalogue.
 *
 * One entry per broker the terminal can sign into, carrying the fields that
 * broker's login actually needs. The field KEYS are a contract with the backend:
 * `routes/brokerAccounts.ts` maps the `broker_accounts` table onto exactly these
 * names so the connect form arrives pre-filled. Renaming a key here without
 * renaming it there produces a form that silently stops pre-filling — which
 * looks identical to having no saved credentials.
 *
 * ── Four brokers, not five ──
 *
 * The backend also understands `upstox`, and the reference terminal listed it.
 * It is deliberately absent here: this app connects Kotak, Zerodha, Nubra and
 * Angel One, and offering a fifth card that no configured feed can serve is a
 * dead end dressed as a feature. Adding it back is one entry plus one line in
 * FEED_ID.
 */

export type BrokerId = 'kotak' | 'zerodha' | 'nubra' | 'angelone';

export type FieldType = 'text' | 'password' | 'number' | 'totp_secret';

export interface BrokerField {
  key: string;
  label: string;
  type: FieldType;
  placeholder: string;
  hint?: string;
  /**
   * False when no column in `broker_accounts` backs this field.
   *
   * A Kite web password or a Neo trading password is never stored server-side,
   * so it can never pre-fill. Marking it means the form can say "type this one"
   * instead of reporting it alongside fields that are genuinely missing from an
   * incomplete row.
   */
  storable?: boolean;
}

export interface BrokerConfig {
  id: BrokerId;
  name: string;
  /** The product name traders actually say — "Kite", not "Zerodha's API". */
  shortName: string;
  /** Brand colour. Used for the logo tile only, never for status. */
  color: string;
  /** Single-letter fallback behind the remote logo. */
  logo: string;
  logoUrl: string;
  authMethod: 'totp' | 'otp' | 'pin+totp';
  sessionNote: string;
  fields: BrokerField[];
}

export const BROKERS: BrokerConfig[] = [
  {
    id: 'kotak',
    name: 'Kotak Neo',
    shortName: 'Neo',
    color: '#d4a017',
    logo: 'K',
    logoUrl: 'https://logo.clearbit.com/kotakneo.com',
    authMethod: 'otp',
    sessionNote: 'OTP sent to the registered mobile each session',
    fields: [
      { key: 'consumer_key', label: 'Consumer Key', type: 'text', placeholder: 'your_consumer_key' },
      { key: 'consumer_secret', label: 'Consumer Secret', type: 'password', placeholder: 'your_consumer_secret' },
      { key: 'mobile', label: 'Mobile Number', type: 'number', placeholder: '10-digit mobile' },
      { key: 'password', label: 'Password', type: 'password', placeholder: 'Neo trading password', storable: false },
      { key: 'mpin', label: 'MPIN', type: 'password', placeholder: '4-digit MPIN' },
    ],
  },
  {
    id: 'zerodha',
    name: 'Zerodha',
    shortName: 'Kite',
    color: '#387ed1',
    logo: 'Z',
    logoUrl: 'https://logo.clearbit.com/zerodha.com',
    authMethod: 'totp',
    sessionNote: 'Session valid till 6 AM next day · browser login available',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'text', placeholder: 'your_api_key' },
      { key: 'api_secret', label: 'API Secret', type: 'password', placeholder: 'your_api_secret' },
      { key: 'user_id', label: 'User ID', type: 'text', placeholder: 'ZX0000' },
      { key: 'password', label: 'Password', type: 'password', placeholder: 'Kite login password', storable: false },
      {
        key: 'totp_secret',
        label: 'TOTP Secret',
        type: 'totp_secret',
        placeholder: 'Base32 secret from authenticator',
        hint: 'Only the headless login needs this. Browser login works without it.',
      },
    ],
  },
  {
    id: 'nubra',
    name: 'Nubra Data',
    shortName: 'Nubra',
    color: '#10b981',
    logo: 'N',
    logoUrl: 'https://logo.clearbit.com/nubra.io',
    authMethod: 'pin+totp',
    sessionNote: 'Data feed · headless TOTP login · timeseries and option analytics',
    fields: [
      { key: 'phone', label: 'Mobile Number', type: 'number', placeholder: '10-digit mobile number' },
      { key: 'mpin', label: 'MPIN', type: 'password', placeholder: '4-digit MPIN' },
      {
        key: 'totp_secret',
        label: 'TOTP Secret',
        type: 'totp_secret',
        placeholder: 'Base32 secret from authenticator',
        hint: 'Auto-generates the TOTP for unattended login.',
      },
    ],
  },
  {
    id: 'angelone',
    name: 'Angel One',
    shortName: 'SmartAPI',
    color: '#e63946',
    logo: 'A',
    logoUrl: 'https://logo.clearbit.com/angelone.in',
    authMethod: 'pin+totp',
    sessionNote: 'Requires MPIN and TOTP on every login',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'text', placeholder: 'your_api_key' },
      { key: 'client_id', label: 'Client ID', type: 'text', placeholder: 'A123456' },
      { key: 'pin', label: 'MPIN', type: 'password', placeholder: '4-digit MPIN' },
      {
        key: 'totp_secret',
        label: 'TOTP Secret',
        type: 'totp_secret',
        placeholder: 'Base32 secret from authenticator',
        hint: 'Auto-generates the TOTP for hands-free login.',
      },
    ],
  },
];

export const BROKER_IDS = BROKERS.map((b) => b.id);

/** Catalogue entry by id, or undefined for an id this build does not carry. */
export function getBroker(id: string): BrokerConfig | undefined {
  return BROKERS.find((b) => b.id === id);
}

/**
 * UI broker id → backend feed id.
 *
 * The two vocabularies differ by design: `QT_FEEDS`, the adapters and the feed
 * ids all say `angel`, while the connect form and the Supabase rows say
 * `angelone`. `backend/lib/credentialStore.ts` normalises the same pair on its
 * side; this is the browser's half of that agreement.
 */
const FEED_ID: Record<BrokerId, string> = {
  kotak: 'kotak',
  zerodha: 'zerodha',
  nubra: 'nubra',
  angelone: 'angel',
};

export function feedIdFor(broker: BrokerId): string {
  return FEED_ID[broker] ?? broker;
}

/**
 * Any spelling a backend row might use → the UI broker id.
 *
 * Prefix matching, not equality: the live table holds `Angel`, `KotakNeoV3`,
 * `Nubra` and `nubra` for what this app calls four brokers, and the feed
 * registry adds instance suffixes (`angel#2`). An exact-match table returns "no
 * such broker" for a row that is plainly there, which is indistinguishable from
 * having never configured it.
 *
 * Mirrors `uiBrokerOf` in `backend/routes/brokerAccounts.ts`.
 */
export function canonicalBroker(raw: string | null | undefined): BrokerId | null {
  const b = String(raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!b) return null;
  if (b.startsWith('angel') || b.startsWith('smartapi')) return 'angelone';
  if (b.startsWith('zerodha') || b.startsWith('kite')) return 'zerodha';
  if (b.startsWith('kotak') || b.startsWith('neo')) return 'kotak';
  if (b.startsWith('nubra')) return 'nubra';
  return null;
}

/**
 * Which of a broker's fields a saved row could not fill.
 *
 * Split into two lists because they call for different actions. `missing` is an
 * incomplete row — the live Zerodha account has no TOTP secret — and `manual`
 * is a field no column ever backs. Reporting a web password as "missing" sends
 * someone to fix a database row that is not wrong.
 */
export function missingFields(
  values: Record<string, string>,
  fields: BrokerField[],
  /**
   * Keys held server-side as secrets. Their values are deliberately absent from
   * `values`, so without this every stored MPIN would be reported as missing —
   * sending someone to fix a row that is already correct.
   */
  stored: readonly string[] = [],
): { missing: string[]; manual: string[] } {
  const held = new Set(stored);
  const empty = fields.filter(
    (f) => !held.has(f.key) && !String(values[f.key] ?? '').trim(),
  );
  return {
    missing: empty.filter((f) => f.storable !== false).map((f) => f.label),
    manual: empty.filter((f) => f.storable === false).map((f) => f.label),
  };
}
