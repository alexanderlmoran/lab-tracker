import { requireUser } from "@/lib/auth-guard";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { HudPulse } from "../HudPulse";

export const dynamic = "force-dynamic";

/** Per-user account page — anyone signed in can reach this, regardless of
 * role. Currently just the change-password form; future home for things
 * like profile name, notification preferences, etc. */
export default async function AccountPage() {
  const user = await requireUser();

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50">
      <HudPulse user={user} />
      <main className="mx-auto w-full max-w-screen-md flex-1 space-y-6 px-4 py-6">
        <div>
          <h1 className="text-base font-semibold tracking-tight text-zinc-900">
            My account
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500">
            {user.email} · {user.role}
          </p>
        </div>

        <section>
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-zinc-900">Change password</h2>
            <p className="mt-1 text-xs text-zinc-500">
              You&apos;ll need your current password. After saving, you stay
              signed in on this device — but use the new password next time you
              sign in.
            </p>
          </div>
          <ChangePasswordForm />
        </section>
      </main>
    </div>
  );
}
