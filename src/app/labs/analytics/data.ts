// Analytics data layer — Team activity + System health.
//
// Plain server module (NOT "use server"): these fetchers are called only from
// the Analytics server components, so they don't need to be server actions —
// and a plain module can export the shared types freely without tripping the
// "use server" export trap (a "use server" file may only export async fns).
//
// Read-only aggregation following the getReportData() pattern in actions.ts:
// pull the rows we need, aggregate in JS (no GROUP BY at the Supabase edge).

import { requireRole } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import { resolveSell, resolveCost } from "@/lib/labs/pricing";

export type AnalyticsTab = "reports" | "revenue" | "integrity" | "team" | "health" | "engine";

// ── Revenue ────────────────────────────────────────────────────────────────
export type RevenueData = {
  totalRevenue: number;
  totalCost: number;
  totalCount: number;
  pricedCount: number;
  unpricedCount: number;
  byLab: Array<{ lab: string; count: number; revenue: number }>;
  byMonth: Array<{ month: string; revenue: number; count: number }>;
  topUnpriced: Array<{ key: string; count: number }>;
};

/** Revenue / volume / rough-margin across all non-deleted cases, priced via
 *  src/lib/labs/pricing.ts (Zenoti sell prices). Includes archived cases — they
 *  are realized orders. Costs are approximate, so margin is an estimate. */
export async function getRevenueData(): Promise<RevenueData> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("lab_cases")
    .select("lab_name, lab_panel, zenoti_service_name, collection_date, created_at")
    .is("deleted_at", null);
  const rows = (data ?? []) as Array<{
    lab_name: string | null;
    lab_panel: string | null;
    zenoti_service_name: string | null;
    collection_date: string | null;
    created_at: string | null;
  }>;

  let totalRevenue = 0;
  let totalCost = 0;
  let pricedCount = 0;
  let unpricedCount = 0;
  const byLab = new Map<string, { count: number; revenue: number }>();
  const byMonth = new Map<string, { revenue: number; count: number }>();
  const unpriced = new Map<string, number>();
  const canonical = (n: string) => (n.toLowerCase() === "kennedykrieger" ? "Kennedy Krieger" : n);

  for (const c of rows) {
    const s = resolveSell(c);
    totalRevenue += s.amount;
    totalCost += resolveCost(c);
    if (s.basis === "unknown") {
      unpricedCount++;
      const k = `${c.lab_name ?? "?"}${c.lab_panel ? ` · ${c.lab_panel}` : ""}`;
      unpriced.set(k, (unpriced.get(k) ?? 0) + 1);
    } else {
      pricedCount++;
    }
    const lab = canonical(c.lab_name ?? "(unknown)");
    const L = byLab.get(lab) ?? { count: 0, revenue: 0 };
    L.count++;
    L.revenue += s.amount;
    byLab.set(lab, L);
    const month = (c.collection_date ?? c.created_at ?? "").slice(0, 7); // YYYY-MM
    if (/^\d{4}-\d{2}$/.test(month)) {
      const M = byMonth.get(month) ?? { revenue: 0, count: 0 };
      M.revenue += s.amount;
      M.count++;
      byMonth.set(month, M);
    }
  }

  return {
    totalRevenue,
    totalCost,
    totalCount: rows.length,
    pricedCount,
    unpricedCount,
    byLab: [...byLab.entries()].map(([lab, v]) => ({ lab, ...v })).sort((a, b) => b.revenue - a.revenue),
    byMonth: [...byMonth.entries()].map(([month, v]) => ({ month, ...v })).sort((a, b) => a.month.localeCompare(b.month)).slice(-12),
    topUnpriced: [...unpriced.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, 8),
  };
}

// ── Team activity ────────────────────────────────────────────────────

export type ActorKind = "human" | "automated";

export type ActorActivity = {
  /** Display name: 'staff:nadia' → "Nadia", 'admin' → "Admin", an email shown
   *  as-is, anything 'worker:*'/'system' collapsed to "Automated". */
  actor: string;
  kind: ActorKind;
  approvals: number; // audit: approve
  corrections: number; // audit: disapprove_* / retry_upload / manual_override / accession_edited
  stepsAdvanced: number; // events: step_toggled
  emails: number; // events: email_sent
  casesTouched: number; // events: case_created / case_edited / etc.
  total: number; // every audit + event row attributed to this actor
};

export type TeamActivity = {
  windowDays: number;
  since: string; // ISO
  totalActions: number;
  humanActions: number;
  automatedActions: number;
  actors: ActorActivity[]; // sorted by total desc
  perDay: Array<{ day: string; human: number; automated: number }>;
};

const CORRECTION_ACTIONS = new Set([
  "disapprove_wrong_pdf",
  "disapprove_upload_failed",
  "retry_upload",
  "manual_override",
  "accession_edited",
]);

function titleCase(s: string): string {
  return s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Normalize the heterogeneous actor strings (audit.actor_label is
 *  'staff:nadia'/'admin'/'worker:access'/'system'; events.actor is usually a
 *  user email or 'admin'/'system') into a stable display identity + kind.
 *  Identity is best-effort — these columns are text, not FKs to auth.users
 *  (see project-lab-tracker-pb... memory). Good enough for a small team. */
export function normalizeActor(raw: string | null | undefined): {
  name: string;
  kind: ActorKind;
} {
  const a = (raw ?? "").trim();
  if (!a || a === "system" || a.startsWith("worker:") || a.startsWith("cron")) {
    return { name: "Automated", kind: "automated" };
  }
  if (a.startsWith("staff:")) return { name: titleCase(a.slice(6)), kind: "human" };
  if (a === "admin") return { name: "Admin", kind: "human" };
  if (a.includes("@")) return { name: a, kind: "human" }; // email — recognizable as-is
  return { name: titleCase(a), kind: "human" };
}

export async function getTeamActivity(windowDays = 7): Promise<TeamActivity> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  const days = Math.max(1, Math.min(90, Math.floor(windowDays)));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const [auditRes, eventRes] = await Promise.all([
    db
      .from("lab_case_audit")
      .select("action, actor_label, occurred_at")
      .gte("occurred_at", since),
    db
      .from("lab_events")
      .select("kind, actor, created_at")
      .gte("created_at", since),
  ]);
  if (auditRes.error) throw new Error(auditRes.error.message);
  if (eventRes.error) throw new Error(eventRes.error.message);

  const audit = (auditRes.data ?? []) as Array<{
    action: string;
    actor_label: string | null;
    occurred_at: string;
  }>;
  const events = (eventRes.data ?? []) as Array<{
    kind: string;
    actor: string | null;
    created_at: string;
  }>;

  const byActor = new Map<string, ActorActivity>();
  const ensure = (name: string, kind: ActorKind): ActorActivity => {
    let row = byActor.get(name);
    if (!row) {
      row = {
        actor: name,
        kind,
        approvals: 0,
        corrections: 0,
        stepsAdvanced: 0,
        emails: 0,
        casesTouched: 0,
        total: 0,
      };
      byActor.set(name, row);
    }
    return row;
  };

  // Per-day buckets (oldest → newest) split human vs automated.
  const dayMap = new Map<string, { human: number; automated: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    dayMap.set(key, { human: 0, automated: 0 });
  }
  const bumpDay = (iso: string, kind: ActorKind) => {
    const bucket = dayMap.get(iso.slice(0, 10));
    if (bucket) bucket[kind] += 1;
  };

  for (const a of audit) {
    const { name, kind } = normalizeActor(a.actor_label);
    const row = ensure(name, kind);
    if (a.action === "approve") row.approvals += 1;
    else if (CORRECTION_ACTIONS.has(a.action)) row.corrections += 1;
    row.total += 1;
    bumpDay(a.occurred_at, kind);
  }
  for (const e of events) {
    const { name, kind } = normalizeActor(e.actor);
    const row = ensure(name, kind);
    if (e.kind === "step_toggled") row.stepsAdvanced += 1;
    else if (e.kind === "email_sent") row.emails += 1;
    else if (e.kind.startsWith("case_") || e.kind === "expected_dates_set")
      row.casesTouched += 1;
    row.total += 1;
    bumpDay(e.created_at, kind);
  }

  const actors = [...byActor.values()].sort((a, b) => b.total - a.total);
  const humanActions = actors
    .filter((a) => a.kind === "human")
    .reduce((s, a) => s + a.total, 0);
  const automatedActions = actors
    .filter((a) => a.kind === "automated")
    .reduce((s, a) => s + a.total, 0);

  return {
    windowDays: days,
    since,
    totalActions: humanActions + automatedActions,
    humanActions,
    automatedActions,
    actors,
    perDay: [...dayMap.entries()].map(([day, v]) => ({ day, ...v })),
  };
}

// ── System health ────────────────────────────────────────────────────

export type HealthStatus = "green" | "yellow" | "red" | "idle";

export type HealthItem = {
  label: string;
  status: HealthStatus;
  note?: string;
};

export type HealthCategory = {
  key: string;
  label: string;
  status: HealthStatus;
  headline: string;
  detail?: string;
  items?: HealthItem[];
};

export type SystemHealth = {
  generatedAt: string;
  categories: HealthCategory[];
};

/** Human-friendly "3h ago" / "2d ago"; null when no timestamp. */
export function formatAge(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function ageHours(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  const ms = Date.now() - new Date(iso).getTime();
  return ms <= 0 ? 0 : ms / 3600000;
}

/** Worst status across items — red beats yellow beats green; idle only if
 *  there's nothing at all to report. */
function rollup(items: HealthItem[]): HealthStatus {
  if (items.length === 0) return "idle";
  if (items.some((i) => i.status === "red")) return "red";
  if (items.some((i) => i.status === "yellow")) return "yellow";
  if (items.some((i) => i.status === "green")) return "green";
  return "idle";
}

export async function getSystemHealth(): Promise<SystemHealth> {
  await requireRole("admin");
  const db = getSupabaseAdmin();

  const [scrapers, jobs, emails, inbound, cases, lastWorker] = await Promise.all([
    db
      .from("lab_scraper_status")
      .select(
        "portal_key, last_check_at, last_success_at, last_error, consecutive_failures",
      ),
    db.from("pb_upload_jobs").select("status, last_error, finished_at"),
    db
      .from("email_logs")
      .select("status, created_at")
      .gte("created_at", new Date(Date.now() - 14 * 86400000).toISOString()),
    db
      .from("inbound_emails")
      .select("parser_status, from_address, subject, received_at")
      .gte("received_at", new Date(Date.now() - 30 * 86400000).toISOString()),
    db
      .from("lab_cases")
      .select("tracking_number, tracking_delivered_at, tracking_polled_at")
      .is("archived_at", null)
      .is("deleted_at", null),
    db
      .from("lab_case_audit")
      .select("occurred_at")
      .like("actor_label", "worker:%")
      .order("occurred_at", { ascending: false })
      .limit(1),
  ]);

  const categories: HealthCategory[] = [];

  // 1) Portals — drive off consecutive_failures (existing ScrapersPanel
  //    convention: 1 = yellow, ≥2 = red) plus last-success staleness as a
  //    cron-liveness proxy (the portal probe runs ~daily).
  const scraperRows = (scrapers.data ?? []) as Array<{
    portal_key: string;
    last_check_at: string | null;
    last_success_at: string | null;
    last_error: string | null;
    consecutive_failures: number;
  }>;
  {
    // The zenoti-sync heartbeat lives in the same table but isn't a portal —
    // it gets its own category below.
    const rows = scraperRows.filter((r) => r.portal_key !== "zenoti-sync");
    const items: HealthItem[] = rows
      .map((r) => {
        let status: HealthStatus;
        if (r.consecutive_failures >= 2) status = "red";
        else if (r.consecutive_failures === 1) status = "yellow";
        else if (ageHours(r.last_success_at) > 72) status = "red";
        else if (ageHours(r.last_success_at) > 30) status = "yellow";
        else status = "green";
        const ok = formatAge(r.last_success_at);
        const note =
          status === "green"
            ? ok
              ? `ok · ${ok}`
              : "ok"
            : r.last_error
              ? r.last_error.slice(0, 80)
              : ok
                ? `last ok ${ok}`
                : "never succeeded";
        return { label: r.portal_key, status, note };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    const healthy = items.filter((i) => i.status === "green").length;
    categories.push({
      key: "portals",
      label: "Portal scrapers",
      status: rollup(items),
      headline:
        items.length === 0
          ? "No portals reporting yet"
          : `${healthy}/${items.length} portals healthy`,
      detail: "Daily login probe per portal. ≥2 failures = red.",
      items,
    });
  }

  // 1b) Zenoti sync heartbeat — the sync hits /api/worker/cases every ~3 min, so
  //     a stale last_success_at means it's stopped (e.g. a worker deploy left the
  //     always-on machine stopped). Tight thresholds so it goes red fast.
  {
    const hb = scraperRows.find((r) => r.portal_key === "zenoti-sync") ?? null;
    const age = ageHours(hb?.last_success_at);
    const status: HealthStatus = !hb
      ? "red"
      : age > 1
        ? "red"
        : age > 0.25
          ? "yellow"
          : "green";
    categories.push({
      key: "zenoti_sync",
      label: "Zenoti sync",
      status,
      headline: !hb
        ? "Never synced — heartbeat missing"
        : status === "green"
          ? `Healthy · last sync ${formatAge(hb.last_success_at)}`
          : `Stalled — last sync ${formatAge(hb.last_success_at)}`,
      detail:
        status === "red" && hb
          ? "Sync hasn't run in >1h. Likely the always-on zenoti machine is stopped — `fly machine start <id>`."
          : "Auto-creates cards from Zenoti lab appointments (every ~3 min).",
    });
  }

  // 2) PB upload queue
  {
    const rows = (jobs.data ?? []) as Array<{
      status: string;
      last_error: string | null;
    }>;
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    const queued = count("queued") + count("claimed");
    const failed = count("failed");
    const succeeded = count("succeeded");
    const lastErr = rows.find((r) => r.status === "failed")?.last_error;
    const status: HealthStatus =
      failed > 0 ? "red" : queued > 5 ? "yellow" : rows.length === 0 ? "idle" : "green";
    categories.push({
      key: "pb_queue",
      label: "PB upload queue",
      status,
      headline: `${queued} in flight · ${failed} failed · ${succeeded} done`,
      detail: failed > 0 && lastErr ? `Last error: ${lastErr.slice(0, 120)}` : undefined,
    });
  }

  // 3) Outbound email (14d)
  {
    const rows = (emails.data ?? []) as Array<{ status: string }>;
    const sent = rows.filter((r) => r.status === "sent").length;
    const failed = rows.filter((r) => r.status === "failed").length;
    const skipped = rows.filter((r) => r.status === "skipped").length;
    const attempted = sent + failed;
    const failRate = attempted === 0 ? 0 : failed / attempted;
    const status: HealthStatus =
      rows.length === 0 ? "idle" : failed === 0 ? "green" : failRate > 0.1 ? "red" : "yellow";
    categories.push({
      key: "email_out",
      label: "Outbound email (14d)",
      status,
      headline: `${sent} sent · ${failed} failed · ${skipped} skipped`,
      detail: "Resend delivery for patient lifecycle emails.",
    });
  }

  // 4) Inbound / Kennedy-BodyBio
  {
    const rows = (inbound.data ?? []) as Array<{
      parser_status: string;
      from_address: string | null;
      subject: string | null;
      received_at: string;
    }>;
    const count = (s: string) => rows.filter((r) => r.parser_status === s).length;
    const pending = count("pending");
    const failed = count("failed");
    const parsed = count("parsed") + count("applied");
    const isKennedy = (r: (typeof rows)[number]) =>
      /kennedy|bodybio|krieger/i.test(`${r.from_address ?? ""} ${r.subject ?? ""}`);
    const kennedy = rows.filter(isKennedy);
    const kennedyAge = formatAge(
      kennedy.map((r) => r.received_at).sort().at(-1) ?? null,
    );
    const items: HealthItem[] = [
      {
        label: "Kennedy / BodyBio",
        status: kennedy.length === 0 ? "idle" : "green",
        note:
          kennedy.length === 0
            ? "none in last 30d"
            : `${kennedy.length} in 30d · latest ${kennedyAge}`,
      },
    ];
    const status: HealthStatus =
      rows.length === 0 ? "idle" : failed > 0 ? "yellow" : pending > 0 ? "yellow" : "green";
    categories.push({
      key: "inbound",
      label: "Inbound email (30d)",
      status,
      headline: `${pending} pending · ${parsed} parsed · ${failed} failed`,
      detail: "Gmail poll + manual uploads of lab-result emails.",
      items,
    });
  }

  // 5) Tracking (FedEx/carrier polling)
  {
    const rows = (cases.data ?? []) as Array<{
      tracking_number: string | null;
      tracking_delivered_at: string | null;
      tracking_polled_at: string | null;
    }>;
    const tracked = rows.filter((r) => r.tracking_number);
    const inFlight = tracked.filter((r) => !r.tracking_delivered_at);
    const delivered = tracked.length - inFlight.length;
    const newestPoll = tracked
      .map((r) => r.tracking_polled_at)
      .filter(Boolean)
      .sort()
      .at(-1) as string | null;
    const pollAge = ageHours(newestPoll);
    const status: HealthStatus =
      tracked.length === 0
        ? "idle"
        : inFlight.length === 0
          ? "green"
          : pollAge > 30
            ? "yellow"
            : "green";
    categories.push({
      key: "tracking",
      label: "Shipment tracking",
      status,
      headline: `${inFlight.length} in transit · ${delivered} delivered`,
      detail: newestPoll
        ? `Last poll ${formatAge(newestPoll)}`
        : "No tracking polled yet",
    });
  }

  // 6) Automation activity (informational liveness — never "red", since a
  //    quiet engine usually just means no work, not an outage).
  {
    const lastWorkerAt =
      ((lastWorker.data ?? [])[0] as { occurred_at?: string } | undefined)
        ?.occurred_at ?? null;
    const age = formatAge(lastWorkerAt);
    const status: HealthStatus = lastWorkerAt
      ? ageHours(lastWorkerAt) < 24
        ? "green"
        : "idle"
      : "idle";
    categories.push({
      key: "automation",
      label: "Automation activity",
      status,
      headline: lastWorkerAt
        ? `Last automated post ${age}`
        : "No automated posts yet",
      detail: "Reconcile engine / worker write-backs (liveness signal).",
    });
  }

  return { generatedAt: new Date().toISOString(), categories };
}

// ── Engine & posting accuracy ─────────────────────────────────────────
//
// "Is the automation accurate?" — derived entirely from existing tables:
//   • lab_case_audit  → staged-PDF accuracy (approve vs wrong-PDF)
//   • lab_events      → how completed labs reached the chart (auto vs manual)
//   • pb_upload_jobs  → PB upload reliability
//   • lab_case_pdfs   → how many staged results await human review right now
// Time-series of per-reconcile-cycle tallies + live PB coverage % are a
// follow-up (need a small metrics table the worker writes each cycle).

export type EngineMetrics = {
  generatedAt: string;
  pdf: {
    verdicts: number;
    approved: number;
    wrongPdf: number;
    uploadFailed: number;
    pctCorrect: number | null; // approved / (approved + wrongPdf)
  };
  posting: {
    worker: number; // worker:pb-upload — real unattended PB post
    auto: number; // engine:* auto-post
    backfill: number; // admin:backfill-brain "already on PB" advance
    manual: number; // staff marked complete by hand
    total: number;
  };
  upload: { succeeded: number; failed: number; inFlight: number; pctSuccess: number | null };
  queue: { awaitingReview: number };
  // Weekly approve-vs-wrong trend (last 8 ISO weeks, oldest → newest).
  trend: Array<{ week: string; approved: number; wrong: number }>;
  // Latest PB-coverage snapshot (null until the worker has written one / the
  // metrics migration is applied).
  coverage: {
    coveragePct: number | null;
    total: number;
    strong: number;
    likely: number;
    missing: number;
    noMatch: number;
    ranAt: string | null;
  } | null;
  // Recent reconcile cycles, oldest → newest (empty until the worker writes them).
  cycles: Array<{
    ranAt: string;
    advanced: number;
    autoposted: number;
    flagged: number;
    searching: number;
    errors: number;
  }>;
};

function isoWeekKey(d: Date): string {
  // Monday-anchored week label "MMM D" of that Monday — good enough for a chart.
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - day);
  return monday.toISOString().slice(0, 10);
}

export async function getEngineMetrics(): Promise<EngineMetrics> {
  await requireRole("admin");
  const db = getSupabaseAdmin();
  const weeksBack = 8;
  const since = new Date(Date.now() - weeksBack * 7 * 86400000).toISOString();

  const [auditRes, postRes, jobsRes, pendingPdfRes] = await Promise.all([
    db.from("lab_case_audit").select("action, occurred_at"),
    // Step-5 completions = a lab landing on the chart. completed flag + step=5.
    db
      .from("lab_events")
      .select("actor")
      .eq("kind", "step_toggled")
      .eq("step", 5)
      .eq("completed", true),
    db.from("pb_upload_jobs").select("status"),
    // Non-superseded staged PDFs → their cases → those not yet complete are the
    // ones a human still needs to review/approve.
    db.from("lab_case_pdfs").select("case_id").is("superseded_at", null),
  ]);
  if (auditRes.error) throw new Error(auditRes.error.message);
  if (postRes.error) throw new Error(postRes.error.message);
  if (jobsRes.error) throw new Error(jobsRes.error.message);
  if (pendingPdfRes.error) throw new Error(pendingPdfRes.error.message);

  const audit = (auditRes.data ?? []) as Array<{ action: string; occurred_at: string }>;
  const approved = audit.filter((a) => a.action === "approve").length;
  const wrongPdf = audit.filter((a) => a.action === "disapprove_wrong_pdf").length;
  const uploadFailed = audit.filter((a) => a.action === "disapprove_upload_failed").length;
  const judged = approved + wrongPdf;

  // Posting attribution by actor bucket.
  const posts = (postRes.data ?? []) as Array<{ actor: string | null }>;
  const bucket = { worker: 0, auto: 0, backfill: 0, manual: 0 };
  for (const p of posts) {
    const a = (p.actor ?? "").toLowerCase();
    if (a.startsWith("worker:")) bucket.worker += 1;
    else if (a.startsWith("engine")) bucket.auto += 1;
    else if (a.startsWith("admin:backfill")) bucket.backfill += 1;
    else bucket.manual += 1;
  }

  const jobs = (jobsRes.data ?? []) as Array<{ status: string }>;
  const jSucceeded = jobs.filter((j) => j.status === "succeeded").length;
  const jFailed = jobs.filter((j) => j.status === "failed").length;
  const jInFlight = jobs.filter((j) => j.status === "queued" || j.status === "claimed").length;
  const jAttempted = jSucceeded + jFailed;

  // Awaiting review = distinct cases with a live staged PDF that aren't complete.
  const pendingCaseIds = [
    ...new Set((pendingPdfRes.data ?? []).map((r: { case_id: string }) => r.case_id)),
  ];
  let awaitingReview = 0;
  if (pendingCaseIds.length) {
    const { data: openCases } = await db
      .from("lab_cases")
      .select("id")
      .in("id", pendingCaseIds)
      .eq("step5_complete_uploaded", false)
      .is("archived_at", null)
      .is("deleted_at", null);
    awaitingReview = (openCases ?? []).length;
  }

  // Weekly trend.
  const weekMap = new Map<string, { approved: number; wrong: number }>();
  for (let i = weeksBack - 1; i >= 0; i--) {
    weekMap.set(isoWeekKey(new Date(Date.now() - i * 7 * 86400000)), { approved: 0, wrong: 0 });
  }
  for (const a of audit) {
    if (a.occurred_at < since) continue;
    const k = isoWeekKey(new Date(a.occurred_at));
    const w = weekMap.get(k);
    if (!w) continue;
    if (a.action === "approve") w.approved += 1;
    else if (a.action === "disapprove_wrong_pdf") w.wrong += 1;
  }

  // Time-series from the worker-written metrics tables. These may not exist yet
  // (migration 20260608_engine_metrics pending) — degrade gracefully to null/[].
  let coverage: EngineMetrics["coverage"] = null;
  let cycles: EngineMetrics["cycles"] = [];
  const [auditSnap, engineRuns] = await Promise.all([
    db.from("lab_audit_runs").select("*").order("ran_at", { ascending: false }).limit(1),
    db.from("lab_engine_runs").select("*").order("ran_at", { ascending: false }).limit(24),
  ]);
  if (!auditSnap.error && auditSnap.data?.[0]) {
    const r = auditSnap.data[0] as Record<string, unknown>;
    coverage = {
      coveragePct: (r.coverage_pct as number | null) ?? null,
      total: (r.total as number) ?? 0,
      strong: (r.strong as number) ?? 0,
      likely: (r.likely as number) ?? 0,
      missing: (r.missing as number) ?? 0,
      noMatch: (r.no_match as number) ?? 0,
      ranAt: (r.ran_at as string | null) ?? null,
    };
  }
  if (!engineRuns.error && engineRuns.data) {
    cycles = (engineRuns.data as Array<Record<string, unknown>>)
      .map((r) => ({
        ranAt: (r.ran_at as string) ?? "",
        advanced: (r.advanced as number) ?? 0,
        autoposted: (r.autoposted as number) ?? 0,
        flagged: (r.flagged as number) ?? 0,
        searching: (r.searching as number) ?? 0,
        errors: (r.errors as number) ?? 0,
      }))
      .reverse(); // oldest → newest for the chart
  }

  return {
    generatedAt: new Date().toISOString(),
    pdf: {
      verdicts: judged,
      approved,
      wrongPdf,
      uploadFailed,
      pctCorrect: judged === 0 ? null : Math.round((approved / judged) * 1000) / 10,
    },
    posting: { ...bucket, total: posts.length },
    upload: {
      succeeded: jSucceeded,
      failed: jFailed,
      inFlight: jInFlight,
      pctSuccess: jAttempted === 0 ? null : Math.round((jSucceeded / jAttempted) * 1000) / 10,
    },
    queue: { awaitingReview },
    trend: [...weekMap.entries()].map(([week, v]) => ({ week, ...v })),
    coverage,
    cycles,
  };
}
