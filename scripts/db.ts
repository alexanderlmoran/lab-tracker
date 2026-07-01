// scripts/db.ts — talk to Supabase from the CLI so audits, migrations, and schema
// inspection don't need the SQL editor or a human relay. Loads .env.local itself.
//
// FULL mode (arbitrary SQL incl. DDL) — needs a direct Postgres connection string.
//   Add to .env.local (Supabase dashboard → Project Settings → Database →
//   Connection string → URI, the "Session pooler" one):
//     SUPABASE_DB_URL=postgresql://postgres.<ref>:<pwd>@<host>:6543/postgres
//   Then:
//     npx tsx scripts/db.ts sql "select count(*) from lab_cases"
//     npx tsx scripts/db.ts migrate supabase/migrations/20260701_patient_safety_triggers.sql
//
// READ mode (works today with SUPABASE_SECRET_KEY — no extra setup):
//     npx tsx scripts/db.ts count  lab_cases
//     npx tsx scripts/db.ts peek   lab_cases                     # 1 row → columns
//     npx tsx scripts/db.ts select lab_cases "step1_sample_sent=eq.true" 5

import { readFileSync } from "node:fs";

function loadEnvLocal(): void {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch {
    /* no .env.local — rely on real env (CI / Fly) */
  }
}

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY missing from env");
  // Lazy import so READ mode needs only @supabase/supabase-js (already a dep).
  return import("@supabase/supabase-js").then(({ createClient }) =>
    createClient(url, key, { auth: { persistSession: false } }),
  );
}

async function pg() {
  const url = process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "FULL mode needs a direct Postgres URL. Add SUPABASE_DB_URL to .env.local\n" +
        "(Supabase → Project Settings → Database → Connection string → URI, Session pooler).\n" +
        "For reads without it, use: count | peek | select.",
    );
    process.exit(2);
  }
  type PgClient = { unsafe: (q: string) => Promise<unknown[]>; end: () => Promise<void> };
  type PgFactory = (url: string, opts?: Record<string, unknown>) => PgClient;
  let postgres: PgFactory;
  try {
    postgres = ((await import("postgres")) as unknown as { default: PgFactory }).default;
  } catch {
    console.error("`postgres` not installed. Run:  npm i -D postgres");
    process.exit(2);
  }
  return postgres(url, { prepare: false, ssl: "require", max: 1 });
}

async function main() {
  loadEnvLocal();
  const [cmd, a, b, c] = process.argv.slice(2);

  if (cmd === "sql") {
    if (!a) return void console.error('usage: db.ts sql "<query>"');
    const sql = await pg();
    try {
      const rows = await sql.unsafe(a);
      console.log(JSON.stringify(rows, null, 2));
    } finally {
      await sql.end();
    }
    return;
  }

  if (cmd === "migrate") {
    if (!a) return void console.error("usage: db.ts migrate <path.sql>");
    const text = readFileSync(a, "utf8");
    const sql = await pg();
    try {
      await sql.unsafe(text);
      console.log(`✓ applied ${a}`);
    } finally {
      await sql.end();
    }
    return;
  }

  const db = await admin();

  if (cmd === "count") {
    if (!a) return void console.error("usage: db.ts count <table>");
    const { count, error } = await db.from(a).select("*", { head: true, count: "exact" });
    if (error) return void console.error("error:", error.message);
    console.log(`${a}: ${count} row(s)`);
    return;
  }

  if (cmd === "peek") {
    if (!a) return void console.error("usage: db.ts peek <table>");
    const { data, error } = await db.from(a).select("*").limit(1);
    if (error) return void console.error("error:", error.message);
    const row = data?.[0];
    if (!row) return void console.log(`${a}: (no rows)`);
    console.log(`${a} columns:\n  ${Object.keys(row).join("\n  ")}\n\nsample row:`);
    console.log(JSON.stringify(row, null, 2));
    return;
  }

  if (cmd === "select") {
    if (!a) return void console.error('usage: db.ts select <table> ["col=op.val"] [limit]');
    let q = db.from(a).select("*");
    if (b) {
      const [col, rest] = b.split("=");
      const [op, ...valParts] = (rest ?? "").split(".");
      q = q.filter(col, op, valParts.join("."));
    }
    const limit = c ? Number(c) : 20;
    const { data, error } = await q.limit(Number.isFinite(limit) ? limit : 20);
    if (error) return void console.error("error:", error.message);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.error(
    "commands:\n" +
      "  count <table>                       row count\n" +
      "  peek <table>                        1 row → column names\n" +
      '  select <table> ["col=op.val"] [n]   filtered read (PostgREST ops: eq,neq,gt,is,ilike…)\n' +
      '  sql "<query>"                       arbitrary SQL      (needs SUPABASE_DB_URL)\n' +
      "  migrate <path.sql>                  apply a migration  (needs SUPABASE_DB_URL)",
  );
  process.exit(1);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
