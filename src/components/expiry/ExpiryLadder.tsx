/**
 * The strike ladder: OI both sides, gamma exposure, and what the flow looks
 * like — one row per strike, ATM in the middle.
 *
 * ── Why one table and not three panels ──
 *
 * "24,500 has the most call OI" is nearly useless on its own. What matters is
 * where that wall sits RELATIVE to spot, whether the OI there is being built or
 * covered, and whether the gamma at that strike is large enough for anyone to
 * be hedging it. Those are three readings of the same row, and splitting them
 * into three panels would make the reader carry a strike number between them.
 *
 * ── The bars are the point ──
 *
 * OI is plotted as a bar and printed as a number, mirrored around the strike
 * column: puts grow left, calls grow right. A wall is then a SHAPE — the eye
 * finds the longest bar without reading a single figure, and the profile of
 * where the market has written its options is visible as a silhouette. That is
 * the same reason a depth ladder in any terminal is drawn this way.
 *
 * Both sides share one scale, because a put bar and a call bar of the same
 * length must mean the same OI or the mirror is a lie.
 */

import { useMemo, useRef, useEffect } from 'react';
import { cn } from '@/lib/cn';
import { integer } from '@/lib/format';
import type { ExpiryRung, OiFlow } from '@/schemas/expiry';

/**
 * The four flows, and how loudly each is said.
 *
 * Writing and short-covering carry colour because they are the two that change
 * what a level MEANS: fresh writing builds a wall, covering dismantles one. The
 * long-side labels are grey — they are the same OI move read from the other end
 * of the trade, and on an index expiry they are the less likely reading.
 */
const FLOW: Record<OiFlow, { label: string; tone: string; title: string }> = {
  writing: {
    label: 'WRT',
    tone: 'var(--market-down)',
    title: 'OI up, price down — fresh writing. The wall is being built.',
  },
  'short-covering': {
    label: 'COV',
    tone: 'var(--market-up)',
    title: 'OI down, price up — short covering. The wall is being dismantled.',
  },
  'long-build': {
    label: 'LNG',
    tone: 'var(--text-secondary)',
    title: 'OI up, price up — longs adding.',
  },
  'long-unwind': {
    label: 'UNW',
    tone: 'var(--text-secondary)',
    title: 'OI down, price down — longs leaving.',
  },
  flat: { label: '', tone: 'transparent', title: '' },
};

function OiBar({
  value, max, side, flow,
}: {
  value: number; max: number; side: 'call' | 'put'; flow: OiFlow;
}) {
  const width = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const colour = side === 'call' ? 'var(--series-ask)' : 'var(--series-bid)';
  return (
    <div
      className={cn(
        'relative h-4 min-w-0 flex-1 overflow-hidden rounded-[2px]',
        side === 'put' && 'scale-x-[-1]',
      )}
      title={`${integer(value)} ${side} OI${flow !== 'flat' ? ` · ${FLOW[flow].title}` : ''}`}
    >
      <span
        className="absolute inset-y-0 left-0 rounded-[2px]"
        style={{
          width: `${width}%`,
          backgroundColor: colour,
          // Two levels of the same hue: the bar is the level, and a brighter
          // edge marks it so adjacent strikes of similar size stay separable.
          opacity: 0.28,
        }}
      />
      <span
        className="absolute inset-y-0"
        style={{ left: `${Math.max(0, width - 1.5)}%`, width: '1.5%', backgroundColor: colour, opacity: 0.9 }}
      />
    </div>
  );
}

export function ExpiryLadder({
  ladder,
  atmStrike,
  spot,
  callWall,
  putWall,
  gammaFlip,
  className,
}: {
  ladder: ExpiryRung[];
  atmStrike: number | null;
  spot: number | null;
  callWall: number | null;
  putWall: number | null;
  gammaFlip: number | null;
  className?: string;
}) {
  const maxOi = useMemo(
    () => ladder.reduce((m, r) => Math.max(m, r.callOi, r.putOi), 0),
    [ladder],
  );
  const maxGex = useMemo(
    () => ladder.reduce((m, r) => Math.max(m, Math.abs(r.netGex)), 0),
    [ladder],
  );

  /**
   * Scroll the ATM into view — once per ATM, not on every poll.
   *
   * The ladder is forty rows and the interesting one is in the middle, so it
   * has to be found for the reader. But re-centring on every 4s refresh would
   * fight anyone who scrolled to look at a wing, so it fires only when the ATM
   * strike itself changes — which is exactly the moment re-centring is wanted.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.querySelector('[data-atm="true"]')
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [atmStrike]);

  if (!ladder.length) {
    return (
      <div className={cn('flex items-center justify-center p-6 text-[length:var(--type-caption)] text-[var(--text-tertiary)]', className)}>
        Waiting for the chain…
      </div>
    );
  }

  return (
    <div ref={scrollRef} className={cn('min-h-0 overflow-auto', className)}>
      <table className="w-full border-collapse text-[length:var(--type-micro)]">
        <thead className="sticky top-0 z-10 bg-[var(--container-head)]">
          <tr className="text-[var(--text-tertiary)]">
            <th className="px-2 py-1 text-left font-medium">Put OI</th>
            <th className="w-24 px-1 py-1 text-right font-medium">Put</th>
            <th className="w-20 px-2 py-1 text-center font-medium">Strike</th>
            <th className="w-24 px-1 py-1 text-left font-medium">Call</th>
            <th className="px-2 py-1 text-right font-medium">Call OI</th>
            <th className="w-28 px-2 py-1 text-right font-medium">Net GEX</th>
          </tr>
        </thead>
        <tbody className="qs-num">
          {ladder.map((rung) => {
            const isAtm = rung.strike === atmStrike;
            const isCallWall = rung.strike === callWall;
            const isPutWall = rung.strike === putWall;
            // The flip is a LEVEL, not a strike, so it is marked on the row it
            // falls inside rather than on a row it happens to equal.
            const flipHere = gammaFlip != null
              && Math.abs(rung.strike - gammaFlip) <= 25;
            const gexWidth = maxGex > 0 ? (Math.abs(rung.netGex) / maxGex) * 100 : 0;

            return (
              <tr
                key={rung.strike}
                data-atm={isAtm}
                className={cn(
                  'border-b border-[var(--rule-soft,var(--border-subtle))]',
                  isAtm && 'bg-[var(--surface-hover)]',
                )}
              >
                <td className="px-2 py-0.5">
                  <div className="flex items-center gap-1.5">
                    <OiBar value={rung.putOi} max={maxOi} side="put" flow={rung.putFlow} />
                    <span className="w-16 shrink-0 text-right text-[var(--text-secondary)]">
                      {integer(rung.putOi)}
                    </span>
                  </div>
                </td>
                <td className="px-1 py-0.5 text-right">
                  <span className="text-[var(--text-primary)]">
                    {rung.put?.ltp != null ? rung.put.ltp.toFixed(2) : '—'}
                  </span>
                  {rung.putFlow !== 'flat' ? (
                    <span
                      className="ml-1 text-[10px] font-semibold"
                      style={{ color: FLOW[rung.putFlow].tone }}
                      title={FLOW[rung.putFlow].title}
                    >
                      {FLOW[rung.putFlow].label}
                    </span>
                  ) : null}
                </td>

                <td
                  className={cn(
                    'px-2 py-0.5 text-center font-semibold',
                    isAtm ? 'text-[var(--accent-info)]' : 'text-[var(--text-primary)]',
                  )}
                >
                  <span className="relative">
                    {rung.strike}
                    {/* The three levels that are read AS levels, marked on the
                        strike itself rather than in a legend elsewhere. */}
                    {isCallWall ? <Mark tone="var(--series-ask)" title="Call wall — most call OI" /> : null}
                    {isPutWall ? <Mark tone="var(--series-bid)" title="Put wall — most put OI" /> : null}
                    {flipHere ? <Mark tone="var(--series-vega)" title="Gamma flip level" /> : null}
                  </span>
                </td>

                <td className="px-1 py-0.5 text-left">
                  {rung.callFlow !== 'flat' ? (
                    <span
                      className="mr-1 text-[10px] font-semibold"
                      style={{ color: FLOW[rung.callFlow].tone }}
                      title={FLOW[rung.callFlow].title}
                    >
                      {FLOW[rung.callFlow].label}
                    </span>
                  ) : null}
                  <span className="text-[var(--text-primary)]">
                    {rung.call?.ltp != null ? rung.call.ltp.toFixed(2) : '—'}
                  </span>
                </td>
                <td className="px-2 py-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-left text-[var(--text-secondary)]">
                      {integer(rung.callOi)}
                    </span>
                    <OiBar value={rung.callOi} max={maxOi} side="call" flow={rung.callFlow} />
                  </div>
                </td>

                <td className="px-2 py-0.5">
                  {/* GEX is drawn from the centre: positive right, negative
                      left, so the sign is a direction rather than a minus the
                      reader has to notice. */}
                  <div className="relative h-3 w-full" title={`${(rung.netGex / 1e7).toFixed(0)} cr per 1% move`}>
                    <span className="absolute inset-y-0 left-1/2 w-px bg-[var(--border-default)]" />
                    <span
                      className="absolute inset-y-0.5 rounded-[1px]"
                      style={{
                        left: rung.netGex >= 0 ? '50%' : `${50 - gexWidth / 2}%`,
                        width: `${gexWidth / 2}%`,
                        backgroundColor: rung.netGex >= 0 ? 'var(--market-up)' : 'var(--market-down)',
                        opacity: 0.55,
                      }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {spot != null ? (
        <p className="px-2 py-1 text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
          Bars share one OI scale across both sides. GEX in ₹ crore per 1% move, drawn from the centre.
        </p>
      ) : null}
    </div>
  );
}

/** A level marker on a strike — a dot, because a label here would collide with
 *  the strike itself at this row height. */
function Mark({ tone, title }: { tone: string; title: string }) {
  return (
    <span
      title={title}
      className="ml-1 inline-block size-1.5 rounded-full align-middle"
      style={{ backgroundColor: tone }}
    />
  );
}
