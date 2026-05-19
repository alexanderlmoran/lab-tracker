"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { AppRole } from "@/lib/auth-guard";

function initials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]/).filter(Boolean);
  return ((parts[0]?.[0] ?? "u") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * User chip rendered in the HUD header. Links to Settings → General where
 * the change-password form lives. When the user is already on that exact
 * tab the chip renders as a non-interactive span so it doesn't pretend to
 * be a useful destination.
 */
export function UserChip({
  email,
  role,
}: {
  email: string;
  role: AppRole;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab");
  // On /labs/settings?tab=general (or the default General tab where the
  // query param is absent), the chip is the destination — render disabled.
  const isOnDestination =
    pathname === "/labs/settings" && (tab === "general" || tab == null);

  const body = (
    <>
      <span className="avatar">{initials(email)}</span>
      <span>{email}</span>
      <span className="role">{role}</span>
    </>
  );

  if (isOnDestination) {
    return (
      <span
        className="userchip"
        aria-disabled="true"
        title={`${email} — ${role} · you are here`}
        style={{ opacity: 0.55, pointerEvents: "none" }}
      >
        {body}
      </span>
    );
  }

  return (
    <Link
      href="/labs/settings?tab=general"
      className="userchip"
      title={`${email} — ${role} · click to change password`}
    >
      {body}
    </Link>
  );
}
