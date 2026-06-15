// Reproduce the consumables headless slowness IN ISOLATION: fresh login + a single
// GetAppointmentProducts call, timed. Fast here ⇒ the prod slowness was session
// contention with the sync (fix: isolate the pass). Slow here ⇒ the request itself
// (headers/warmup) needs work.
// Run: cd worker && npx tsx scripts/iv-test-consumables-live.ts
import { loadEnvLocal } from "../src/lib/load-env.js";
import { zenotiLogin } from "../src/zenoti/login.js";
import { fetchZenotiAppointmentProducts } from "../src/zenoti/fetch-browser.js";

loadEnvLocal();
const STORAGE = "/tmp/zenoti-test-session.json";
const APPT = "ce0aadab-ac7f-4cea-8118-46ffc0f8f83a"; // Leila PC (has consumables)

async function main() {
  console.time("login");
  const n = await zenotiLogin(STORAGE);
  console.timeEnd("login");
  console.log(`cookies: ${n}`);
  for (let i = 1; i <= 2; i++) {
    const t = Date.now();
    try {
      const prods = await fetchZenotiAppointmentProducts({ storagePath: STORAGE, appointmentId: APPT });
      console.log(`call#${i}: ${Date.now() - t}ms → ${prods.length} products: ${prods.map((p) => `${p.name} x${p.unitsUsed}`).join(", ").slice(0, 120)}`);
    } catch (e) {
      console.log(`call#${i}: ${Date.now() - t}ms → ERROR: ${e instanceof Error ? e.message : e}`);
    }
  }
}
main().catch((e) => { console.error("FATAL", e instanceof Error ? (e.stack ?? e.message) : e); process.exit(1); });
