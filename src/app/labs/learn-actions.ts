"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { findLabByName } from "@/lib/labs/catalog";
import { invalidateEffectiveCatalogCache } from "@/lib/labs/effective";
import type { ActionResult } from "@/lib/types";

const MIN_OBSERVATIONS = 5;

export type LearnTurnaroundsResult = {
  /** Lab catalog rows upserted/updated this run. */
  updatedLabs: Array<{
    name: string;
    provider: string;
    panel: string | null;
    observations: number;
    daysMin: number;
    daysMax: number;
    daysMedian: number;
  }>;
  /** Labs we observed but skipped because N < threshold. */
  insufficientObservations: Array<{
    name: string;
    observations: number;
    needed: number;
  }>;
  /** Labs observed that don't map to any catalog entry (provider/panel
   * combination unrecognised) — needs a manual catalog entry first. */
  unmappedLabs: Array<{
    rawLabName: string;
    rawPanel: string | null;
    observations: number;
  }>;
};

type EventRow = {
  created_at: string;
  case_id: string;
};

type CaseRow = {
  id: string;
  lab_name: string;
  lab_panel: string | null;
  collection_date: string | null;
};

function daysBetween(fromIso: string, toIso: string): number | null {
  const from = new Date(fromIso + "T00:00:00").getTime();
  const to = new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const days = Math.round((to - from) / 86_400_000);
  if (days < 0 || days > 365) return null; // toss obvious outliers / data errors
  return days;
}

/** Linear-interpolated quantile from a sorted ascending number array. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const w = pos - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

/**
 * Recompute every lab's turnaround_days_min/max from observed history.
 *
 * Observation model: each (lab_name, lab_panel) combo collects the day-deltas
 * between `collection_date` and the timestamp of the first `step_toggled,
 * step=4, completed=true` event. Past 5 observations we set min = p25 days,
 * max = p75 days on the corresponding labs_catalog row. Fewer than 5 → leave
 * existing turnaround alone.
 *
 * Negative or >365-day deltas are dropped — these are data-entry errors,
 * not real turnaround signals.
 *
 * Why p25/p75 and not min/max: real-world lab turnaround has a long tail
 * (samples that bounce back, manual re-runs). Interquartile range catches
 * the typical experience without letting one outlier explode the "max."
 */
export async function recomputeCatalogTurnaroundsFromHistory(): Promise<
  ActionResult<LearnTurnaroundsResult>
> {
  await requireRole("developer");
  const db = getSupabaseAdmin();

  // Pull every step-4 completion event in one shot. lab_events is bounded
  // enough that this is fine; if it ever grows we can add a (kind,step) index.
  const { data: events, error: eventsErr } = await db
    .from("lab_events")
    .select("created_at, case_id")
    .eq("kind", "step_toggled")
    .eq("step", 4)
    .eq("completed", true)
    .order("created_at", { ascending: true });
  if (eventsErr) return { ok: false, error: eventsErr.message };

  const eventRows = (events ?? []) as EventRow[];
  if (eventRows.length === 0) {
    return {
      ok: true,
      data: { updatedLabs: [], insufficientObservations: [], unmappedLabs: [] },
    };
  }

  // First step-4 toggle per case (subsequent toggles can be untick/retick
  // corrections — the first one is the real "results received" moment).
  const firstToggleByCase = new Map<string, string>();
  for (const e of eventRows) {
    if (!firstToggleByCase.has(e.case_id)) {
      firstToggleByCase.set(e.case_id, e.created_at);
    }
  }
  const caseIds = [...firstToggleByCase.keys()];

  const { data: cases, error: casesErr } = await db
    .from("lab_cases")
    .select("id, lab_name, lab_panel, collection_date")
    .in("id", caseIds);
  if (casesErr) return { ok: false, error: casesErr.message };

  // Group day-deltas by canonical catalog-entry name. Falls back to raw
  // (lab_name, lab_panel) when the combination doesn't resolve to the
  // catalog so the caller can see where they need to add entries.
  const observationsByCatalog = new Map<
    string,
    {
      provider: string;
      panel: string | null;
      days: number[];
    }
  >();
  const unmapped = new Map<string, { rawLabName: string; rawPanel: string | null; days: number[] }>();

  for (const c of (cases ?? []) as CaseRow[]) {
    if (!c.collection_date) continue;
    const observedAt = firstToggleByCase.get(c.id);
    if (!observedAt) continue;
    const days = daysBetween(c.collection_date, observedAt);
    if (days == null) continue;

    const search = c.lab_panel ? `${c.lab_name} ${c.lab_panel}` : c.lab_name;
    const entry = findLabByName(search) ?? findLabByName(c.lab_name);
    if (!entry) {
      const key = `${c.lab_name}||${c.lab_panel ?? ""}`;
      const bucket = unmapped.get(key) ?? {
        rawLabName: c.lab_name,
        rawPanel: c.lab_panel,
        days: [],
      };
      bucket.days.push(days);
      unmapped.set(key, bucket);
      continue;
    }

    const bucket = observationsByCatalog.get(entry.name) ?? {
      provider: entry.provider,
      panel: entry.panel,
      days: [],
    };
    bucket.days.push(days);
    observationsByCatalog.set(entry.name, bucket);
  }

  const updatedLabs: LearnTurnaroundsResult["updatedLabs"] = [];
  const insufficient: LearnTurnaroundsResult["insufficientObservations"] = [];

  for (const [name, bucket] of observationsByCatalog.entries()) {
    if (bucket.days.length < MIN_OBSERVATIONS) {
      insufficient.push({
        name,
        observations: bucket.days.length,
        needed: MIN_OBSERVATIONS,
      });
      continue;
    }
    const sorted = [...bucket.days].sort((a, b) => a - b);
    // p25 / p75, rounded; clamp min to at least 1 day so the UI doesn't
    // show "Expected by 0 days" which would look broken.
    const p25 = Math.max(1, Math.round(quantile(sorted, 0.25)));
    const p75 = Math.max(p25, Math.round(quantile(sorted, 0.75)));
    const median = Math.round(quantile(sorted, 0.5));

    // Upsert by unique `name`. If a row exists we update min/max; otherwise
    // we insert with provider/panel from the catalog entry.
    const { error: upsertErr } = await db
      .from("labs_catalog")
      .upsert(
        {
          name,
          provider: bucket.provider,
          panel: bucket.panel,
          turnaround_days_min: p25,
          turnaround_days_max: p75,
        },
        { onConflict: "name" },
      );
    if (upsertErr) {
      return { ok: false, error: `labs_catalog upsert for ${name}: ${upsertErr.message}` };
    }
    updatedLabs.push({
      name,
      provider: bucket.provider,
      panel: bucket.panel,
      observations: bucket.days.length,
      daysMin: p25,
      daysMax: p75,
      daysMedian: median,
    });
  }

  invalidateEffectiveCatalogCache();
  revalidatePath("/labs/reports");
  revalidatePath("/labs/settings");

  return {
    ok: true,
    data: {
      updatedLabs,
      insufficientObservations: insufficient,
      unmappedLabs: [...unmapped.entries()].map(([, v]) => ({
        rawLabName: v.rawLabName,
        rawPanel: v.rawPanel,
        observations: v.days.length,
      })),
    },
  };
}
