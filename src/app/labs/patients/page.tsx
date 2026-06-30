import Link from "next/link";
import { requireUser } from "@/lib/auth-guard";
import { listPatients } from "../actions";
import { formatPersonName } from "@/lib/format";
import { PatientSearch } from "./PatientSearch";
import { PatientSortHeader } from "./PatientSortHeader";
import { PatientMergeRow } from "./PatientMergeRow";
import { HudPulse } from "../HudPulse";

export const dynamic = "force-dynamic";

type PatientRow = Awaited<ReturnType<typeof listPatients>>[number];

/** last|first, normalized — the dupe-detection key. */
function nameKey(name: string): string {
  const n = name.toLowerCase().replace(/[^a-z,\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return "";
  if (n.includes(",")) {
    const [last, rest = ""] = n.split(",");
    return `${last.trim()}|${(rest.trim().split(/\s+/)[0] ?? "")}`;
  }
  const toks = n.split(/\s+/);
  return `${toks[toks.length - 1]}|${toks[0] ?? ""}`;
}

/** Groups of patients that share a name but have DIFFERENT emails — likely the
 *  same person split across logins/typos. Read-only surface for human review. */
function potentialDuplicates(patients: PatientRow[]): PatientRow[][] {
  const groups = new Map<string, PatientRow[]>();
  for (const p of patients) {
    const k = nameKey(p.patient_name);
    if (!k || !k.includes("|") || k.split("|").some((x) => !x)) continue;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
  }
  return [...groups.values()]
    .filter((g) => new Set(g.map((p) => p.patient_email.toLowerCase())).size > 1)
    .sort((a, b) => b.length - a.length);
}

function firstString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = firstString(sp.q);
  const patients = await listPatients({ q });

  // Sort (URL-driven; default activity-desc).
  const psort = firstString(sp.psort) ?? "activity";
  const pdir = firstString(sp.pdir) === "asc" ? 1 : -1;
  const sorted = [...patients].sort((a, b) => {
    let c = 0;
    if (psort === "name") c = formatPersonName(a.patient_name).localeCompare(formatPersonName(b.patient_name));
    else if (psort === "cases") c = a.case_count - b.case_count;
    else c = a.last_activity_at.localeCompare(b.last_activity_at);
    return c === 0 ? 0 : c * pdir;
  });

  const dupes = potentialDuplicates(patients);

  return (
    <div className="min-h-dvh bg-zinc-50">
      <HudPulse user={user} />
      <main className="mx-auto max-w-7xl px-6 py-4 pb-16">
        <div className="mb-3">
          <h1 className="text-base font-semibold tracking-tight text-zinc-900">
            Patients
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500">
            {patients.length} {patients.length === 1 ? "patient" : "patients"} ·
            grouped by email.
          </p>
        </div>
        <div className="mb-3">
          <PatientSearch />
        </div>

        {dupes.length > 0 ? (
          <details className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <summary className="cursor-pointer text-xs font-semibold text-amber-900">
              {dupes.length} potential duplicate{dupes.length === 1 ? "" : "s"} — same name, different emails (review &amp; merge)
            </summary>
            <ul className="mt-2 space-y-2">
              {dupes.map((group) => {
                const key = nameKey(group[0].patient_name);
                return (
                  <PatientMergeRow
                    key={key}
                    groupId={key}
                    name={formatPersonName(group[0].patient_name)}
                    members={group.map((p) => ({ email: p.patient_email, caseCount: p.case_count }))}
                  />
                );
              })}
            </ul>
            <p className="mt-2 text-[11px] text-amber-700">
              Pick the email to keep; the rest are re-keyed onto it (recorded in patient_aliases, reversible).
            </p>
          </details>
        ) : null}

        {patients.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center">
            <p className="text-sm text-zinc-600">No patients match.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-600">
                <tr>
                  <PatientSortHeader field="name" label="Patient" />
                  <th className="px-4 py-2 text-left font-semibold">Email</th>
                  <th className="px-4 py-2 text-left font-semibold">Phone</th>
                  <PatientSortHeader field="cases" label="Cases" align="right" />
                  <PatientSortHeader field="activity" label="Last activity" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => (
                  <tr
                    key={p.patient_email.toLowerCase()}
                    className="border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50"
                  >
                    <td className="px-4 py-2">
                      <Link
                        href={`/labs/patients/${encodeURIComponent(
                          p.patient_email.toLowerCase(),
                        )}`}
                        className="font-medium text-zinc-900 hover:underline"
                      >
                        {formatPersonName(p.patient_name)}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-zinc-700">
                      {p.patient_email}
                    </td>
                    <td className="px-4 py-2 text-zinc-600">
                      {p.patient_phone ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-right text-zinc-700">
                      <span className="font-medium">{p.case_count}</span>
                      {p.archived_count + p.deleted_count > 0 ? (
                        <span className="ml-1 text-xs text-zinc-500">
                          ({p.active_count} active)
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-zinc-600">
                      {formatDate(p.last_activity_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
