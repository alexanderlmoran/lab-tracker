"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RECIPE_SUMMARY, recipeEngineCoverage, type RecipeSummaryRow } from "@/lib/scrapers/recipe-summary";
import {
  deleteScraperRecipe,
  upsertScraperRecipe,
  testScraperRecipe,
  postTestScraperRecipe,
  type ScraperRecipeRow,
  type RecipeTestResult,
  type PostTestResult,
} from "./actions";

// Unified Settings → Scrapers view. One row per portal that merges what used to
// be three panels: the read-only recipe catalog, the DB-override CRUD, and the
// per-portal test actions. A portal shows its EFFECTIVE recipe (built-in unless a
// DB override exists), and every action lives on the row: Test (resolve), Dry-run
// (scrape, no post), Post test (full chain → test patient's PB), and override
// Edit/Add/Remove.

const NEW_BODY_TEMPLATE = JSON.stringify(
  {
    auth: { strategy: "firebase", config: {} },
    discovery: { strategy: "rest-json", config: {} },
    pdf: { strategy: "http-get", config: {} },
    match: { refLooksLike: "" },
    ready: { mode: "presence" },
  },
  null,
  2,
);

// Read a strategy name out of a jsonb { strategy, config } column.
function stratOf(x: unknown, fallback: string): string {
  if (x && typeof x === "object" && typeof (x as { strategy?: unknown }).strategy === "string") {
    return (x as { strategy: string }).strategy;
  }
  return fallback;
}

function overrideBody(o: ScraperRecipeRow): string {
  return JSON.stringify(
    { auth: o.auth, discovery: o.discovery, pdf: o.pdf, match: o.match_cfg ?? undefined, ready: o.ready_cfg ?? undefined },
    null,
    2,
  );
}

type Joined = {
  summary: RecipeSummaryRow;
  override?: ScraperRecipeRow;
};

type TestState =
  | { kind: "test"; result?: RecipeTestResult; error?: string }
  | { kind: "dryRun"; result?: RecipeTestResult; error?: string }
  | { kind: "post"; result?: PostTestResult; error?: string };

export function PortalRecipesPanel({ overrides }: { overrides: ScraperRecipeRow[] }) {
  const router = useRouter();
  const { total, recipes } = recipeEngineCoverage();
  const byKey = new Map(overrides.map((o) => [o.key, o]));
  const rows: Joined[] = RECIPE_SUMMARY.map((s) => ({ summary: s, override: byKey.get(s.key) }));

  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<{ key: string; action: string } | null>(null);
  const [result, setResult] = useState<{ key: string; state: TestState } | null>(null);
  const [editing, setEditing] = useState<{ key: string; row?: ScraperRecipeRow } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(key: string, action: "test" | "dryRun" | "post") {
    setError(null);
    setResult(null);
    setBusy({ key, action });
    startTransition(async () => {
      if (action === "post") {
        const r = await postTestScraperRecipe({ key });
        setResult({ key, state: { kind: "post", result: r.ok ? r.data : undefined, error: r.ok ? undefined : r.error } });
      } else {
        const r = await testScraperRecipe({ key, dryRun: action === "dryRun" });
        setResult({
          key,
          state: { kind: action, result: r.ok ? r.data : undefined, error: r.ok ? undefined : r.error },
        });
      }
      setBusy(null);
    });
  }

  function saveOverride(form: HTMLFormElement) {
    setError(null);
    const fd = new FormData(form);
    startTransition(async () => {
      const res = await upsertScraperRecipe(fd);
      if (!res.ok) setError(res.error);
      else {
        setEditing(null);
        router.refresh();
      }
    });
  }

  function removeOverride(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await deleteScraperRecipe({ id });
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 bg-white p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-700">
          Every portal&apos;s <span className="font-medium">effective recipe</span> and its test actions in one place. A
          portal runs its built-in recipe unless you add a <span className="font-medium">DB override</span> for it.
        </p>
        <span className="shrink-0 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
          {recipes}/{total} on the engine
        </span>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wide text-zinc-500">
              <th className="py-2 pr-3 font-semibold">Portal</th>
              <th className="py-2 pr-3 font-semibold">Source</th>
              <th className="py-2 pr-3 font-semibold">Transport</th>
              <th className="py-2 pr-3 font-semibold">Strategies (auth · discovery · pdf)</th>
              <th className="py-2 pr-3 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ summary: s, override: o }) => {
              const handwritten = s.status === "hand-written";
              const source = handwritten ? "hand-written" : o ? "DB override" : "built-in";
              const auth = o ? stratOf(o.auth, s.auth) : s.auth;
              const discovery = o ? stratOf(o.discovery, s.discovery) : s.discovery;
              const pdf = o ? stratOf(o.pdf, s.pdf) : s.pdf;
              const transport = o ? o.transport : s.transport;
              const isBusy = busy?.key === s.key;
              return (
                <tr key={s.key} className="border-b border-zinc-100 align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-zinc-900">{s.labName}</div>
                    {s.note ? <div className="text-[11px] text-zinc-500">{s.note}</div> : null}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium " +
                        (source === "DB override"
                          ? "bg-blue-100 text-blue-800"
                          : source === "hand-written"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-emerald-100 text-emerald-800")
                      }
                    >
                      {source}
                    </span>
                    {o && !o.enabled ? <span className="ml-1 text-[10.5px] text-zinc-400">(disabled)</span> : null}
                  </td>
                  <td className="py-2 pr-3 text-zinc-700">{transport}</td>
                  <td className="py-2 pr-3 font-mono text-[11.5px] text-zinc-800">
                    {auth} · {discovery} · {pdf}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <button type="button" onClick={() => run(s.key, "test")} disabled={pending} className="text-zinc-600 hover:text-zinc-900 disabled:opacity-50">
                        {isBusy && busy.action === "test" ? "Testing…" : "Test"}
                      </button>
                      <button type="button" onClick={() => run(s.key, "dryRun")} disabled={pending} title="Scrape against open cases — does NOT post" className="text-amber-700 hover:text-amber-900 disabled:opacity-50">
                        {isBusy && busy.action === "dryRun" ? "Running…" : "Dry-run"}
                      </button>
                      <button type="button" onClick={() => run(s.key, "post")} disabled={pending} title="Full chain → uploads to the TEST patient's PB chart" className="text-red-600 hover:text-red-800 disabled:opacity-50">
                        {isBusy && busy.action === "post" ? "Posting…" : "Post test"}
                      </button>
                      <span className="text-zinc-300">|</span>
                      {handwritten ? (
                        <span className="text-[11px] text-zinc-400">no override</span>
                      ) : o ? (
                        <>
                          <button type="button" onClick={() => setEditing({ key: s.key, row: o })} className="text-zinc-600 hover:text-zinc-900">
                            Edit override
                          </button>
                          <button type="button" onClick={() => removeOverride(o.id)} disabled={pending} className="text-red-600 hover:text-red-800 disabled:opacity-50">
                            Remove
                          </button>
                        </>
                      ) : (
                        <button type="button" onClick={() => setEditing({ key: s.key })} className="text-zinc-600 hover:text-zinc-900">
                          Add override
                        </button>
                      )}
                    </div>

                    {result?.key === s.key ? <ResultLine state={result.state} /> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing ? (
        <OverrideForm
          editing={editing}
          pending={pending}
          onCancel={() => setEditing(null)}
          onSubmit={saveOverride}
        />
      ) : null}
    </div>
  );
}

function ResultLine({ state }: { state: TestState }) {
  if (state.error) return <div className="mt-1 text-[11px] text-red-700">{state.error}</div>;
  if (state.kind === "post") {
    const d = state.result;
    if (!d) return null;
    if (!d.ok) return <div className="mt-1 text-[11px] text-zinc-600">{d.error ?? "no result"}</div>;
    return (
      <div className="mt-1 text-[11px] text-emerald-700">
        ✓ PB labRequest {d.labRequestId} → patient {d.patientId} · {Math.round((d.scraped?.bytes ?? 0) / 1024)} KB
      </div>
    );
  }
  const d = state.result;
  if (!d) return null;
  return (
    <div className="mt-1 text-[11px] text-zinc-700">
      <span className={d.builds ? "text-emerald-700" : "text-red-700"}>builds {d.builds ? "yes" : "no"}</span> · source{" "}
      {d.source}
      {d.buildError ? <span className="text-red-700"> · {d.buildError}</span> : null}
      {state.kind === "dryRun" && d.dryRun && !("skipped" in d.dryRun)
        ? ` · dry-run: checked ${d.dryRun.checked}, found ${d.dryRun.found.length}, errors ${d.dryRun.errors.length} (nothing posted)`
        : null}
    </div>
  );
}

function OverrideForm({
  editing,
  pending,
  onCancel,
  onSubmit,
}: {
  editing: { key: string; row?: ScraperRecipeRow };
  pending: boolean;
  onCancel: () => void;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  const row = editing.row;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(e.currentTarget);
      }}
      className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-4"
    >
      <p className="text-xs font-medium text-zinc-700">
        {row ? "Edit" : "Add"} override · <span className="font-mono">{editing.key}</span>
      </p>
      {row ? <input type="hidden" name="id" value={row.id} /> : null}
      <input type="hidden" name="key" value={editing.key} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="text-xs text-zinc-600">
          Lab name
          <input
            name="lab_name"
            defaultValue={row?.lab_name ?? ""}
            required
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-[13px] text-zinc-900"
          />
        </label>
        <label className="text-xs text-zinc-600">
          Transport
          <select
            name="transport"
            defaultValue={row?.transport ?? "http"}
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-[13px] text-zinc-900"
          >
            <option value="http">http</option>
            <option value="browser">browser</option>
          </select>
        </label>
        <label className="flex items-center gap-2 self-end text-xs text-zinc-600">
          <input type="checkbox" name="enabled" defaultChecked={row ? row.enabled : true} />
          Enabled
        </label>
      </div>
      <label className="block text-xs text-zinc-600">
        Recipe body (JSON: auth · discovery · pdf · match? · ready?)
        <textarea
          name="body"
          defaultValue={row ? overrideBody(row) : NEW_BODY_TEMPLATE}
          rows={16}
          spellCheck={false}
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-[12px] leading-relaxed text-zinc-900"
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save override"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs text-zinc-600 hover:text-zinc-900">
          Cancel
        </button>
      </div>
    </form>
  );
}
