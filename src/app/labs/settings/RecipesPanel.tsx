"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deleteScraperRecipe,
  testScraperRecipe,
  upsertScraperRecipe,
  type RecipeTestResult,
  type ScraperRecipeRow,
} from "./actions";

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

function bodyOf(row: ScraperRecipeRow): string {
  return JSON.stringify(
    { auth: row.auth, discovery: row.discovery, pdf: row.pdf, match: row.match_cfg ?? undefined, ready: row.ready_cfg ?? undefined },
    null,
    2,
  );
}

export function RecipesPanel({ rows }: { rows: ScraperRecipeRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ScraperRecipeRow | "new" | null>(null);
  const [testing, setTesting] = useState<{ key: string; dryRun: boolean } | null>(null);
  const [test, setTest] = useState<{ key: string; result?: RecipeTestResult; error?: string } | null>(null);

  function runTest(key: string, dryRun: boolean) {
    setError(null);
    setTesting({ key, dryRun });
    setTest(null);
    startTransition(async () => {
      const res = await testScraperRecipe({ key, dryRun });
      setTesting(null);
      if (!res.ok) setTest({ key, error: res.error });
      else setTest({ key, result: res.data });
    });
  }

  function submit(form: HTMLFormElement) {
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

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await deleteScraperRecipe({ id });
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-700">
          DB <span className="font-medium">overrides</span> for the worker&apos;s built-in recipes. A row here wins over
          the built-in of the same key. Empty = all portals use their built-in recipe.
        </p>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="shrink-0 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
        >
          Add override
        </button>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</div>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-xs text-zinc-500">No recipe overrides yet — built-in catalog recipes are active.</p>
      ) : (
        <table className="w-full border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wide text-zinc-500">
              <th className="py-2 pr-3 font-semibold">Key</th>
              <th className="py-2 pr-3 font-semibold">Lab</th>
              <th className="py-2 pr-3 font-semibold">Transport</th>
              <th className="py-2 pr-3 font-semibold">Enabled</th>
              <th className="py-2 pr-3"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-zinc-100">
                <td className="py-2 pr-3 font-mono text-[12px] text-zinc-900">{r.key}</td>
                <td className="py-2 pr-3 text-zinc-800">{r.lab_name}</td>
                <td className="py-2 pr-3 text-zinc-700">{r.transport}</td>
                <td className="py-2 pr-3 text-zinc-700">{r.enabled ? "yes" : "no"}</td>
                <td className="py-2 pr-3 text-right">
                  <button
                    type="button"
                    onClick={() => runTest(r.key, false)}
                    disabled={pending}
                    className="mr-3 text-xs text-zinc-600 hover:text-zinc-900 disabled:opacity-50"
                  >
                    {testing?.key === r.key && !testing.dryRun ? "Testing…" : "Test"}
                  </button>
                  <button
                    type="button"
                    onClick={() => runTest(r.key, true)}
                    disabled={pending}
                    title="Runs the recipe against open cases on the live portal — does NOT post results"
                    className="mr-3 text-xs text-amber-700 hover:text-amber-900 disabled:opacity-50"
                  >
                    {testing?.key === r.key && testing.dryRun ? "Running…" : "Dry-run"}
                  </button>
                  <button type="button" onClick={() => setEditing(r)} className="mr-3 text-xs text-zinc-600 hover:text-zinc-900">
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(r.id)}
                    disabled={pending}
                    className="text-xs text-red-600 hover:text-red-800 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {test ? (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-[12px]">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono text-zinc-900">test: {test.key}</span>
            <button type="button" onClick={() => setTest(null)} className="text-[11px] text-zinc-500 hover:text-zinc-800">
              dismiss
            </button>
          </div>
          {test.error ? (
            <p className="text-red-700">{test.error}</p>
          ) : test.result ? (
            <div className="space-y-1 text-zinc-800">
              <p>
                source <span className="font-medium">{test.result.source}</span> · transport{" "}
                <span className="font-medium">{test.result.transport}</span> · builds{" "}
                <span className={test.result.builds ? "text-emerald-700" : "text-red-700"}>
                  {test.result.builds ? "yes" : "no"}
                </span>
              </p>
              {test.result.strategies ? (
                <p className="font-mono text-[11px] text-zinc-600">
                  auth={test.result.strategies.auth} · discovery={test.result.strategies.discovery} · pdf=
                  {test.result.strategies.pdf}
                </p>
              ) : null}
              {test.result.buildError ? <p className="text-red-700">build error: {test.result.buildError}</p> : null}
              {test.result.dryRun ? (
                "skipped" in test.result.dryRun ? (
                  <p className="text-amber-700">dry-run skipped: {test.result.dryRun.reason}</p>
                ) : (
                  <div className="mt-1 border-t border-zinc-200 pt-1">
                    <p className="text-zinc-700">
                      dry-run: checked {test.result.dryRun.checked} · found {test.result.dryRun.found.length} · errors{" "}
                      {test.result.dryRun.errors.length}{" "}
                      <span className="text-zinc-500">(nothing posted)</span>
                    </p>
                    {test.result.dryRun.found.map((f, i) => (
                      <p key={i} className="font-mono text-[11px] text-zinc-600">
                        {f.labExternalRef ?? "—"} · {(f.pdfBytes / 1024).toFixed(0)} KB · {f.pdfFilename ?? "—"}
                      </p>
                    ))}
                    {test.result.dryRun.errors.map((e, i) => (
                      <p key={i} className="font-mono text-[11px] text-red-700">
                        {e.caseId}: {e.message}
                      </p>
                    ))}
                  </div>
                )
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(e.currentTarget);
          }}
          className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-4"
        >
          {editing !== "new" ? <input type="hidden" name="id" value={editing.id} /> : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="text-xs text-zinc-600">
              Key
              <input
                name="key"
                defaultValue={editing === "new" ? "" : editing.key}
                required
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono text-[12px] text-zinc-900"
              />
            </label>
            <label className="text-xs text-zinc-600">
              Lab name
              <input
                name="lab_name"
                defaultValue={editing === "new" ? "" : editing.lab_name}
                required
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-[13px] text-zinc-900"
              />
            </label>
            <label className="text-xs text-zinc-600">
              Transport
              <select
                name="transport"
                defaultValue={editing === "new" ? "http" : editing.transport}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-[13px] text-zinc-900"
              >
                <option value="http">http</option>
                <option value="browser">browser</option>
              </select>
            </label>
            <label className="flex items-center gap-2 self-end text-xs text-zinc-600">
              <input type="checkbox" name="enabled" defaultChecked={editing === "new" ? true : editing.enabled} />
              Enabled
            </label>
          </div>
          <label className="block text-xs text-zinc-600">
            Recipe body (JSON: auth · discovery · pdf · match? · ready?)
            <textarea
              name="body"
              defaultValue={editing === "new" ? NEW_BODY_TEMPLATE : bodyOf(editing)}
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
              {pending ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={() => setEditing(null)} className="text-xs text-zinc-600 hover:text-zinc-900">
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
