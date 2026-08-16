/**
 * The accounts this browser has linked, and which one is signed in.
 *
 * ── What this store is, and is not ──
 *
 * It is NOT authentication. The backend has no user auth in front of it; a feed
 * session lives on the server and is created by `POST /api/feeds/login`. This
 * store records which broker accounts this browser has been set up with, so the
 * sign-in screen has something to list and the shell knows whether to show the
 * terminal or send you back to sign in.
 *
 * ── Why no credentials are kept here ──
 *
 * The reference implementation persisted the whole credential map — MPINs,
 * base32 TOTP secrets, API secrets — into localStorage. That is worth not
 * inheriting: the browser never sends them anywhere. Connecting posts a feed id
 * and nothing else, and the backend signs in using the `broker_accounts` row it
 * already holds. Persisted secrets here would buy no capability and would sit
 * in plain text in a store any script on the origin can read.
 *
 * What persists instead is the LINK: which broker, which client code, what to
 * call it. The connect form re-fills from the backend on demand.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { BrokerId } from '@/lib/brokers';

export type SessionStatus = 'idle' | 'connecting' | 'active' | 'expired' | 'error';

export interface LinkedAccount {
  id: string;
  /** Display name — "Raj / Zerodha". */
  name: string;
  broker: BrokerId;
  /**
   * The credential the BROKER logs in with — client id, user id, or phone.
   * Not a secret, and it is what makes two saved cards the same account.
   */
  identity: string;
  /** The `broker_accounts` row this was linked from, when there was one. */
  savedAccountId?: string;
  /** PROD or UAT. A sandbox row shows data that looks entirely real. */
  env?: string;
  status: SessionStatus;
  /** ISO timestamp of the last successful connect from this browser. */
  lastLogin?: string;
  errorMsg?: string;
  autoLogin: boolean;
}

export type NewAccount = Omit<LinkedAccount, 'id' | 'status'>;

interface AuthState {
  accounts: LinkedAccount[];
  activeAccountId: string | null;

  linkAccount: (account: NewAccount) => void;
  removeAccount: (id: string) => void;
  setActiveAccount: (id: string | null) => void;
  setStatus: (id: string, status: SessionStatus, errorMsg?: string) => void;
  signOut: () => void;
  /** Collapse cards that describe the same broker login. */
  dedupeAccounts: () => void;
}

/**
 * A v4 UUID that also works outside a secure context.
 *
 * `crypto.randomUUID` is exposed ONLY on HTTPS and localhost. Vite also serves
 * this app on a LAN address in dev, and opening it that way leaves
 * `randomUUID` undefined — so linking an account threw a TypeError on a page
 * that otherwise worked perfectly.
 *
 * `getRandomValues` has no such restriction. The last resort covers neither
 * being present; ids here only have to be unique within one browser's
 * localStorage, never unguessable.
 */
function newId(): string {
  const c: Crypto | undefined = globalThis.crypto;

  if (typeof c?.randomUUID === 'function') return c.randomUUID();

  if (typeof c?.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * What makes two linked accounts the SAME account.
 *
 * Not the display name — that is editable and was blank by default, so two
 * saves of one Angel login produced "Angel One Account" twice and then the
 * client code once the form started pre-filling the alias. The identity is the
 * credential the broker itself logs in with.
 */
function identityOf(account: Pick<LinkedAccount, 'broker' | 'identity'>): string {
  return `${account.broker}:${String(account.identity ?? '').trim().toLowerCase()}`;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accounts: [],
      activeAccountId: null,

      // Linking a broker that is already linked UPDATES it rather than adding a
      // second card for the same login.
      linkAccount: (account) =>
        set((s) => {
          const identity = identityOf(account);
          const existing = s.accounts.find((a) => identityOf(a) === identity);
          if (existing) {
            return {
              accounts: s.accounts.map((a) =>
                a.id === existing.id ? { ...a, ...account, id: a.id, status: a.status } : a,
              ),
            };
          }
          return {
            accounts: [...s.accounts, { ...account, id: newId(), status: 'idle' as const }],
          };
        }),

      dedupeAccounts: () =>
        set((s) => {
          const byIdentity = new Map<string, LinkedAccount>();
          for (const account of s.accounts) {
            const identity = identityOf(account);
            const kept = byIdentity.get(identity);
            // Keep the richest version: most recently used wins.
            if (!kept || (account.lastLogin ?? '') > (kept.lastLogin ?? '')) {
              byIdentity.set(identity, kept ? { ...kept, ...account, id: kept.id } : account);
            }
          }
          const accounts = [...byIdentity.values()];
          if (accounts.length === s.accounts.length) return s; // nothing to do
          return {
            accounts,
            activeAccountId: accounts.some((a) => a.id === s.activeAccountId)
              ? s.activeAccountId
              : null,
          };
        }),

      removeAccount: (id) =>
        set((s) => ({
          accounts: s.accounts.filter((a) => a.id !== id),
          activeAccountId: s.activeAccountId === id ? null : s.activeAccountId,
        })),

      setActiveAccount: (activeAccountId) => set({ activeAccountId }),

      setStatus: (id, status, errorMsg) =>
        set((s) => ({
          accounts: s.accounts.map((a) =>
            a.id === id
              ? {
                  ...a,
                  status,
                  errorMsg,
                  lastLogin: status === 'active' ? new Date().toISOString() : a.lastLogin,
                }
              : a,
          ),
        })),

      /**
       * Leave the terminal, keep the accounts.
       *
       * Deliberately does NOT call `/api/feeds/logout`. The backend session is
       * shared — other tabs, the auto-login at boot, and any scheduled work all
       * ride on it — so dropping it because one browser tab stepped away would
       * take the feed down for everything else. Signing back in is then a click,
       * not a fresh TOTP round trip.
       */
      signOut: () => set({ activeAccountId: null }),
    }),
    {
      name: 'quantstack.auth',
      // Transient state is not persisted: a status from yesterday's session is
      // a claim about a connection that no longer exists.
      partialize: (s) => ({
        accounts: s.accounts.map((a) => ({
          ...a,
          status: 'idle' as SessionStatus,
          errorMsg: undefined,
        })),
        activeAccountId: s.activeAccountId,
      }),
    },
  ),
);
