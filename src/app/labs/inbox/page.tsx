import { requireUser } from "@/lib/auth-guard";
import { listLabCases } from "../actions";
import { getGmailConnectionState, listInboundEmails } from "./actions";
import { GmailPanel } from "./GmailPanel";
import { InboxList } from "./InboxList";
import { HudPulse } from "../HudPulse";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const user = await requireUser();
  const [emails, activeCases, gmailState] = await Promise.all([
    listInboundEmails(),
    listLabCases({ view: "active" }),
    getGmailConnectionState(),
  ]);
  const slimCases = activeCases.map((c) => ({
    id: c.id,
    patient_name: c.patient_name,
    lab_name: c.lab_name,
  }));

  const toReview = emails.filter(
    (e) => e.parser_status === "parsed" || e.parser_status === "pending",
  ).length;

  return (
    <div className="min-h-dvh bg-zinc-50">
      <HudPulse user={user} />
      <main className="mx-auto max-w-7xl space-y-4 px-6 py-4 pb-16">
        <div>
          <h1 className="text-base font-semibold tracking-tight text-zinc-900">
            Lab inbox
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500">
            {toReview} to review · click a row to open it · hover any badge for
            what it means.
          </p>
        </div>
        <GmailPanel
          initialConnected={gmailState.connected}
          initialEmail={gmailState.email}
          initialLastSyncedAt={gmailState.lastSyncedAt}
        />
        <InboxList emails={emails} activeCases={slimCases} />
      </main>
    </div>
  );
}
