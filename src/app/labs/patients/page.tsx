import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guard";
import { listPatients } from "../actions";
import { logoutAction } from "../../login/actions";
import { PatientSearch } from "./PatientSearch";

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
  const user = await requireAdmin();
  const sp = await searchParams;
  const q = firstString(sp.q);
  const patients = await listPatients({ q });

  return (
    <div className="min-h-dvh bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Patients
            </h1>
            <p className="text-xs text-zinc-500">
              {patients.length} {patients.length === 1 ? "patient" : "patients"}
              {" · grouped by email"}
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link
              href="/labs"
              className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              ← Cases
            </Link>
            <span className="text-zinc-600">{user.email}</span>
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto mt-6 max-w-7xl px-6 pb-16">
        <div className="mb-4">
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
                        {p.patient_name}
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
