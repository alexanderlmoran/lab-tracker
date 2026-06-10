import Link from "next/link";
import { requireUser } from "@/lib/auth-guard";
import { listRecordsCases } from "../actions";
import { HudPulse } from "../HudPulse";
import { formatPersonName, formatShortDate } from "@/lib/format";
import { labelForCase } from "@/lib/labs/label";
import { getColumnFor, COLUMN_LABEL } from "@/lib/columns";
import { RecordsSearch } from "./RecordsSearch";
import type { LabCase } from "@/lib/types";

export const dynamic = "force-dynamic";

function firstString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

// The date that matters for a record: the draw/collection date, falling back
// to when the case was created (kit-out, manual entry) so undated rows still
// sort and display something meaningful.
function recordDate(c: LabCase): string {
  return c.collection_date ?? c.created_at.slice(0, 10);
}

function recordDateLabel(c: LabCase): string {
  if (c.collection_date) return formatShortDate(c.collection_date);
  // created_at is a full ISO timestamp; formatShortDate wants YYYY-MM-DD.
  return formatShortDate(c.created_at.slice(0, 10));
}

type PatientGroup = {
  email: string;
  name: string;
  cases: LabCase[];
  latest: string;
};

export default async function RecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = firstString(sp.q);

  const cases = await listRecordsCases({ filters: { q } });

  // Group by patient email (the canonical patient key everywhere else in the
  // app). Within a patient, cases stay newest-first by record date.
  const groups = new Map<string, PatientGroup>();
  for (const c of cases) {
    const key = c.patient_email.toLowerCase();
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        email: c.patient_email,
        name: c.patient_name,
        cases: [c],
        latest: recordDate(c),
      });
    } else {
      g.cases.push(c);
      if (recordDate(c) > g.latest) g.latest = recordDate(c);
    }
  }
  for (const g of groups.values()) {
    g.cases.sort((a, b) => recordDate(b).localeCompare(recordDate(a)));
  }
  // Patients ordered by their most recent record.
  const patientGroups = [...groups.values()].sort((a, b) =>
    b.latest.localeCompare(a.latest),
  );

  return (
    <div className="min-h-dvh bg-zinc-50">
      <HudPulse user={user} />
      <main className="mx-auto max-w-7xl px-6 py-4 pb-16">
        <div className="mb-3">
          <h1 className="text-base font-semibold tracking-tight text-zinc-900">
            Records
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500">
            {cases.length} {cases.length === 1 ? "lab" : "labs"} across{" "}
            {patientGroups.length}{" "}
            {patientGroups.length === 1 ? "patient" : "patients"} · every case in
            the tracker, active and archived. Look up a patient's lab history
            without opening PracticeBetter or Zenoti.
          </p>
        </div>

        {/* PHASE 2 — historical backfill. The records below come only from
            `lab_cases` (cases the tracker has touched). The full #22 ask is
            "ALL labs by ALL patients, June 2025 → now," which includes orders
            that were placed/completed in PB or Zenoti before this tracker
            existed and never became a case. Those would have to be imported:
            either via the existing CSV import (src/app/labs/import) or a new
            backfill that reads PB/Zenoti history (see the PB uploader / Zenoti
            sync workers) and upserts read-only "record" cases. Until then this
            portal is complete for tracker-managed labs only. */}
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="font-medium">Showing tracker records only.</span>{" "}
          Labs placed in PracticeBetter or Zenoti before they entered the
          tracker aren&apos;t here yet — that historical backfill (June 2025 →
          now) is a planned phase 2. Use{" "}
          <Link href="/labs/import" className="underline">
            Import
          </Link>{" "}
          to bring older records in.
        </div>

        <div className="mb-3">
          <RecordsSearch />
        </div>

        {patientGroups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center">
            <p className="text-sm text-zinc-600">
              {q ? "No records match your search." : "No records yet."}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {patientGroups.map((g) => (
              <section
                key={g.email.toLowerCase()}
                className="overflow-hidden rounded-lg border border-zinc-200 bg-white"
              >
                <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-zinc-200 bg-zinc-50 px-4 py-2">
                  <div>
                    <Link
                      href={`/labs/patients/${encodeURIComponent(
                        g.email.toLowerCase(),
                      )}`}
                      className="text-sm font-semibold text-zinc-900 hover:underline"
                    >
                      {formatPersonName(g.name)}
                    </Link>
                    <span className="ml-2 text-xs text-zinc-500">
                      {g.email}
                    </span>
                  </div>
                  <span className="text-xs text-zinc-500">
                    {g.cases.length} {g.cases.length === 1 ? "lab" : "labs"}
                  </span>
                </header>
                <table className="w-full text-sm">
                  <thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                    <tr>
                      <th className="px-4 py-1.5 text-left font-semibold">
                        Date
                      </th>
                      <th className="px-4 py-1.5 text-left font-semibold">
                        Lab
                      </th>
                      <th className="px-4 py-1.5 text-left font-semibold">
                        Status
                      </th>
                      <th className="px-4 py-1.5 text-right font-semibold" />
                    </tr>
                  </thead>
                  <tbody>
                    {g.cases.map((c) => (
                      <tr
                        key={c.id}
                        className="border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50"
                      >
                        <td className="whitespace-nowrap px-4 py-1.5 text-zinc-600">
                          {recordDateLabel(c)}
                        </td>
                        <td className="px-4 py-1.5 text-zinc-900">
                          {labelForCase(c)}
                        </td>
                        <td className="px-4 py-1.5 text-zinc-600">
                          {COLUMN_LABEL[getColumnFor(c)]}
                          {c.archived_at ? (
                            <span className="ml-1.5 rounded bg-zinc-100 px-1 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
                              archived
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-1.5 text-right">
                          <Link
                            href={`/labs/${c.id}`}
                            className="text-xs font-medium text-zinc-500 hover:text-zinc-900 hover:underline"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
