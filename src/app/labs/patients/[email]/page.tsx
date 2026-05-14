import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-guard";
import { getPatientHistory } from "../../actions";
import { COLUMN_LABEL, getColumnFor } from "@/lib/columns";
import { HudPulse } from "../../HudPulse";

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

function formatCollectionDate(iso: string | null): string {
  if (!iso) return "No collection date";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Group cases by collection_date so labs drawn on the same day cluster
 * under one header. Order: most-recent date first; cases without a
 * collection date land last so the timeline stays sensible. */
function groupCasesByCollectionDate<T extends { collection_date: string | null }>(
  cases: T[],
): Array<{ date: string | null; rows: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const c of cases) {
    const key = c.collection_date ?? "";
    const arr = buckets.get(key) ?? [];
    arr.push(c);
    buckets.set(key, arr);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => {
      if (!a && !b) return 0;
      if (!a) return 1;
      if (!b) return -1;
      return b.localeCompare(a);
    })
    .map(([date, rows]) => ({ date: date || null, rows }));
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
  const user = await requireUser();
  const { email: rawEmail } = await params;
  const email = decodeURIComponent(rawEmail);
  const history = await getPatientHistory(email);
  if (!history) notFound();

  const primary = history.cases[0];

  return (
    <div className="min-h-dvh bg-zinc-50">
      <HudPulse user={user} />
      <main className="mx-auto max-w-7xl px-6 py-4 pb-16">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <div className="min-w-0">
            <Link
              href="/labs/patients"
              className="text-[11.5px] text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              ← Patients
            </Link>
            <h1 className="mt-0.5 truncate text-base font-semibold leading-tight tracking-tight text-zinc-900">
              {primary.patient_name}
            </h1>
            <p className="truncate text-[11px] text-zinc-500">
              {history.email}
            </p>
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
        <section className="lg:col-span-2 space-y-4">
          <div className="rounded-lg border border-zinc-200 bg-white p-3">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Contact
            </h2>
            <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1 text-[13px]">
              <dt className="text-[11px] uppercase tracking-wide text-zinc-500">
                Email
              </dt>
              <dd className="text-zinc-900">{history.email}</dd>
              <dt className="text-[11px] uppercase tracking-wide text-zinc-500">
                Phone
              </dt>
              <dd className="text-zinc-900">{primary.patient_phone ?? "—"}</dd>
              <dt className="text-[11px] uppercase tracking-wide text-zinc-500">
                DOB
              </dt>
              <dd className="text-zinc-900">{primary.patient_dob ?? "—"}</dd>
              <dt className="text-[11px] uppercase tracking-wide text-zinc-500">
                Address
              </dt>
              <dd className="whitespace-pre-wrap text-zinc-900">
                {primary.patient_address ?? "—"}
              </dd>
            </dl>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-3">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Cases ({history.cases.length})
            </h2>
            <div className="space-y-2.5">
              {groupCasesByCollectionDate(history.cases).map((group) => (
                <div key={group.date ?? "no-date"}>
                  <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500">
                    {formatCollectionDate(group.date)}
                    <span className="ml-2 font-normal normal-case text-zinc-400">
                      {group.rows.length} lab
                      {group.rows.length === 1 ? "" : "s"}
                    </span>
                  </h3>
                  <ul className="space-y-1">
                    {group.rows.map((c) => {
                      const col = getColumnFor(c);
                      return (
                        <li
                          key={c.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-zinc-200 px-2 py-1"
                        >
                          <div className="min-w-0 flex-1">
                            <Link
                              href={`/labs/${c.id}`}
                              className="block truncate text-[12.5px] font-medium text-zinc-900 hover:underline"
                            >
                              {c.lab_name}
                              {c.lab_panel ? ` · ${c.lab_panel}` : ""}
                            </Link>
                            {c.tracking_number ? (
                              <p className="truncate text-[10.5px] text-zinc-500">
                                TRK {c.tracking_number}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-zinc-700">
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
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-3">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
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

        <aside className="rounded-lg border border-zinc-200 bg-white p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
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
        </div>
      </main>
    </div>
  );
}
