/**
 * Status bar — the persistent, low-emphasis line of system facts.
 *
 * Everything here answers "why does the screen look like that?": which feed is
 * carrying, how many contracts are subscribed, when data last arrived. It is
 * deliberately quiet (micro type, tertiary colour) because it is for checking,
 * not for reading.
 */

import { Radio, Server, Signal } from 'lucide-react';
import { useFeeds } from '@/hooks/queries';
import { useQuoteStore } from '@/stores/quoteStore';
import { relativeTime } from '@/lib/format';
import { useEffect, useState } from 'react';

/** Re-renders on a timer so "4s ago" does not sit frozen at "just now" — the
 *  underlying timestamp only changes when a frame arrives. */
function useTicker(intervalMs = 1000): void {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
}

export function StatusBar() {
  useTicker();

  const feeds = useFeeds();
  const quotes = useQuoteStore((s) => s.quotes);
  const socket = useQuoteStore((s) => s.socket);
  const carryingBroker = useQuoteStore((s) => s.carryingBroker);

  const symbols = Object.keys(quotes);
  const lastTick = symbols.reduce((latest, symbol) => {
    const ts = quotes[symbol]?.ts ?? 0;
    return ts > latest ? ts : latest;
  }, 0);

  const connectedFeeds = (feeds.data?.feeds ?? []).filter((f) => f.connected);

  return (
    <footer
      className="flex shrink-0 items-center gap-4 border-t border-[var(--chrome-border-subtle)] bg-[var(--chrome-panel)] px-4 text-[length:var(--type-micro)] text-[var(--text-tertiary)]"
      style={{ height: 'var(--statusbar-height)' }}
    >
      <span className="flex items-center gap-1.5">
        <Server size={11} />
        {connectedFeeds.length > 0
          ? `${connectedFeeds.length} feed${connectedFeeds.length === 1 ? '' : 's'} connected`
          : 'No feed connected'}
      </span>

      <span className="flex items-center gap-1.5">
        <Radio size={11} />
        Quotes {socket}
        {carryingBroker ? ` · via ${carryingBroker}` : ''}
      </span>

      {symbols.length > 0 ? (
        <span className="flex items-center gap-1.5">
          <Signal size={11} />
          {symbols.length} subscribed
        </span>
      ) : null}

      <div className="flex-1" />

      {lastTick > 0 ? <span>Last tick {relativeTime(lastTick)}</span> : null}
    </footer>
  );
}
