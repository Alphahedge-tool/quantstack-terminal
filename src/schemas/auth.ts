/**
 * Schemas for the sign-in surface: stored credentials, feed connect, and
 * Zerodha's browser login.
 *
 * Parsed at the edge like every other route. It matters more here than
 * elsewhere: these payloads decide whether a form pre-fills and whether a
 * Connect press is reported as success. A drift that slips through unvalidated
 * shows up as an empty form or a green badge over a dead session, both of which
 * are worse than a named parse failure.
 */

import { z } from 'zod';
import { BROKER_IDS, type BrokerId } from '@/lib/brokers';

/* ── Stored credentials ───────────────────────────────────────────────────── */

/**
 * One row of `broker_accounts`, shaped for the connect form.
 *
 * `fields` is deliberately an open record rather than a per-broker shape: the
 * backend only emits keys it has values for, precisely so the client can tell
 * "nothing stored" apart from "stored blank". Pinning it to a closed object
 * would force empty strings back in and lose that distinction.
 *
 * `fields` holds only NON-SECRET values — client codes, mobile numbers, API
 * keys. A secret the row does hold is named in `stored` and its value stays on
 * the server, so a form can show "MPIN — stored" without the MPIN ever reaching
 * a browser.
 */
export const savedAccountSchema = z
  .object({
    id: z.string(),
    // Narrowed to the four this build knows. The backend also emits `upstox`;
    // filtering happens at the query, not here, so an unexpected broker is a
    // parse failure with a name rather than a card that renders as undefined.
    broker: z.enum(BROKER_IDS as [BrokerId, ...BrokerId[]]),
    label: z.string().default(''),
    clientCode: z.string().default(''),
    /** PROD or UAT. Two rows can differ ONLY by this. */
    env: z.string().default('PROD'),
    enabled: z.boolean().default(false),
    autoLogin: z.boolean().default(false),
    fields: z.record(z.string()).default({}),
    /** Field keys the row has a secret for. Names only, never values. */
    stored: z.array(z.string()).default([]),
    updatedAt: z.string().default(''),
  })
  .passthrough();

export const savedAccountsResponse = z
  .object({
    status: z.literal(true),
    accounts: z.array(savedAccountSchema).default([]),
  })
  .passthrough();

export type SavedAccount = z.infer<typeof savedAccountSchema>;

/* ── Feed connect ─────────────────────────────────────────────────────────── */

/**
 * `POST /api/feeds/login`.
 *
 * `connected` is the fact that matters and it is NOT implied by `status: true`
 * — the route answers 200 with the feed's post-login state, and a login that
 * completed without establishing a session comes back `connected: false`.
 * Treating the 200 as success is how a failed sign-in routes into the terminal.
 */
export const feedLoginResponse = z
  .object({
    status: z.boolean(),
    id: z.string().optional(),
    connected: z.boolean().optional(),
  })
  .passthrough();

export const feedLogoutResponse = z
  .object({ status: z.boolean() })
  .passthrough();

/* ── Zerodha browser login ────────────────────────────────────────────────── */

export const zerodhaLoginUrlResponse = z
  .object({
    status: z.literal(true),
    loginUrl: z.string(),
    message: z.string().default(''),
  })
  .passthrough();

export const zerodhaCallbackResponse = z
  .object({
    status: z.literal(true),
    broker: z.string().default('zerodha'),
    userId: z.string().default(''),
    message: z.string().default(''),
  })
  .passthrough();
