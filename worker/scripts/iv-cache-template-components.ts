// Populate iv_template_refs.components from each template's PB reference note, so
// the charting form can PREFILL components. Single source of truth = the PB
// template; this just caches its component rows (product label + resolved standard
// dose, via the same path the auto-post uses → prefill == what posts).
//
// Idempotent — re-run after editing a template in PB or seeding a new ref.
// Requires PB egress (run where PB is reachable: locally or via the Tailscale
// exit node, same as the post worker).
//
// Run: cd worker && npx tsx scripts/iv-cache-template-components.ts

import { request } from "undici";
import { loadEnvLocal } from "../src/lib/load-env.js";
import { pbLogin } from "../src/uploaders/practicebetter.js";
import { getSessionNote, scaffoldFromNote } from "../src/uploaders/pb-sessionnotes.js";
import { extractTemplateComponents } from "../src/iv/build-note-content.js";

loadEnvLocal();
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!, KEY = process.env.SUPABASE_SECRET_KEY!;

async function rest(method: string, path: string, body?: unknown, prefer?: string) {
  const res = await request(`${SUPA}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      ...(prefer ? { prefer } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const txt = await res.body.text();
  if (res.statusCode >= 300) throw new Error(`${method} ${path} ${res.statusCode}: ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : null;
}

async function main() {
  const refs = (await rest("GET", "iv_template_refs?select=template_hint,reference_note_id")) as Array<{
    template_hint: string;
    reference_note_id: string;
  }>;
  const pb = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  console.log(`\n══ caching components for ${refs.length} template(s) ══`);
  let ok = 0;
  for (const r of refs.sort((a, b) => a.template_hint.localeCompare(b.template_hint))) {
    try {
      const ref = await getSessionNote(pb, r.reference_note_id);
      const components = extractTemplateComponents(scaffoldFromNote(ref));
      await rest(
        "PATCH",
        `iv_template_refs?template_hint=eq.${encodeURIComponent(r.template_hint)}`,
        { components },
        "return=minimal",
      );
      const names = components.map((c) => c.name).join(", ");
      console.log(`  ✅ ${r.template_hint.padEnd(34)} ${components.length} component(s): ${names.slice(0, 90)}`);
      ok++;
    } catch (e) {
      console.log(`  ❌ ${r.template_hint.padEnd(34)} ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\n  → cached ${ok}/${refs.length}`);
}
main().catch((e) => {
  console.error("FATAL", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
