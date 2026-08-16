/**
 * Analysis Sheets.
 *
 * One sheet today — relative-value volatility between two contracts. The page
 * is a thin frame around it rather than the component itself, because "sheets"
 * is plural on purpose: term structure and a vol cone belong beside this one,
 * and they should arrive as siblings under this route instead of as three more
 * top-level nav entries.
 *
 * Not lazy-loaded. It pulls no charting engine — the sheet is a grid of numbers
 * — so the code-split that `/straddle` needs would only cost a round trip here.
 */

import { AnalysisSheets } from '@/components/analysis/AnalysisSheets';

export function AnalysisPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AnalysisSheets />
    </div>
  );
}
