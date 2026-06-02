import { RECIPE_SUMMARY, recipeEngineCoverage } from "@/lib/scrapers/recipe-summary";

// Read-only view of the config-driven scraper "recipe engine": which portals run
// as data-driven recipes (vs hand-written) and the strategy stack each uses.
// Mirrors worker/src/recipes/catalog.ts (see recipe-summary.ts).
export function RecipeEnginePanel() {
  const { total, recipes } = recipeEngineCoverage();
  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-700">
          Portals run by the config engine instead of a hand-written scraper. Each picks a strategy per
          axis (auth · discovery · pdf) plus config.
        </p>
        <span className="shrink-0 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
          {recipes}/{total} on the engine
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wide text-zinc-500">
              <th className="py-2 pr-3 font-semibold">Portal</th>
              <th className="py-2 pr-3 font-semibold">Engine</th>
              <th className="py-2 pr-3 font-semibold">Transport</th>
              <th className="py-2 pr-3 font-semibold">Auth</th>
              <th className="py-2 pr-3 font-semibold">Discovery</th>
              <th className="py-2 pr-3 font-semibold">PDF</th>
            </tr>
          </thead>
          <tbody>
            {RECIPE_SUMMARY.map((r) => (
              <tr key={r.key} className="border-b border-zinc-100 align-top">
                <td className="py-2 pr-3">
                  <div className="font-medium text-zinc-900">{r.labName}</div>
                  {r.note ? <div className="text-[11px] text-zinc-500">{r.note}</div> : null}
                </td>
                <td className="py-2 pr-3">
                  {r.status === "recipe" ? (
                    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10.5px] font-medium text-emerald-800">
                      ✓ recipe
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-medium text-amber-800">
                      hand-written
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 text-zinc-700">{r.transport}</td>
                <td className="py-2 pr-3 font-mono text-[12px] text-zinc-800">{r.auth}</td>
                <td className="py-2 pr-3 font-mono text-[12px] text-zinc-800">{r.discovery}</td>
                <td className="py-2 pr-3 font-mono text-[12px] text-zinc-800">{r.pdf}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
