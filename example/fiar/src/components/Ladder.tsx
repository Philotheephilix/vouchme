import { points, usd } from "@/lib/format";
import type { LadderRung } from "@/lib/policy";

/**
 * The date-due column of a circulation card, reused as a price ladder: the same item quoted at
 * every rung of VouchMe's scale, with the viewer's own row filed in among them.
 *
 * This is the screen that makes the integration legible. A discount is invisible unless you can see
 * the price you are not paying, and a ladder only motivates if you can see the rung above.
 */
export function Ladder({ rungs, you }: { rungs: LadderRung[]; you: LadderRung | null }) {
  // Filed by score, the way the cards themselves would be — so the viewer's row sits physically
  // between the rung they cleared and the one they have not.
  const rows = (you ? [...rungs, you] : rungs).sort((a, b) => a.score - b.score);

  return (
    <table className="w-full border-collapse font-typed text-xs">
      <caption className="pb-2 text-left font-sans text-2xs uppercase tracking-[0.24em] text-ink-soft">
        What each rung pays
      </caption>
      <thead>
        <tr className="border-b border-pocket text-left text-2xs uppercase tracking-[0.14em] text-ink-soft">
          <th scope="col" className="py-1 font-normal">
            Standing
          </th>
          <th scope="col" className="py-1 text-right font-normal">
            Score
          </th>
          <th scope="col" className="py-1 text-right font-normal">
            Deposit
          </th>
          <th scope="col" className="py-1 text-right font-normal">
            Per day
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => {
          const isYou = row === you;
          return (
            <tr
              key={`${row.label}-${index}`}
              className={`border-b border-rule-card last:border-0 ${isYou ? "text-stamp" : "text-ink"}`}
            >
              <th scope="row" className={`py-1.5 text-left font-normal ${isYou ? "font-bold" : ""}`}>
                {row.label}
              </th>
              <td className="py-1.5 text-right">{points(row.score)}</td>
              <td className={`py-1.5 text-right ${isYou ? "font-bold" : ""}`}>
                {row.withinCeiling ? usd(row.depositUsd) : "—"}
              </td>
              <td className="py-1.5 text-right">
                {row.withinCeiling ? usd(row.ratePerDayUsd) : <span className="text-ink-soft">over limit</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
