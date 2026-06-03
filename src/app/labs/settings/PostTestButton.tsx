"use client";

import { useState, useTransition } from "react";
import { postTestScraperRecipe, type PostTestResult } from "./actions";

// Full-pipeline post-test for one portal: scrape the nominated test patient's
// result and upload it to THEIR PB chart (title "TEST", no patient email). Two
// clicks to fire — it does write to PB. The worker guardrail ensures it can only
// ever land on the configured test patient.
export function PostTestButton({ labKey, labName }: { labKey: string; labName: string }) {
  const [pending, start] = useTransition();
  const [armed, setArmed] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; data?: PostTestResult; error?: string } | null>(null);

  function fire() {
    setArmed(false);
    setRes(null);
    start(async () => {
      const r = await postTestScraperRecipe({ key: labKey });
      setRes(r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error });
    });
  }

  return (
    <div className="space-y-1">
      {armed ? (
        <span className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={fire}
            disabled={pending}
            title={`Scrapes ${labName} for the test patient and writes a "TEST" lab to their PB chart`}
            className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            Confirm — writes to PB
          </button>
          <button
            type="button"
            onClick={() => setArmed(false)}
            className="text-[11px] text-zinc-500 hover:text-zinc-800"
          >
            cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setArmed(true)}
          disabled={pending}
          className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
        >
          {pending ? "Posting…" : "Post test"}
        </button>
      )}

      {res ? (
        <div className="text-[11px]">
          {res.error ? (
            <span className="text-red-700">{res.error}</span>
          ) : res.data?.ok ? (
            <span className="text-emerald-700">
              ✓ PB labRequest {res.data.labRequestId} → patient {res.data.patientId} ·{" "}
              {Math.round((res.data.scraped?.bytes ?? 0) / 1024)} KB
            </span>
          ) : (
            <span className="text-zinc-600">{res.data?.error ?? "no result"}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
