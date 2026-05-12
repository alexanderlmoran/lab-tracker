"use client";

import { useState, useTransition } from "react";
import type { SessionUser, AppRole } from "@/lib/auth-guard";
import {
  deleteAppUser,
  inviteAppUser,
  regenerateInviteLink,
  setAppUserRole,
  type AppUserRow,
} from "./actions";

export function AccountsPanel({
  users,
  currentUser,
}: {
  users: AppUserRow[];
  currentUser: SessionUser;
}) {
  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 bg-white p-6">
      <InviteForm currentUser={currentUser} />
      <UserTable users={users} currentUser={currentUser} />
    </div>
  );
}

function InviteForm({ currentUser }: { currentUser: SessionUser }) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<AppRole>("staff");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [magicLink, setMagicLink] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMagicLink(null);
    setNote(null);
    startTransition(async () => {
      const res = await inviteAppUser({ email, fullName, role });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setEmail("");
      setFullName("");
      setRole("staff");
      if (res.data?.note) setNote(res.data.note);
      if (res.data?.magicLink) setMagicLink(res.data.magicLink);
    });
  }

  const roleOptions: AppRole[] =
    currentUser.role === "developer"
      ? ["staff", "admin", "developer"]
      : ["staff", "admin"];

  return (
    <form
      onSubmit={onSubmit}
      className="grid grid-cols-1 gap-3 rounded-md border border-dashed border-zinc-300 p-4 md:grid-cols-[1fr_1fr_auto_auto]"
    >
      <input
        type="email"
        required
        placeholder="email@centnerwellness.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400"
      />
      <input
        type="text"
        placeholder="Full name (optional)"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400"
      />
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as AppRole)}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400"
      >
        {roleOptions.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {pending ? "Inviting…" : "Send invite"}
      </button>

      {error ? (
        <p className="col-span-full text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      {note && !magicLink ? (
        <p className="col-span-full text-xs text-emerald-700">{note}</p>
      ) : null}
      {magicLink ? (
        <div className="col-span-full rounded-md bg-amber-50 p-3 text-xs text-amber-900">
          {note ? <p className="font-medium">{note}</p> : null}
          <p className="mt-1 break-all font-mono">{magicLink}</p>
        </div>
      ) : null}
    </form>
  );
}

function UserTable({
  users,
  currentUser,
}: {
  users: AppUserRow[];
  currentUser: SessionUser;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
          <th className="px-2 py-2">Email</th>
          <th className="px-2 py-2">Name</th>
          <th className="px-2 py-2">Role</th>
          <th className="px-2 py-2 text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {users.map((u) => (
          <UserRow key={u.user_id} user={u} currentUser={currentUser} />
        ))}
      </tbody>
    </table>
  );
}

function UserRow({
  user,
  currentUser,
}: {
  user: AppUserRow;
  currentUser: SessionUser;
}) {
  const [error, setError] = useState<string | null>(null);
  const [magicLink, setMagicLink] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isSelf = user.user_id === currentUser.id;
  const roleOptions: AppRole[] =
    currentUser.role === "developer"
      ? ["staff", "admin", "developer"]
      : ["staff", "admin"];

  return (
    <tr className="border-t border-zinc-100">
      <td className="px-2 py-2 text-zinc-900">{user.email}</td>
      <td className="px-2 py-2 text-zinc-600">{user.full_name ?? "—"}</td>
      <td className="px-2 py-2">
        <select
          value={user.role}
          disabled={isSelf || pending}
          onChange={(e) => {
            const role = e.target.value as AppRole;
            setError(null);
            startTransition(async () => {
              const res = await setAppUserRole({ userId: user.user_id, role });
              if (!res.ok) setError(res.error);
            });
          }}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900"
        >
          {/* Include the current value even if it's outside the grant-options
              list (e.g. an admin viewing a developer row). */}
          {[...new Set([user.role, ...roleOptions])].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-2 text-right">
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                setMagicLink(null);
                setNote(null);
                const res = await regenerateInviteLink({ email: user.email });
                if (!res.ok) {
                  setError(res.error);
                  return;
                }
                if (res.data?.note) setNote(res.data.note);
                if (res.data?.magicLink) setMagicLink(res.data.magicLink);
              })
            }
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
          >
            New magic link
          </button>
          {!isSelf ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (!confirm(`Delete ${user.email}? This removes the auth account too.`)) return;
                startTransition(async () => {
                  setError(null);
                  const res = await deleteAppUser({ userId: user.user_id });
                  if (!res.ok) setError(res.error);
                });
              }}
              className="rounded-md border border-red-200 bg-white px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50"
            >
              Delete
            </button>
          ) : null}
        </div>
        {error ? (
          <p className="mt-1 text-[11px] text-red-600">{error}</p>
        ) : null}
        {note && !magicLink ? (
          <p className="mt-1 text-[11px] text-emerald-700">{note}</p>
        ) : null}
        {magicLink ? (
          <div className="mt-1 space-y-1">
            {note ? (
              <p className="text-[11px] text-amber-700">{note}</p>
            ) : null}
            <p className="break-all font-mono text-[11px] text-zinc-700">
              {magicLink}
            </p>
          </div>
        ) : null}
      </td>
    </tr>
  );
}
