// Read-only CLI view of the reliability backbone (lab_scraper_status). Mirrors the
// watchdog in src/lib/email/digests.ts (runHeartbeatWatch) so we can eyeball the
// same data it pages on — which loop last succeeded, how stale, failure streaks.
// This is what diagnoses a "Synced Nd ago" outage. No writes.
//   cd worker && npx tsx scripts/check-heartbeats.ts

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";

loadEnvLocal();
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!, KEY = process.env.SUPABASE_SECRET_KEY!;

// Same windows the watchdog enforces.
const WATCHED: Array<{ key: string; label: string; maxAgeH: number }> = [
  { key: "zenoti-sync", label: "Zenoti sync", maxAgeH: 2 },
  { key: "scrape-loop", label: "Portal scrape loop", maxAgeH: 6 },
  { key: "tracking", label: "FedEx tracking refresh", maxAgeH: 8 },
  { key: "ivpost", label: "IV auto-post loop", maxAgeH: 3 },
  { key: "pbdrain", label: "PB upload drain", maxAgeH: 2 },
  { key: "reconcile", label: "Reconcile / auto-post engine", maxAgeH: 6 },
  { key: "gmailsync", label: "Gmail inbox sync + KK forward", maxAgeH: 1 },
];

async function rest(path: string): Promise<{ status: number; rows: any[] }> {
  const res = await request(`${SUPA}/rest/v1/${path}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
  const txt = await res.body.text();
  return { status: res.statusCode, rows: txt && txt.startsWith("[") ? JSON.parse(txt) : [] };
}

function ageStr(iso: string | null): { h: number; s: string } {
  if (!iso) return { h: Infinity, s: "never" };
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return { h, s: `${Math.round(h * 60)}m ago` };
  if (h < 48) return { h, s: `${h.toFixed(1)}h ago` };
  return { h, s: `${Math.round(h / 24)}d ago` };
}

async function main() {
  const all = await rest("lab_scraper_status?select=portal_key,last_success_at,last_check_at,last_status_code,consecutive_failures,last_error&order=portal_key.asc");
  if (all.status >= 400) {
    console.log(`❌ lab_scraper_status not reachable (status ${all.status}) — migration may not be applied to prod.`);
    return;
  }
  const byKey = new Map(all.rows.map((r) => [r.portal_key as string, r]));

  console.log(`\n══ WATCHED LOOPS (what the watchdog pages on) ══`);
  let stale = 0;
  for (const w of WATCHED) {
    const row = byKey.get(w.key);
    if (!row) { console.log(`  ⚠ ${w.label} [${w.key}]: NO ROW (no heartbeat ever)`); continue; }
    const fails = (row.consecutive_failures as number | null) ?? 0;
    const { h, s } = ageStr(row.last_success_at);
    const bad = fails >= 3 || h > w.maxAgeH;
    if (bad) stale++;
    const flag = bad ? "🔴" : "🟢";
    const why = fails >= 3 ? `${fails} consecutive failures` : h > w.maxAgeH ? `STALE (>${w.maxAgeH}h)` : "ok";
    console.log(`  ${flag} ${w.label.padEnd(34)} last success ${s.padEnd(10)} ${why}${row.last_error ? `  · last_error: ${String(row.last_error).slice(0, 120)}` : ""}`);
  }
  console.log(`\n  → ${stale} loop(s) would page the watchdog right now.`);

  // Per-portal scraper rows (scrape:access, scrape:cyrex, …) for full visibility.
  const portals = all.rows.filter((r) => !WATCHED.some((w) => w.key === r.portal_key));
  if (portals.length) {
    console.log(`\n══ OTHER status rows (per-portal etc.) ══`);
    for (const r of portals) {
      const { s } = ageStr(r.last_success_at);
      console.log(`  • ${String(r.portal_key).padEnd(24)} fails=${(r.consecutive_failures ?? 0)} last success ${s}${r.last_error ? `  · ${String(r.last_error).slice(0, 90)}` : ""}`);
    }
  }
  console.log("");
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? (e.stack ?? e.message) : e); process.exit(1); });
