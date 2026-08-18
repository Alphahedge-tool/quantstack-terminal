/**
 * The orb — IRIS's presence on every page.
 *
 * ── Why an orb and not a button ──
 *
 * It has to convey state at a glance from across a desk: listening, thinking,
 * speaking, or holding an alert. A button with a label can say one of those; a
 * shape that breathes, spins and pulses can say all four without the user
 * reading anything. That is the entire reason Siri, and every assistant since,
 * is a blob rather than a chat icon.
 *
 * ── Why CSS and not canvas ──
 *
 * This element is mounted on every page of a terminal that is already pushing
 * a charting engine and several live sockets. A canvas animation would hold a
 * rAF loop open permanently for decoration. Layered conic/radial gradients on
 * GPU-composited transforms cost effectively nothing, keep running when the tab
 * throttles, and — the part that matters — stop entirely when the orb is idle.
 *
 * ── Reduced motion ──
 *
 * Every animation here is decorative, so `prefers-reduced-motion` disables all
 * of them and the state is carried by colour and the ring alone. On a trading
 * screen that is not an accessibility checkbox: a permanently rotating object
 * in peripheral vision is genuinely distracting when you are reading numbers.
 */

import { Mic, MicOff, Sparkles, WifiOff } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { OrbState } from '@/hooks/useIris';

interface IrisOrbProps {
  state: OrbState;
  unread: number;
  open: boolean;
  onClick: () => void;
  /** Mic toggle sits on the orb itself — the shortcut for "just talk to it". */
  onMic: () => void;
  micArmed: boolean;
  micDenied: boolean;
}

/** Ring colour per state. The one thing that reads from three metres away. */
const RING: Record<OrbState, string> = {
  idle:      'var(--accent-info)',
  listening: 'var(--status-success)',
  thinking:  'var(--status-warning)',
  speaking:  'var(--accent-info-hover)',
  alert:     'var(--status-danger)',
  offline:   'var(--text-disabled)',
};

const LABEL: Record<OrbState, string> = {
  idle:      'Ask Iris',
  listening: 'Listening…',
  thinking:  'Thinking…',
  speaking:  'Speaking…',
  alert:     'Alert',
  offline:   'Reconnecting…',
};

export function IrisOrb({
  state, unread, open, onClick, onMic, micArmed, micDenied,
}: IrisOrbProps) {
  const ring = RING[state];
  const animated = state !== 'idle' && state !== 'offline';

  return (
    <div className="pointer-events-auto flex items-center gap-2">
      {/* Mic toggle. Separate from the orb so tapping the orb never surprises
          the user by opening the microphone — a real concern in an office. */}
      <button
        type="button"
        onClick={onMic}
        disabled={micDenied}
        title={
          micDenied ? 'Microphone permission was refused'
          : micArmed ? 'Stop listening for “Hey Iris”'
          : 'Listen for “Hey Iris”'
        }
        aria-label={micArmed ? 'Disable wake word' : 'Enable wake word'}
        className={cn(
          'grid size-9 place-items-center rounded-full border transition-colors',
          'shadow-[var(--control-shadow)]',
          micDenied
            ? 'cursor-not-allowed border-[var(--control-border)] bg-[var(--control-bg)] text-[var(--text-disabled)]'
            : micArmed
              ? 'border-[var(--status-success)] bg-[var(--status-success-soft)] text-[var(--status-success)]'
              : 'border-[var(--control-border)] bg-[var(--control-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
        )}
      >
        {micDenied ? <MicOff size={15} /> : <Mic size={15} />}
      </button>

      <button
        type="button"
        onClick={onClick}
        aria-label={LABEL[state]}
        title={LABEL[state]}
        aria-expanded={open}
        className="group relative grid size-14 place-items-center rounded-full outline-none"
        style={{ ['--iris-ring' as string]: ring }}
      >
        {/* Halo — the soft bloom that makes the orb read as lit rather than
            drawn. Scales with state so an alert is visibly "louder". */}
        <span
          aria-hidden
          className={cn(
            'absolute inset-0 rounded-full blur-md transition-opacity duration-300',
            animated ? 'opacity-70' : 'opacity-35 group-hover:opacity-60',
          )}
          style={{ background: `radial-gradient(circle, ${ring} 0%, transparent 68%)` }}
        />

        {/* Pulse ring — expands and fades. Only while something is happening,
            so an idle terminal has zero running animations. */}
        {animated ? (
          <span
            aria-hidden
            className="iris-pulse absolute inset-0 rounded-full border"
            style={{ borderColor: ring }}
          />
        ) : null}

        {/* The body. A conic sweep over the dark control surface gives it depth
            without an image; the rotation is what makes it feel alive. */}
        <span
          aria-hidden
          className={cn(
            'absolute inset-[3px] rounded-full',
            animated && 'iris-spin',
          )}
          style={{
            background:
              `conic-gradient(from 140deg, ${ring} 0deg, transparent 110deg, `
              + `${ring} 210deg, transparent 320deg, ${ring} 360deg)`,
            opacity: 0.9,
          }}
        />

        {/* Core — sits above the sweep so the icon always has a solid ground
            and never sits directly on a moving gradient. */}
        <span
          aria-hidden
          className={cn(
            'absolute inset-[6px] rounded-full border',
            'bg-[var(--surface-panel)]',
            state === 'listening' && 'iris-breathe',
          )}
          style={{ borderColor: 'var(--container-border)' }}
        />

        <span className="relative z-10 text-[var(--text-primary)]">
          {state === 'offline'
            ? <WifiOff size={18} className="text-[var(--text-disabled)]" />
            : <Sparkles size={18} style={{ color: ring }} />}
        </span>

        {/* Unread badge. Suppressed while the panel is open — the alerts are
            visible right there, and a badge over them is noise. */}
        {unread > 0 && !open ? (
          <span
            className={cn(
              'absolute -right-0.5 -top-0.5 z-20 grid min-w-5 place-items-center rounded-full px-1',
              'border border-[var(--surface-canvas)] bg-[var(--status-danger)]',
              'text-[10px] font-semibold leading-4 text-[var(--text-inverse)]',
            )}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>
    </div>
  );
}
