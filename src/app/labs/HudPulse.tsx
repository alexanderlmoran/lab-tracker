import Link from "next/link";
import type { LabCase } from "@/lib/types";
import { type AppRole, type SessionUser } from "@/lib/auth-guard";
import {
  COLUMN_LABEL,
  COLUMN_ORDER,
  getCaseStaleness,
  getColumnFor,
  type ColumnKey,
} from "@/lib/columns";
import { CaseDialog } from "./CaseDialog";
import { logoutAction } from "../login/actions";
import "./hud.css";

const COLUMN_COLOR_VAR: Record<ColumnKey, string> = {
  untouched: "var(--c-new)",
  sample_sent: "var(--c-sent)",
  partial_results: "var(--c-partial)",
  complete_results: "var(--c-complete)",
  rof_scheduled: "var(--c-rof-s)",
  rof_done: "var(--c-rof-d)",
  closed: "var(--c-closed)",
};

function initials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]/).filter(Boolean);
  return ((parts[0]?.[0] ?? "u") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export type HudPulseProps = {
  user: SessionUser;
  cases: LabCase[];
  /** Optional override — number of pending inbox items to badge on Inbox nav. */
  inboxBadge?: number;
};

export function HudPulse({ user, cases, inboxBadge }: HudPulseProps) {
  // ── Stats ─────────────────────────────────────────────────────────
  // Bucket every visible case by column. "Active" excludes the terminal
  // "Protocol received" bucket — that's the design's choice and matches
  // the practical "what's still in flight" question staff care about.
  const counts: Record<ColumnKey, number> = {
    untouched: 0,
    sample_sent: 0,
    partial_results: 0,
    complete_results: 0,
    rof_scheduled: 0,
    rof_done: 0,
    closed: 0,
  };
  let staleCount = 0;
  let latestSync: string | null = null;
  for (const c of cases) {
    const col = getColumnFor(c);
    counts[col] += 1;
    if (getCaseStaleness(c).stale) staleCount += 1;
    if (
      c.tracking_polled_at &&
      (!latestSync || c.tracking_polled_at > latestSync)
    ) {
      latestSync = c.tracking_polled_at;
    }
  }
  const totalAcrossAll = cases.length;
  const totalActive = totalAcrossAll - counts.closed;
  const lastSyncLabel = timeAgo(latestSync);

  const canManage: boolean = user.role === "admin" || user.role === "developer";

  const navItems: Array<{ href: string; label: string; badge?: number; show: boolean }> = [
    { href: "/labs/import", label: "Import", show: true },
    { href: "/labs/inbox", label: "Inbox", badge: inboxBadge, show: true },
    { href: "/labs/patients", label: "Patients", show: true },
    { href: "/labs/reports", label: "Reports", show: true },
    { href: "/labs/archived", label: "Archived", show: true },
    { href: "/labs/deleted", label: "Deleted", show: true },
    { href: "/labs/settings", label: "Settings", show: canManage },
  ];

  return (
    <header className="hud hud--pulse">
      <div className="row">
        <div className="brand">
          <div className="brand-mark">L</div>
          <div className="brand-meta">
            <span className="brand-name">Lab Tracker</span>
            <span className="brand-sub">Operations</span>
          </div>
        </div>

        <span className="count-chip" title="Active cases (everything except Protocol received)">
          <span className="n">{totalActive}</span>
          <span className="lbl">active</span>
        </span>

        <nav className="nav" aria-label="Lab tracker sections">
          {navItems
            .filter((n) => n.show)
            .map((n) => (
              <Link key={n.href} href={n.href}>
                {n.label}
                {n.badge && n.badge > 0 ? <span className="badge">{n.badge}</span> : null}
              </Link>
            ))}
        </nav>

        <span className="spacer" />

        <span className="glance">
          {staleCount > 0 ? (
            <span
              className="chip stale"
              title={`${staleCount} ${staleCount === 1 ? "case" : "cases"} idle past the stale threshold`}
            >
              <span className="dot" />
              <span className="num">{staleCount}</span>
              <span>stale</span>
            </span>
          ) : null}
          {lastSyncLabel ? (
            <span className="chip sync" title="Most recent tracking refresh in the visible queue">
              <span className="dot" />
              Synced {lastSyncLabel}
            </span>
          ) : null}
        </span>

        <CaseDialog
          mode="create"
          triggerLabel={
            // The "+" glyph is rendered as a span inside the trigger so it
            // inherits the design's spacing; we pass it as part of the label.
            "+ New case"
          }
          triggerClassName="new-btn"
        />

        <span className="userchip" title={`${user.email} — ${user.role}`}>
          <span className="avatar">{initials(user.email)}</span>
          <span>{user.email}</span>
          <span className="role">{user.role}</span>
        </span>

        <form action={logoutAction}>
          <button type="submit" className="signout">
            Sign out
          </button>
        </form>
      </div>

      <FlowStrip counts={counts} />
    </header>
  );
}

function FlowStrip({ counts }: { counts: Record<ColumnKey, number> }) {
  const distroTotal = COLUMN_ORDER.reduce((s, k) => s + counts[k], 0);
  if (distroTotal === 0) {
    // Empty state — flat zinc strip so the header doesn't collapse visually.
    return <div className="flow" role="img" aria-label="Pipeline empty" />;
  }
  return (
    <div
      className="flow"
      role="img"
      aria-label={`Pipeline distribution: ${COLUMN_ORDER.map(
        (k) => `${counts[k]} ${COLUMN_LABEL[k]}`,
      ).join(", ")}`}
    >
      {COLUMN_ORDER.map((k) => {
        const n = counts[k];
        if (n === 0) return null;
        const widthPct = (n / distroTotal) * 100;
        return (
          <span
            key={k}
            className="seg"
            style={{
              width: `${widthPct}%`,
              background: COLUMN_COLOR_VAR[k],
            }}
            title={`${COLUMN_LABEL[k]}: ${n}`}
          />
        );
      })}
    </div>
  );
}

// Role-tag colour mapping used elsewhere in the app. Exported in case other
// surfaces want to reuse the same badge styling.
export const HUD_ROLE_LABEL: Record<AppRole, string> = {
  developer: "developer",
  admin: "admin",
  staff: "staff",
};
