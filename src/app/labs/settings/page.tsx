import { hasRole, requireUser } from "@/lib/auth-guard";
import { HudPulse } from "../HudPulse";
import {
  getAppSettings,
  listAppUsers,
  listCustomTemplateSuggestions,
  listEmailTemplates,
  listKnownEmailAddresses,
  listLabPortals,
  listLabsCatalog,
  listScraperStatus,
  getPatientSeedOverview,
  getLabTurnaroundStats,
} from "./actions";
import { PatientSeedPanel } from "./PatientSeedPanel";
import { TurnaroundPanel } from "./TurnaroundPanel";
import { listLabCases } from "../actions";
import { GeneralSettingsForm } from "./GeneralSettingsForm";
import { ChangePasswordForm } from "../account/ChangePasswordForm";
import { AccountsPanel } from "./AccountsPanel";
import { LabsCatalogPanel } from "./LabsCatalogPanel";
import { EmailTemplatesPanel } from "./EmailTemplatesPanel";
import { LabPortalsPanel } from "./LabPortalsPanel";
import { ScrapersPanel } from "./ScrapersPanel";
import { RecipeEnginePanel } from "./RecipeEnginePanel";
import { SettingsTabs } from "./SettingsTabs";
import { parseSettingsTab } from "./tab";
import { BulkRecoveryTable } from "../BulkRecoveryTable";

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
  const user = await requireUser();
  const isAdmin = hasRole(user, "admin");
  const sp = await searchParams;
  const requestedTab = parseSettingsTab(firstString(sp.tab));
  // Staff can only see the General tab (which contains their password
  // change). Any deep-link to an admin-only tab silently lands them on
  // General — rather than throwing or 403'ing, which would feel broken.
  const tab = isAdmin ? requestedTab : "general";

  // Fetch only what the active tab needs. Every admin-only fetch is also
  // role-gated so a future bug doesn't accidentally execute it for staff.
  const wantsGeneral = tab === "general";
  const wantsAccounts = isAdmin && tab === "accounts";
  const wantsEmails = isAdmin && tab === "emails";
  const wantsLabs = isAdmin && tab === "labs";
  const wantsArchived = isAdmin && tab === "archived";
  const wantsDeleted = isAdmin && tab === "deleted";
  const wantsPortals = isAdmin && tab === "portals";
  const wantsScrapers = isAdmin && tab === "scrapers";
  const wantsPatients = isAdmin && tab === "patients";
  const wantsTurnarounds = isAdmin && tab === "turnarounds";

  const [
    settings,
    users,
    labs,
    emailTemplates,
    emailSuggestions,
    knownEmails,
    archivedCases,
    deletedCases,
    portals,
    scrapers,
    patientSeed,
    turnarounds,
  ] = await Promise.all([
    // Org settings live on the General tab but only render for admins —
    // staff still hits General for the password section, no app_settings
    // read needed for them.
    wantsGeneral && isAdmin ? getAppSettings() : Promise.resolve(null),
    wantsAccounts ? listAppUsers() : Promise.resolve(null),
    wantsLabs ? listLabsCatalog() : Promise.resolve(null),
    wantsEmails ? listEmailTemplates() : Promise.resolve(null),
    wantsEmails ? listCustomTemplateSuggestions() : Promise.resolve(null),
    wantsEmails ? listKnownEmailAddresses() : Promise.resolve(null),
    wantsArchived
      ? listLabCases({ view: "archived" })
      : Promise.resolve(null),
    wantsDeleted ? listLabCases({ view: "deleted" }) : Promise.resolve(null),
    wantsPortals ? listLabPortals() : Promise.resolve(null),
    wantsScrapers ? listScraperStatus() : Promise.resolve(null),
    wantsPatients ? getPatientSeedOverview() : Promise.resolve(null),
    wantsTurnarounds ? getLabTurnaroundStats() : Promise.resolve(null),
  ]);

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50">
      <HudPulse user={user} />
      <main className="mx-auto w-full max-w-screen-xl flex-1 space-y-5 px-4 py-4">
        <div>
          <h1 className="text-base font-semibold tracking-tight text-zinc-900">
            Settings
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500">
            Signed in as {user.email} ({user.role})
          </p>
        </div>
        <SettingsTabs tab={tab} isAdmin={isAdmin} />

        {wantsGeneral ? (
          <>
            {isAdmin && settings ? (
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
            <Section
              title="Change password"
              description="Updates the password for your account. You stay signed in on this device."
            >
              <ChangePasswordForm />
            </Section>
          </>
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
              suggestions={emailSuggestions ?? []}
              knownEmails={knownEmails ?? []}
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

        {wantsPortals && portals ? (
          <Section
            title="Lab portals"
            description="Edit per-lab sign-in URLs. The lab key must match the lab_name used on cases — these power the portal buttons on the case detail card."
          >
            <LabPortalsPanel portals={portals} />
          </Section>
        ) : null}

        {wantsScrapers && scrapers ? (
          <>
            <Section
              title="Recipe engine"
              description="Config-driven scrapers: which portals run as data-driven recipes vs hand-written, and the strategy stack each uses."
            >
              <RecipeEnginePanel />
            </Section>
            <Section
              title="Scrapers"
              description="Status of each lab portal scraper. Use the per-row commands to capture a new portal or recalibrate one whose session expired."
            >
              <ScrapersPanel rows={scrapers} />
            </Section>
          </>
        ) : null}

        {wantsPatients && patientSeed ? (
          <Section
            title="Patient seed"
            description="Pre-load patients who exist in PracticeBetter / Zenoti but haven't had a lab case yet. CSV import will auto-fill email/phone/DOB from this list on their first case."
          >
            <PatientSeedPanel
              initialSample={patientSeed.sample}
              total={patientSeed.total}
            />
          </Section>
        ) : null}

        {wantsTurnarounds && turnarounds ? (
          <Section
            title="Turnarounds"
            description="Observed days from collection_date to step 4 (Complete results received), per lab + panel. Drift highlights labs where the catalog's stored turnaround under-estimates reality."
          >
            {turnarounds.ok ? (
              <TurnaroundPanel rows={turnarounds.data ?? []} />
            ) : (
              <p className="text-xs text-rose-700">
                Couldn&apos;t load stats: {turnarounds.error}
              </p>
            )}
          </Section>
        ) : null}

        {wantsArchived && archivedCases ? (
          <Section
            title="Archived cases"
            description="Select multiple to unarchive in bulk, or use the row action."
          >
            <BulkRecoveryTable rows={archivedCases} mode="archived" />
          </Section>
        ) : null}

        {wantsDeleted && deletedCases ? (
          <Section
            title="Deleted cases"
            description="Select multiple to restore in bulk, or use the row action."
          >
            <BulkRecoveryTable rows={deletedCases} mode="deleted" />
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
