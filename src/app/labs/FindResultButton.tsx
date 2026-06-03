"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { probeCaseResult, setCaseAccession, type ProbeResult } from "./probe-actions";
import { probeKeyForLab } from "@/lib/scrapers/normalize-lab";

function kb(bytes: number): string {
  if (!bytes) return "0 KB";
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * "Find result" — name-probe a case's portal to surface its accession when the
 * card has none. Shows candidate(s) returned by the worker; clicking one writes
 * its accession onto the case (which clears it out of the accession-less state).
 * Only renders for labs the worker can actually scrape.
 */
export function FindResultButton({
  caseId,
  labName,
}: {
  caseId: string;
  labName: string;
}) {
  const router = useRouter();
  const [probing, startProbe] = useTransition();
  const [setting, startSet] = useTransition();
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // No scraper for this lab → nothing to probe; don't render the button.
  if (!probeKeyForLab(labName)) return null;

  function onProbe() {
    setError(null);
    setResult(null);
    startProbe(async () => {
      const r = await probeCaseResult({ caseId });
      if (!r.ok) {
        setError(r.error ?? "Probe failed");
        return;
      }
      setResult(r.data ?? null);
    });
  }

  function onSet(accession: string) {
    setError(null);
    startSet(async () => {
      const r = await setCaseAccession({ caseId, accession });
      if (!r.ok) {
        setError(r.error ?? "Could not set accession");
        return;
      }
      setResult(null);
      router.refresh();
    });
  }

  const withRef = (result?.found ?? []).filter((f) => f.ref);

  return (
    <span className="inline-flex flex-col gap-1 align-top">
      <button
        type="button"
        onClick={onProbe}
        disabled={probing || setting}
        className="self-start rounded-md border border-indigo-300 bg-white px-2 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
        title="Search the lab portal for this patient's result by name (no accession needed)"
      >
        {probing ? "Searching…" : "Find result"}
      </button>

      {error ? <span className="text-[11px] text-red-600">{error}</span> : null}

      {result ? (
        withRef.length > 0 ? (
          <span className="flex flex-col gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5">
            <span className="text-[11px] text-zinc-600">
              Found on {result.lab} for {result.name}:
            </span>
            {withRef.map((f, i) => (
              <span key={`${f.ref}-${i}`} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] font-medium text-zinc-900">
                  {f.ref}
                </span>
                <span className="text-[10px] text-zinc-500">
                  {f.resultIssuedAt ? `${f.resultIssuedAt.slice(0, 10)} · ` : ""}
                  {kb(f.pdfBytes)}
                </span>
                <button
                  type="button"
                  onClick={() => onSet(f.ref as string)}
                  disabled={setting || probing}
                  className="rounded border border-emerald-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
                >
                  {setting ? "Saving…" : `Set Acc# ${f.ref}`}
                </button>
              </span>
            ))}
          </span>
        ) : (
          <span className="text-[11px] text-zinc-500">
            No result in the portal yet — not ready.
            {result.errors.length > 0
              ? ` (${result.errors.map((e) => e.message).join("; ")})`
              : ""}
          </span>
        )
      ) : null}
    </span>
  );
}
