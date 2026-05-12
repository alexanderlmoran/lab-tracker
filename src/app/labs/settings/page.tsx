import Link from "next/link";
import { requireRole } from "@/lib/auth-guard";
import {
  getAppSettings,
  listAppUsers,
  listEmailTemplates,
  listLabsCatalog,
} from "./actions";
import { listLabCases } from "../actions";
import { GeneralSettingsForm } from "./GeneralSettingsForm";
import { AccountsPanel } from "./AccountsPanel";
import { LabsCatalogPanel } from "./LabsCatalogPanel";
import { EmailTemplatesPanel } from "./EmailTemplatesPanel";
import { LabPortalLauncher } from "../LabPortalLauncher";
import { SettingsTabs } from "./SettingsTabs";
import { parseSettingsTab } from "./tab";
import { CaseTable } from "../CaseTable";
import { logoutAction } from "../../login/actions";

export const dynamic = "force-dynamic";

function firstString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireRole("admin");
  const sp = await searchParams;
  const tab = parseSettingsTab(firstString(sp.tab));

  // Fetch only what the active tab needs.
  const wantsGeneral = tab === "general";
  const wantsAccounts = tab === "accounts";
  const wantsEmails = tab === "emails";
  const wantsLabs = tab === "labs";
  const wantsArchived = tab === "archived";
  const wantsDeleted = tab === "deleted";

  const [
    settings,
    users,
    labs,
    emailTemplates,
    archivedCases,
    deletedCases,
  ] = await Promise.all([
    wantsGeneral ? getAppSettings() : Promise.resolve(null),
    wantsAccounts ? listAppUsers() : Promise.resolve(null),
    wantsLabs ? listLabsCatalog() : Promise.resolve(null),
    wantsEmails ? listEmailTemplates() : Promise.resolve(null),
    wantsArchived
      ? listLabCases({ view: "archived" })
      : Promise.resolve(null),
    wantsDeleted ? listLabCases({ view: "deleted" }) : Promise.resolve(null),
  ]);

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-screen-xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              Settings
            </h1>
            <p className="text-xs text-zinc-500">
              Signed in as {user.email} ({user.role})
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link
              href="/labs"
              className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              ← Back to labs
            </Link>
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

      <main className="mx-auto w-full max-w-screen-xl flex-1 space-y-6 px-4 py-8">
        <SettingsTabs tab={tab} />

        {wantsGeneral && settings ? (
          <Section
            title="General"
            description="Email reply-to / sending-from. Blanks fall back to environment variables."
          >
            <GeneralSettingsForm
              initial={settings}
              testRedirectActive={
                (process.env.EMAIL_TEST_REDIRECT ?? "").trim() || null
              }
            />
          </Section>
        ) : null}

        {wantsAccounts && users ? (
          <Section
            title="Accounts"
            description="Invite staff and assign roles. Invitees get a magic-link email; clicking it lets them set their own password."
          >
            <AccountsPanel users={users} currentUser={user} />
          </Section>
        ) : null}

        {wantsEmails && emailTemplates ? (
          <Section
            title="Email templates"
            description="The four patient-facing emails. Edit subject, body, and BCC list per kind; send a test to yourself before going live."
          >
            <EmailTemplatesPanel
              templates={emailTemplates}
              currentUser={user}
            />
          </Section>
        ) : null}

        {wantsLabs && labs ? (
          <Section
            title="Lab catalog"
            description="Edit turnaround days, mark a lab as expecting partial results, retire panels, or add new labs."
          >
            <LabsCatalogPanel labs={labs} />
          </Section>
        ) : null}

        {tab === "portals" ? (
          <Section
            title="Lab portals"
            description="Quick-launch the sign-in page for each lab. Updates here propagate to the per-row buttons on inbox emails."
          >
            <LabPortalLauncher />
          </Section>
        ) : null}

        {wantsArchived && archivedCases ? (
          <Section
            title="Archived cases"
            description="Read-only history. Restore from a case's detail view."
          >
            <p className="mb-3 text-xs text-zinc-500">
              {archivedCases.length}{" "}
              {archivedCases.length === 1 ? "case" : "cases"}
            </p>
            <CaseTable rows={archivedCases} />
          </Section>
        ) : null}

        {wantsDeleted && deletedCases ? (
          <Section
            title="Deleted cases"
            description="Soft-deleted rows. Restore from a case's detail view if recovered in error."
          >
            <p className="mb-3 text-xs text-zinc-500">
              {deletedCases.length}{" "}
              {deletedCases.length === 1 ? "case" : "cases"}
            </p>
            <CaseTable rows={deletedCases} />
          </Section>
        ) : null}
      </main>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-4">
        <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
        <p className="mt-1 text-xs text-zinc-500">{description}</p>
      </div>
      {children}
    </section>
  );
}
