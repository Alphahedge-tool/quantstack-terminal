/**
 * What can go in a chart slot.
 *
 * One list, so adding an analytic is one entry here plus one branch in
 * `StraddleSlot` — rather than an edit in the picker, an edit in the slot, an
 * edit in the layout code and a fourth place that decides the default.
 */

import { Activity, CandlestickChart, Scale, type LucideIcon } from 'lucide-react';

export type ChartKind = 'straddle' | 'greeks' | 'skew';

export interface ChartKindSpec {
  kind: ChartKind;
  label: string;
  /** One line in the picker. Says what the chart MEASURES, not what it looks
   *  like — "premium, IV and the synthetic future" is a chooser; "a candle
   *  chart with two panes" is not. */
  description: string;
  icon: LucideIcon;
  /** Warned about in the picker, because these two walk 30–100 option series
   *  on a cold contract and the wait is otherwise unexplained. */
  slow?: boolean;
}

export const CHART_KINDS: readonly ChartKindSpec[] = [
  {
    kind: 'straddle',
    label: 'Rolling straddle',
    description: 'ATM premium, implied volatility and the synthetic future',
    icon: CandlestickChart,
  },
  {
    kind: 'greeks',
    label: 'Band greeks',
    description: 'Vega and theta summed across the 0.05–0.60 delta band',
    icon: Activity,
    slow: true,
  },
  {
    kind: 'skew',
    label: 'Risk reversal',
    description: '25-delta put/call volatility skew against ATM',
    icon: Scale,
    slow: true,
  },
];

export function specFor(kind: ChartKind): ChartKindSpec {
  return CHART_KINDS.find((c) => c.kind === kind) ?? CHART_KINDS[0];
}
