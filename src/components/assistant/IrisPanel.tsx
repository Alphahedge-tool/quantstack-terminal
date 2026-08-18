/**
 * The conversation sheet.
 *
 * ── Why it floats rather than docks ──
 *
 * Every page under it is a working surface — a book, a chain, a chart. Docking
 * would reflow that page every time the assistant opens, which is exactly the
 * wrong trade: the user opens IRIS to ask about what they are looking at, and
 * making it move is the one thing guaranteed to break that.
 *
 * ── Three tabs, not three panels ──
 *
 * Chat, watches, alerts are the same conversation seen three ways. They share
 * one surface and one position because the alternative — an alert drawer plus a
 * chat bubble plus a watch manager — is three things to find and dismiss.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bell, Eye, MessageSquare, Send, Trash2, Volume2, VolumeX, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { AlertEvent, WatchSummary } from '@/lib/iris/protocol';
import type { IrisSettings, Message } from '@/hooks/useIris';
import { AlertLine, IrisCard, WatchList } from './IrisCards';

type Tab = 'chat' | 'watches' | 'alerts';

interface IrisPanelProps {
  open: boolean;
  onClose: () => void;
  messages: Message[];
  watches: WatchSummary[];
  alerts: AlertEvent[];
  thinking: boolean;
  connection: string;
  settings: IrisSettings;
  onSettings: (patch: Partial<IrisSettings>) => void;
  onSend: (text: string) => void;
  onCancelWatch: (id: string) => void;
  onClear: () => void;
  /** Live partial transcript, shown in the composer while the user speaks. */
  interim: string;
  listening: boolean;
}

const SUGGESTIONS = [
  "What's the OI on nifty 25000 CE",
  'Show me the banknifty chain',
  "Where's the OI buildup in nifty",
  'Track OI on nifty 25000 CE, alert me if it moves 5% in 10 min',
];

export function IrisPanel({
  open, onClose, messages, watches, alerts, thinking, connection,
  settings, onSettings, onSend, onCancelWatch, onClear, interim, listening,
}: IrisPanelProps) {
  const [tab, setTab] = useState<Tab>('chat');
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);

  /**
   * Pin to the bottom as messages arrive.
   *
   * `useLayoutEffect` rather than `useEffect`: scrolling after paint shows the
   * user one frame of the old position, which reads as a jump on every reply.
   */
  useLayoutEffect(() => {
    if (!open || tab !== 'chat') return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking, open, tab]);

  // Focus the composer on open, but not on mobile where it would raise the
  // keyboard over the conversation the user just opened.
  useEffect(() => {
    if (!open) return;
    if (window.matchMedia('(pointer: coarse)').matches) return;
    const id = window.setTimeout(() => input.current?.focus(), 80);
    return () => window.clearTimeout(id);
  }, [open]);

  // Escape closes — expected of anything that floats over a page.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };

  const unseenAlerts = alerts.length;

  return (
    <div
      role="dialog"
      aria-label="Iris assistant"
      className={cn(
        'qs-slide-up pointer-events-auto mb-2 flex w-[min(400px,calc(100vw-2rem))] flex-col',
        'overflow-hidden rounded-[var(--container-radius)] border',
        'border-[var(--container-border)] bg-[var(--surface-panel)]',
        'shadow-[0_18px_48px_rgba(0,0,0,.55)]',
      )}
      style={{ height: 'min(560px, calc(100dvh - 8rem))' }}
    >
      {/* ── Header ── */}
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--container-rule)] bg-[var(--container-head)] px-3 py-2">
        <span className="flex items-center gap-1.5">
          <span
            className="size-1.5 rounded-full"
            style={{
              background: connection === 'open'
                ? 'var(--status-success)'
                : 'var(--text-disabled)',
            }}
            aria-hidden
          />
          <h2 className="text-[length:var(--type-control)] font-semibold text-[var(--text-primary)]">
            Iris
          </h2>
        </span>

        <span className="text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
          {connection === 'open' ? 'connected' : 'reconnecting…'}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => onSettings({ speakAlerts: !settings.speakAlerts })}
            title={settings.speakAlerts ? 'Mute spoken alerts' : 'Speak alerts aloud'}
            aria-label={settings.speakAlerts ? 'Mute spoken alerts' : 'Speak alerts aloud'}
            className={cn(
              'grid size-7 place-items-center rounded-[var(--radius-sm)]',
              'hover:bg-[var(--surface-hover)]',
              settings.speakAlerts ? 'text-[var(--accent-info)]' : 'text-[var(--text-tertiary)]',
            )}
          >
            {settings.speakAlerts ? <Volume2 size={14} /> : <VolumeX size={14} />}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-7 place-items-center rounded-[var(--radius-sm)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {/* ── Tabs ── */}
      <nav className="flex shrink-0 border-b border-[var(--container-rule)] bg-[var(--surface-raised)]">
        {([
          ['chat',    MessageSquare, 'Chat',    0],
          ['watches', Eye,           'Watches', watches.length],
          ['alerts',  Bell,          'Alerts',  unseenAlerts],
        ] as const).map(([key, Icon, label, count]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-2',
              'text-[length:var(--type-micro)] font-medium transition-colors',
              tab === key
                ? 'border-[var(--accent-info)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
            )}
          >
            <Icon size={13} />
            {label}
            {count > 0 ? (
              <span className="rounded-full bg-[var(--surface-hover)] px-1.5 text-[10px] text-[var(--text-secondary)]">
                {count}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      {/* ── Body ── */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        {tab === 'chat' ? (
          <>
            {messages.map((m) => <Bubble key={m.id} message={m} />)}
            {thinking ? <Thinking /> : null}
            {messages.length <= 1 ? (
              <div className="mt-3 space-y-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onSend(s)}
                    className={cn(
                      'w-full rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-left',
                      'border-[var(--container-rule)] bg-[var(--surface-raised)]',
                      'text-[length:var(--type-micro)] text-[var(--text-secondary)]',
                      'hover:border-[var(--accent-info)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {tab === 'watches' ? (
          watches.length
            ? <WatchList watches={watches} onCancel={onCancelWatch} />
            : <Empty text="Nothing is being watched. Ask me to track a contract." />
        ) : null}

        {tab === 'alerts' ? (
          alerts.length
            ? <ul className="space-y-1.5">{alerts.map((a) => <AlertLine key={a.id} alert={a} />)}</ul>
            : <Empty text="No alerts have fired yet." />
        ) : null}
      </div>

      {/* ── Composer ── */}
      {tab === 'chat' ? (
        <div className="shrink-0 border-t border-[var(--container-rule)] bg-[var(--container-head)] p-2">
          {interim ? (
            <p className="mb-1 truncate px-1 text-[length:var(--type-micro)] italic text-[var(--accent-info)]">
              {interim}
            </p>
          ) : null}
          <div className="flex items-end gap-1.5">
            <textarea
              ref={input}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter breaks the line — the convention
                // everywhere else, and muscle memory is not worth fighting.
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
              }}
              placeholder={listening ? 'Listening…' : 'Ask about a chain, or set a watch…'}
              className={cn(
                'max-h-24 min-h-[34px] flex-1 resize-none rounded-[var(--radius-sm)] border px-2.5 py-1.5',
                'border-[var(--control-border)] bg-[var(--control-bg)]',
                'text-[length:var(--type-caption)] text-[var(--text-primary)]',
                'placeholder:text-[var(--text-disabled)]',
                'focus:border-[var(--accent-info)] focus:outline-none',
              )}
            />
            <button
              type="button"
              onClick={onClear}
              title="Clear conversation"
              aria-label="Clear conversation"
              className="grid size-[34px] shrink-0 place-items-center rounded-[var(--radius-sm)] text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]"
            >
              <Trash2 size={14} />
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              aria-label="Send"
              className={cn(
                'grid size-[34px] shrink-0 place-items-center rounded-[var(--radius-sm)]',
                draft.trim()
                  ? 'bg-[var(--action-primary-bg)] text-[var(--action-primary-text)] hover:bg-[var(--action-primary-hover)]'
                  : 'bg-[var(--control-bg)] text-[var(--text-disabled)]',
              )}
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Bubble({ message }: { message: Message }) {
  const mine = message.role === 'user';
  return (
    <div className={cn('mb-2.5 flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[92%]', mine && 'max-w-[85%]')}>
        <div
          className={cn(
            'rounded-[var(--radius-md)] px-2.5 py-1.5',
            'text-[length:var(--type-caption)] leading-relaxed whitespace-pre-wrap',
            mine
              ? 'bg-[var(--accent-info-soft)] text-[var(--text-primary)]'
              : message.error
                ? 'border border-[var(--status-danger)] bg-[var(--status-danger-soft)] text-[var(--text-primary)]'
                : 'bg-[var(--surface-raised)] text-[var(--text-primary)]',
          )}
        >
          {message.text}
        </div>
        {message.cards?.map((card, i) => <IrisCard key={i} card={card} />)}
      </div>
    </div>
  );
}

function Thinking() {
  return (
    <div className="mb-2.5 flex justify-start">
      <div className="flex gap-1 rounded-[var(--radius-md)] bg-[var(--surface-raised)] px-3 py-2.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 rounded-full bg-[var(--text-tertiary)]"
            style={{ animation: `qs-pulse 1.1s ease-in-out ${i * 0.18}s infinite` }}
          />
        ))}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="mt-6 px-4 text-center text-[length:var(--type-caption)] text-[var(--text-tertiary)]">
      {text}
    </p>
  );
}
