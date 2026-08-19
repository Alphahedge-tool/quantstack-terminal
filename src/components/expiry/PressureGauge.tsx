/**
 * The pressure score, and the components it is made of.
 *
 * ── Why the components are always visible ──
 *
 * A composite score with its inputs hidden is an oracle, and an oracle is
 * untradeable: at 72 the only useful question is "72 because of what", and a
 * number that cannot answer it gets ignored the third time it is wrong. So the
 * bars are the component scores, always on screen, each carrying the raw figure
 * it was computed from.
 *
 * ── Read the movement, not the level ──
 *
 * Every component is normalised against a hand-set scale rather than against
 * this contract's own history, because that history is being recorded right now
 * and does not exist yet. Until it does, the absolute level is a rough guide and
 * the CHANGE is the signal — 20 to 70 in ten minutes is the event. The panel
 * says so out loud rather than implying a precision it has not earned.
 */

import { cn } from '@/lib/cn';

interface Component {
  key: string;
  label: string;
  score: number;
  detail: string;
}

/** The score's colour, in three steps rather than a gradient — a continuous
 *  ramp reads as precision the number does not have. */
function toneOf(score: number): string {
  if (score >= 65) return 'var(--market-down)';
  if (score >= 35) return 'var(--series-iv)';
  return 'var(--accent-info)';
}

export function PressureGauge({
  score,
  components,
  className,
}: {
  score: number;
  components: Component[];
  className?: string;
}) {
  const tone = toneOf(score);

  return (
    <div className={cn('flex min-w-0 flex-col gap-2 p-3', className)}>
      <div className="flex items-baseline gap-2">
        <span className="qs-label">Expiry pressure</span>
        <strong
          className="qs-num text-[length:var(--type-display,1.6rem)] leading-none"
          style={{ color: tone }}
        >
          {score}
        </strong>
        <span className="text-[length:var(--type-micro)] text-[var(--text-tertiary)]">/ 100</span>
      </div>

      {/* One bar for the composite, so the eye has something to track between
          polls without reading the digits. */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--border-default)]">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${Math.min(100, Math.max(0, score))}%`, backgroundColor: tone }}
        />
      </div>

      <div className="flex flex-col gap-1">
        {components.map((c) => (
          <div key={c.key} className="flex items-center gap-2" title={c.detail}>
            <span className="w-32 shrink-0 truncate text-[length:var(--type-micro)] text-[var(--text-secondary)]">
              {c.label}
            </span>
            <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--border-default)]">
              <span
                className="block h-full rounded-full transition-[width] duration-300"
                style={{
                  width: `${Math.min(100, Math.max(0, c.score))}%`,
                  backgroundColor: toneOf(c.score),
                  opacity: c.score < 10 ? 0.35 : 1,
                }}
              />
            </span>
            <span className="qs-num w-28 shrink-0 truncate text-right text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
              {c.detail}
            </span>
          </div>
        ))}
      </div>

      <p className="text-[length:var(--type-micro)] leading-snug text-[var(--text-tertiary)]">
        Components are normalised against fixed scales, not against this contract's own
        history — that history is still being recorded. Watch the change, not the level.
      </p>
    </div>
  );
}
