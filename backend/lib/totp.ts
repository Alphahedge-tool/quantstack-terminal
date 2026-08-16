/**
 * TOTP generation — ported from Alphahedge node-backend/lib/totp.js.
 * Byte-for-byte identical to pyotp.TOTP(secret).now() which Nubra's SDK uses.
 *
 * Algorithm:
 *   1. Strip otpauth:// wrapper, remove spaces, uppercase
 *   2. Pad to multiple of 8 with '=' then base32-decode → HMAC-SHA1 key
 *   3. TOTP counter = floor(epochMs / 1000 / 30)
 *   4. HMAC-SHA1(key, counter as 8-byte big-endian) → dynamic truncation → 6 digits
 */

import crypto from 'node:crypto';

const WINDOW_MS = 30_000;

// ─── Base32 decode ───────────────────────────────────────────────────────────

function extractTOTPSecret(secret: string): string {
  const raw = String(secret ?? '').trim();
  if (!raw.toLowerCase().startsWith('otpauth://')) return raw;
  try {
    const u = new URL(raw);
    return u.searchParams.get('secret') || raw;
  } catch {
    return raw;
  }
}

function decodeBase32(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error('not valid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export function decodeTOTPSecret(secret: string): Buffer {
  let clean = extractTOTPSecret(secret).replace(/\s+/g, '');
  if (!clean) throw new Error('Nubra TOTP secret is empty');
  clean = clean.toUpperCase();
  const missing = clean.length % 8;
  if (missing !== 0) clean += '='.repeat(8 - missing);
  try {
    return decodeBase32(clean);
  } catch {
    throw new Error(
      'Nubra TOTP secret is not a valid base32 authenticator secret — paste the ' +
        'TOTP/authenticator secret from Nubra, not the API secret or MPIN',
    );
  }
}

export function validateTOTPSecret(secret: string): void {
  const key = decodeTOTPSecret(secret);
  if (key.length < 10) {
    throw new Error(
      'Nubra TOTP secret looks too short to be an authenticator secret — paste ' +
        'the TOTP secret from Nubra, not the API secret or MPIN',
    );
  }
}

// ─── TOTP code generation ────────────────────────────────────────────────────

/**
 * Generate a 6-digit TOTP code.
 * @param secret  Base32 TOTP secret (plain or otpauth:// URI)
 * @param atMs    Epoch ms to anchor to (use Nubra server time to avoid clock skew)
 */
export function generateTOTP(secret: string, atMs = Date.now()): string {
  const key = decodeTOTPSecret(secret);
  const counter = Math.floor(atMs / 1000 / 30);

  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const mac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

// ─── Window helpers ──────────────────────────────────────────────────────────

/** True if `atMs` is in the last `edgeMs` of its 30s TOTP window. */
export function nearWindowEdge(atMs: number, edgeMs = 3_000): boolean {
  const into = atMs % WINDOW_MS;
  return WINDOW_MS - into <= edgeMs;
}

/** How many ms until the next TOTP window starts (with 250ms safety margin). */
export function msUntilNextWindow(atMs: number): number {
  return WINDOW_MS - (atMs % WINDOW_MS) + 250;
}
