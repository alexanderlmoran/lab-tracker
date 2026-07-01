// System Integrity sub-tab — the zero-gap board. Every DOB / accession gap and
// any accession collision, with a link straight to the case to fix it. Goal:
// all counters at 0.

import Link from "next/link";
import type { IntegrityReport, GapCase } from "@/lib/labs/integrity";

function Count({ label, n, tone }: { label: string; n: number; tone: "ok" | "warn" | "danger" }) {
  const cls =
    n === 0
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : tone === "danger"
        ? "border-rose-300 bg-rose-50 text-rose-800"
        : "border-amber-300 bg-amber-50 text-amber-800";
  return (
    <div className={`rounded-lg border p-4 ${cls}`}>
      <p className="text-xs uppercase tracking-wide opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{n === 0 ? "0 ✓" : n}</p>
    </div>
  );
}

function GapList({ title, cases, hint }: { title: string; cases: GapCase[]; hint: string }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-zinc-900">
        {title} <span className="font-normal text-zinc-400">({cases.length})</span>
      </h2>
      <p className="mb-2 text-xs text-zinc-500">{hint}</p>
      {cases.length === 0 ? (
        <p className="text-xs text-emerald-600">None — clean ✓</p>
      ) : (
        <ul className="divide-y divide-zinc-100 text-sm">
          {cases.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-1.5">
              <Link href={`/labs/${c.id}`} className="min-w-0 flex-1 truncate text-zinc-900 hover:underline">
                {c.patientName}
                <span className="text-zinc-400"> · {c.labPanel ? `${c.labName} · ${c.labPanel}` : c.labName}</span>
              </Link>
              <span className="shrink-0 text-xs text-zinc-400">{c.patientEmail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function IntegrityView({ report }: { report: IntegrityReport }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Count label="Total gaps" n={report.gapCount} tone="warn" />
        <Count label="Missing DOB" n={report.dobGaps.length} tone="warn" />
        <Count label="Missing accession" n={report.accessionGaps.length} tone="warn" />
        <Count label="Accession collisions" n={report.collisions.length} tone="danger" />
      </div>

      {report.collisions.length > 0 ? (
        <section className="rounded-lg border border-rose-300 bg-rose-50 p-4">
          <h2 className="text-sm font-semibold text-rose-900">⚠ Accession collisions (wrong-patient hazard)</h2>
          <p className="mb-2 text-xs text-rose-800">One accession is on two different patients — fix immediately.</p>
          <ul className="text-xs text-rose-900">
            {report.collisions.map((c) => (
              <li key={c.accession} className="py-0.5">
                <span className="font-mono">{c.accession}</span> → {c.patients.join(", ")}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <GapList
        title="Missing DOB"
        cases={report.dobGaps}
        hint="DOB disambiguates same-name PB charts before a post — enter it on the case (or it auto-fills when the result PDF lands)."
      />
      <GapList
        title="Missing accession (shipped)"
        cases={report.accessionGaps}
        hint="Shipped cases with no lab order/requisition # — the result can't be auto-matched back until this is set."
      />
    </div>
  );
}
