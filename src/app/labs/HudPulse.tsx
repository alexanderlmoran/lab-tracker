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
import { UserChip } from "./UserChip";
import { ThemeToggle } from "./ThemeToggle";
import { logoutAction } from "../login/actions";
import { countUnreadInbox } from "@/lib/inbound/unread-count";
import "./hud.css";

const COLUMN_COLOR_VAR: Record<ColumnKey, string> = {
  untouched: "var(--c-new)",
  ready_to_ship: "var(--c-ready)",
  with_patient: "var(--c-withpatient)",
  sample_sent: "var(--c-sent)",
  complete_results: "var(--c-complete)",
  pending_upload: "var(--c-complete)",
  rof_scheduled: "var(--c-rof-s)",
  rof_done: "var(--c-rof-d)",
  closed: "var(--c-closed)",
  // Archived cases are filtered out before the flow strip, so the actual
  // colour is never used — but the key is required by the typed record.
  completed: "var(--c-closed)",
};

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
  /** Active cases for the pipeline stats + flow strip. Omit on secondary
   * tabs (Import, Reports, Settings, Inbox, etc.) — the HUD still renders
   * the brand, nav, user chip, and New-case button; the count chip and
   * coloured flow strip are suppressed when no cases are passed. */
  cases?: LabCase[];
};

export async function HudPulse({ user, cases }: HudPulseProps) {
  const hasCases = Array.isArray(cases);
  // Unread/actionable inbound lab emails — surfaced as a badge on the Inbox
  // nav item so a new email (Allison/patient labs, Kennedy, notification-only
  // portals) is visible from every page, not just /labs/inbox (backlog #15).
  const unreadInbox = await countUnreadInbox();
  const safeCases = cases ?? [];
  // ── Stats ─────────────────────────────────────────────────────────
  // Bucket every visible case by column. "Active" excludes the terminal
  // "Protocol received" bucket — that's the design's choice and matches
  // the practical "what's still in flight" question staff care about.
  const counts: Record<ColumnKey, number> = {
    untouched: 0,
    ready_to_ship: 0,
    with_patient: 0,
    sample_sent: 0,
    complete_results: 0,
    pending_upload: 0,
    rof_scheduled: 0,
    rof_done: 0,
    closed: 0,
    completed: 0,
  };
  let staleCount = 0;
  let latestSync: string | null = null;
  for (const c of safeCases) {
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
  const totalAcrossAll = safeCases.length;
  const totalActive = totalAcrossAll - counts.closed;
  const lastSyncLabel = timeAgo(latestSync);

  const canManage: boolean = user.role === "admin" || user.role === "developer";
  const isDeveloper: boolean = user.role === "developer";

  // Inbox is back in the primary nav (Gmail ingest for lab-result emails —
  // Kennedy Krieger especially, which is email-only). Archived / Deleted /
  // lab-portal links still live in Settings tabs.
  const navItems: Array<{ href: string; label: string; badge?: number; show: boolean }> = [
    { href: "/labs", label: "Home", show: true },
    { href: "/labs/inbox", label: "Inbox", badge: unreadInbox, show: true },
    { href: "/labs/import", label: "Import", show: true },
    { href: "/labs/patients", label: "Patients", show: true },
    { href: "/labs/iv", label: "IV Charting", show: true },
    { href: "/labs/records", label: "Records", show: true },
    { href: "/labs/analytics", label: "Analytics", show: canManage },
    { href: "/labs/sales", label: "Sales", show: isDeveloper },
    { href: "/labs/settings", label: "Settings", show: canManage },
  ];

  // Username chip is its own client component so it can grey itself out
  // when the user is already on its destination (/labs/settings?tab=general).

  return (
    <header className="hud hud--pulse">
      <div className="row">
        <div className="brand">
          <div className="brand-mark">L</div>
          <div className="brand-meta">
            <span className="brand-name">Lab Tracker</span>
          </div>
        </div>

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

        <div className="hud-right">
          {hasCases ? (
            <span
              className="count-chip"
              title="Active cases (everything except Protocol received)"
            >
              <span className="n">{totalActive}</span>
              <span className="lbl">active</span>
            </span>
          ) : null}
          {hasCases ? (
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
                <span
                  className="chip sync"
                  title="Most recent FedEx tracking refresh in the visible queue. Full pipeline health (Zenoti/scrape/post) lives on the Analytics → Health tab; the watchdog emails if any loop goes quiet."
                >
                  <span className="dot" />
                  Tracking {lastSyncLabel}
                </span>
              ) : null}
            </span>
          ) : null}
          <UserChip email={user.email} role={user.role} />
          <ThemeToggle />
          <form action={logoutAction}>
            <button type="submit" className="signout">
              Sign out
            </button>
          </form>
        </div>
      </div>

      {hasCases ? <FlowStrip counts={counts} /> : null}
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
