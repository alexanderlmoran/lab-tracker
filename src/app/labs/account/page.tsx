import Link from "next/link";
import { requireUser } from "@/lib/auth-guard";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { logoutAction } from "../../login/actions";

export const dynamic = "force-dynamic";

/** Per-user account page — anyone signed in can reach this, regardless of
 * role. Currently just the change-password form; future home for things
 * like profile name, notification preferences, etc. */
export default async function AccountPage() {
  const user = await requireUser();

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-screen-md items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              My account
            </h1>
            <p className="text-xs text-zinc-500">
              {user.email} · {user.role}
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

      <main className="mx-auto w-full max-w-screen-md flex-1 space-y-8 px-4 py-8">
        <section>
          <div className="mb-4">
            <h2 className="text-base font-semibold text-zinc-900">Change password</h2>
            <p className="mt-1 text-xs text-zinc-500">
              You'll need your current password. After saving, you stay signed
              in on this device — but use the new password next time you sign
              in.
            </p>
          </div>
          <ChangePasswordForm />
        </section>
      </main>
    </div>
  );
}
