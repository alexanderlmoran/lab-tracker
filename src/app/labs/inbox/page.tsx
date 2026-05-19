import Link from "next/link";
import { requireUser } from "@/lib/auth-guard";
import { listLabCases } from "../actions";
import { getGmailConnectionState, listInboundEmails } from "./actions";
import { InboundRowActions } from "./InboundRowActions";
import { GmailPanel } from "./GmailPanel";
import { getPortalUrlForLab } from "@/lib/inbound/detect-notification";
import { LabPortalLauncher } from "../LabPortalLauncher";
import { HudPulse } from "../HudPulse";
import { formatPersonName } from "@/lib/format";

export const dynamic = "force-dynamic";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const CONFIDENCE_STYLES: Record<string, string> = {
  high: "bg-emerald-100 text-emerald-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-zinc-200 text-zinc-700",
  none: "bg-red-100 text-red-700",
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  parsed: "bg-blue-100 text-blue-800",
  failed: "bg-red-100 text-red-700",
  applied: "bg-emerald-100 text-emerald-800",
  dismissed: "bg-zinc-200 text-zinc-700",
  needs_manual_pull: "bg-purple-100 text-purple-800",
};

const STATUS_LABELS: Record<string, string> = {
  needs_manual_pull: "manual pull",
};

export default async function InboxPage() {
  const user = await requireUser();
  const [emails, activeCases, gmailState] = await Promise.all([
    listInboundEmails(),
    listLabCases({ view: "active" }),
    getGmailConnectionState(),
  ]);
  const caseIndex = new Map(activeCases.map((c) => [c.id, c]));
  const slimCases = activeCases.map((c) => ({
    id: c.id,
    patient_name: c.patient_name,
    lab_name: c.lab_name,
  }));

  const pendingCount = emails.filter(
    (e) => e.parser_status === "parsed" || e.parser_status === "pending",
  ).length;

  return (
    <div className="min-h-dvh bg-zinc-50">
      <HudPulse user={user} />
      <main className="mx-auto max-w-7xl space-y-5 px-6 py-4 pb-16">
        <div>
          <h1 className="text-base font-semibold tracking-tight text-zinc-900">
            Lab inbox
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500">
            {pendingCount} pending review · uploads parse automatically with
            Claude.
          </p>
        </div>
        <GmailPanel
          initialConnected={gmailState.connected}
          initialEmail={gmailState.email}
          initialLastSyncedAt={gmailState.lastSyncedAt}
        />
        <LabPortalLauncher />

        {emails.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center text-sm text-zinc-600">
            No reports yet. Gmail polling will surface notification-only lab emails here as they arrive.
          </div>
        ) : (
          <ul className="space-y-3">
            {emails.map((email) => {
              const ext = email.parser_extracted ?? null;
              const matchedCase = email.matched_case_id
                ? caseIndex.get(email.matched_case_id)
                : null;
              const isApplied = email.parser_status === "applied";
              const isDismissed = email.parser_status === "dismissed";
              const isFailed = email.parser_status === "failed";
              const isManualPull = email.parser_status === "needs_manual_pull";
              const portalUrl = isManualPull
                ? getPortalUrlForLab(ext?.lab_name)
                : null;
              const defaultStep: 2 | 4 =
                ext?.result_kind === "partial" ? 2 : 4;

              return (
                <li
                  key={email.id}
                  className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                            STATUS_STYLES[email.parser_status] ??
                            "bg-zinc-100 text-zinc-700"
                          }`}
                        >
                          {STATUS_LABELS[email.parser_status] ??
                            email.parser_status}
                        </span>
                        {email.matched_confidence ? (
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                              CONFIDENCE_STYLES[email.matched_confidence] ??
                              "bg-zinc-100"
                            }`}
                          >
                            {email.matched_confidence === "none"
                              ? "no match"
                              : `${email.matched_confidence} match`}
                          </span>
                        ) : null}
                        <span className="text-xs text-zinc-500">
                          {formatDateTime(email.received_at)}
                        </span>
                      </div>
                      <h3 className="mt-1 truncate text-sm font-medium text-zinc-900">
                        {email.subject ?? "(no subject)"}
                      </h3>
                      {email.from_address ? (
                        <p className="text-xs text-zinc-500">
                          From: {email.from_address}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {isFailed && email.parser_error ? (
                    <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
                      Parser error: {email.parser_error}
                    </p>
                  ) : null}

                  {isManualPull ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-purple-50 px-3 py-2 text-xs text-purple-800">
                      <span>
                        Notification email — no PDF attached. Pull this result
                        from the lab portal manually.
                      </span>
                      {portalUrl ? (
                        <a
                          href={portalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-auto rounded-md border border-purple-300 bg-white px-2.5 py-1 text-[11px] font-medium text-purple-800 hover:bg-purple-100"
                        >
                          Open {ext?.lab_name ?? "lab"} portal →
                        </a>
                      ) : null}
                    </div>
                  ) : null}

                  {ext ? (
                    <dl className="mt-3 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
                      {ext.lab_name ? (
                        <>
                          <dt className="text-zinc-500">Lab</dt>
                          <dd className="text-zinc-900">{ext.lab_name}</dd>
                        </>
                      ) : null}
                      {ext.patient_name ? (
                        <>
                          <dt className="text-zinc-500">Patient</dt>
                          <dd className="text-zinc-900">{formatPersonName(ext.patient_name)}</dd>
                        </>
                      ) : null}
                      {ext.test_panel ? (
                        <>
                          <dt className="text-zinc-500">Panel</dt>
                          <dd className="text-zinc-900">{ext.test_panel}</dd>
                        </>
                      ) : null}
                      {ext.result_kind ? (
                        <>
                          <dt className="text-zinc-500">Result</dt>
                          <dd className="text-zinc-900">{ext.result_kind}</dd>
                        </>
                      ) : null}
                      {ext.collected_date ? (
                        <>
                          <dt className="text-zinc-500">Collected</dt>
                          <dd className="text-zinc-900">{ext.collected_date}</dd>
                        </>
                      ) : null}
                      {ext.summary ? (
                        <>
                          <dt className="text-zinc-500">Summary</dt>
                          <dd className="text-zinc-900">{ext.summary}</dd>
                        </>
                      ) : null}
                    </dl>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 pt-3">
                    <div className="text-xs">
                      {matchedCase ? (
                        <span className="text-zinc-700">
                          Matched →{" "}
                          <Link
                            href={`/labs/${matchedCase.id}`}
                            className="font-medium text-zinc-900 hover:underline"
                          >
                            {formatPersonName(matchedCase.patient_name)} · {matchedCase.lab_name}
                          </Link>
                        </span>
                      ) : (
                        <span className="text-zinc-500">No matched case.</span>
                      )}
                    </div>
                    {!isApplied && !isDismissed && !isManualPull ? (
                      <InboundRowActions
                        inboundId={email.id}
                        matchedCaseId={email.matched_case_id}
                        defaultStep={defaultStep}
                        activeCases={slimCases}
                        alreadyApplied={false}
                      />
                    ) : isManualPull ? (
                      <InboundRowActions
                        inboundId={email.id}
                        matchedCaseId={email.matched_case_id}
                        defaultStep={defaultStep}
                        activeCases={slimCases}
                        alreadyApplied={false}
                        dismissOnly
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
