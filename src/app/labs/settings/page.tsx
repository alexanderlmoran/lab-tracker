import Link from "next/link";
import { requireRole } from "@/lib/auth-guard";
import {
  getAppSettings,
  listAppUsers,
  listEmailTemplates,
  listLabsCatalog,
} from "./actions";
import { GeneralSettingsForm } from "./GeneralSettingsForm";
import { AccountsPanel } from "./AccountsPanel";
import { LabsCatalogPanel } from "./LabsCatalogPanel";
import { EmailTemplatesPanel } from "./EmailTemplatesPanel";
import { logoutAction } from "../../login/actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireRole("admin");
  const [settings, users, labs, emailTemplates] = await Promise.all([
    getAppSettings(),
    listAppUsers(),
    listLabsCatalog(),
    listEmailTemplates(),
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

      <main className="mx-auto w-full max-w-screen-xl flex-1 space-y-10 px-4 py-8">
        <section>
          <SectionHeader
            title="General"
            description="Email reply-to / sending-from. Used by all outbound patient and staff emails. Empty values fall back to environment variables."
          />
          <GeneralSettingsForm initial={settings} />
        </section>

        <section>
          <SectionHeader
            title="Accounts"
            description="Invite staff and assign roles. Invitees get a magic-link email; clicking it lets them set their own password."
          />
          <AccountsPanel users={users} currentUser={user} />
        </section>

        <section>
          <SectionHeader
            title="Email templates"
            description="The four patient-facing emails. Edit subject, body, and BCC list per kind; send a test to yourself before going live. Internal staff emails (Nadia confirmation, Allison ROF proofread) stay code-managed."
          />
          <EmailTemplatesPanel templates={emailTemplates} currentUser={user} />
        </section>

        <section>
          <SectionHeader
            title="Lab catalog"
            description="Edit turnaround times, retire panels, add new labs. Aliases and CSV import normalization stay in src/lib/labs/catalog.ts."
          />
          <LabsCatalogPanel labs={labs} />
        </section>
      </main>
    </div>
  );
}

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
      <p className="mt-1 text-xs text-zinc-500">{description}</p>
    </div>
  );
}
