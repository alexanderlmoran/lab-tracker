import Link from "next/link";
import { requireUser } from "@/lib/auth-guard";
import { listPatients } from "../actions";
import { formatPersonName } from "@/lib/format";
import { PatientSearch } from "./PatientSearch";
import { HudPulse } from "../HudPulse";

export const dynamic = "force-dynamic";

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

        {patients.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center">
            <p className="text-sm text-zinc-600">No patients match.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-600">
                <tr>
                  <th className="px-4 py-2 text-left font-semibold">Patient</th>
                  <th className="px-4 py-2 text-left font-semibold">Email</th>
                  <th className="px-4 py-2 text-left font-semibold">Phone</th>
                  <th className="px-4 py-2 text-right font-semibold">Cases</th>
                  <th className="px-4 py-2 text-left font-semibold">
                    Last activity
                  </th>
                </tr>
              </thead>
              <tbody>
                {patients.map((p) => (
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
