import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSignedIn } from "@/lib/auth-guard";
import { getPatientHistory } from "../../actions";
import { logoutAction } from "../../../login/actions";
import { COLUMN_LABEL, getColumnFor } from "@/lib/columns";

export const dynamic = "force-dynamic";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function StatusPill({
  archived,
  deleted,
}: {
  archived: string | null;
  deleted: string | null;
}) {
  if (deleted) {
    return (
      <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-700">
        Deleted
      </span>
    );
  }
  if (archived) {
    return (
      <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-700">
        Archived
      </span>
    );
  }
  return (
    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
      Active
    </span>
  );
}

export default async function PatientDetailPage({
  params,
}: {
  params: Promise<{ email: string }>;
}) {
  const user = await requireSignedIn();
  const { email: rawEmail } = await params;
  const email = decodeURIComponent(rawEmail);
  const history = await getPatientHistory(email);
  if (!history) notFound();

  const primary = history.cases[0];

  return (
    <div className="min-h-dvh bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              {primary.patient_name}
            </h1>
            <p className="text-xs text-zinc-500">{history.email}</p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link
              href="/labs/patients"
              className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              ← Patients
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

      <main className="mx-auto mt-6 grid max-w-7xl gap-6 px-6 pb-16 lg:grid-cols-3">
        <section className="lg:col-span-2 space-y-6">
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900">
              Contact
            </h2>
            <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-xs uppercase tracking-wide text-zinc-500">
                Email
              </dt>
              <dd className="text-zinc-900">{history.email}</dd>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">
                Phone
              </dt>
              <dd className="text-zinc-900">{primary.patient_phone ?? "—"}</dd>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">
                DOB
              </dt>
              <dd className="text-zinc-900">{primary.patient_dob ?? "—"}</dd>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">
                Address
              </dt>
              <dd className="whitespace-pre-wrap text-zinc-900">
                {primary.patient_address ?? "—"}
              </dd>
            </dl>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900">
              Cases ({history.cases.length})
            </h2>
            <ul className="space-y-2">
              {history.cases.map((c) => {
                const col = getColumnFor(c);
                return (
                  <li
                    key={c.id}
                    className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/labs/${c.id}`}
                        className="text-sm font-medium text-zinc-900 hover:underline"
                      >
                        {c.lab_name}
                        {c.lab_panel ? ` · ${c.lab_panel}` : ""}
                      </Link>
                      <p className="mt-0.5 truncate text-xs text-zinc-500">
                        {c.tracking_number ? `Tracking: ${c.tracking_number} · ` : ""}
                        Created {formatDateTime(c.created_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-700">
                        {COLUMN_LABEL[col]}
                      </span>
                      <StatusPill
                        archived={c.archived_at}
                        deleted={c.deleted_at}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900">
              Email history ({history.emailLogs.length})
            </h2>
            {history.emailLogs.length === 0 ? (
              <p className="text-sm text-zinc-500">No emails sent yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {history.emailLogs.map((log) => (
                  <li
                    key={log.id}
                    className="flex items-start justify-between rounded-md border border-zinc-100 bg-zinc-50/40 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-zinc-900">
                        {log.kind}
                        <span
                          className={`ml-2 rounded px-1 py-0.5 text-[10px] uppercase ${
                            log.status === "sent"
                              ? "bg-emerald-100 text-emerald-800"
                              : log.status === "skipped"
                                ? "bg-zinc-200 text-zinc-700"
                                : log.status === "failed"
                                  ? "bg-red-100 text-red-700"
                                  : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {log.status}
                        </span>
                      </p>
                      <p className="mt-0.5 text-zinc-500">
                        to {log.to_address} · {formatDateTime(log.created_at)}
                      </p>
                      {log.error_message ? (
                        <p className="mt-0.5 text-red-600">
                          {log.error_message}
                        </p>
                      ) : null}
                    </div>
                    <Link
                      href={`/labs/${log.case_id}`}
                      className="shrink-0 text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
                    >
                      view case
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <aside className="rounded-lg border border-zinc-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">
            Activity timeline
          </h2>
          {history.events.length === 0 ? (
            <p className="text-sm text-zinc-500">No activity yet.</p>
          ) : (
            <ol className="space-y-2 text-xs">
              {history.events.map((e) => (
                <li
                  key={e.id}
                  className="border-l-2 border-zinc-200 pl-3"
                >
                  <p className="font-medium text-zinc-900">{e.kind}</p>
                  <p className="text-zinc-500">
                    {formatDateTime(e.created_at)} · {e.actor}
                  </p>
                  {e.step !== null ? (
                    <p className="text-zinc-500">
                      step {e.step}{" "}
                      {e.completed === true
                        ? "✓"
                        : e.completed === false
                          ? "✗"
                          : ""}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </aside>
      </main>
    </div>
  );
}
