import { requireRole } from "@/lib/auth-guard";
import { listSalesInvoices, getSalesTotals, type SalesQuery } from "./actions";
import { HudPulse } from "../HudPulse";
import { SalesFilters } from "./SalesFilters";
import { formatPersonName } from "@/lib/format";

export const dynamic = "force-dynamic";

function firstString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function formatMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireRole("developer");
  const sp = await searchParams;
  const q = firstString(sp.q) ?? "";
  const formatRaw = firstString(sp.format);
  const format: "all" | "guest-sales" | "item-sales" =
    formatRaw === "guest-sales" || formatRaw === "item-sales" ? formatRaw : "all";
  const sinceDate = firstString(sp.since) ?? "";
  const untilDate = firstString(sp.until) ?? "";

  const query: SalesQuery = {
    q: q || undefined,
    format,
    sinceDate: sinceDate || undefined,
    untilDate: untilDate || undefined,
    limit: 500,
  };

  const [rowsRes, totalsRes] = await Promise.all([
    listSalesInvoices(query),
    getSalesTotals(query),
  ]);

  const rows = rowsRes.ok ? rowsRes.data ?? [] : [];
  const totals = totalsRes.ok && totalsRes.data
    ? totalsRes.data
    : { rowCount: 0, totalSalesExTax: 0, totalCollected: 0, totalDue: 0 };
  const err = rowsRes.ok ? null : rowsRes.error;

  return (
    <div className="min-h-dvh bg-zinc-50">
      <HudPulse user={user} />
      <main className="mx-auto max-w-screen-2xl px-4 py-4">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold tracking-tight text-zinc-900">
              Sales &amp; invoices
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500">
              Developer-only. Sourced from Centner sales CSV imports — every line
              item, lab and non-lab. Capped at 500 rows; tighten the filters to
              drill in.
            </p>
          </div>
        </div>

        <SalesFilters q={q} format={format} since={sinceDate} until={untilDate} />

        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Stat label="Rows" value={totals.rowCount.toLocaleString()} />
          <Stat label="Sales (excl. tax)" value={formatMoney(totals.totalSalesExTax)} />
          <Stat label="Collected" value={formatMoney(totals.totalCollected)} />
          <Stat label="Due" value={formatMoney(totals.totalDue)} />
        </div>

        {err ? (
          <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {err}
          </p>
        ) : null}

        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full min-w-[1000px] text-xs">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-[11px] uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2">Service date</th>
                <th className="px-3 py-2">Guest</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 text-right">Sales</th>
                <th className="px-3 py-2 text-right">Collected</th>
                <th className="px-3 py-2 text-right">Due</th>
                <th className="px-3 py-2">Payment</th>
                <th className="px-3 py-2">Center</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-8 text-center text-zinc-500">
                    No sales rows. Import a Centner CSV from{" "}
                    <a className="underline" href="/labs/import">/labs/import</a>.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="hover:bg-zinc-50">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-zinc-700">
                      {formatDate(r.service_date)}
                    </td>
                    <td className="px-3 py-2 text-zinc-900">{formatPersonName(r.guest_name)}</td>
                    <td className="px-3 py-2 text-zinc-500">{r.email ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-zinc-600">
                      {r.invoice_no}
                    </td>
                    <td className="px-3 py-2 text-zinc-700">{r.item_name}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-zinc-700">
                      {formatMoney(r.sales_ex_tax)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-zinc-700">
                      {formatMoney(r.collected)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-zinc-700">
                      {formatMoney(r.due)}
                    </td>
                    <td className="px-3 py-2 text-zinc-500">{r.payment_type ?? "—"}</td>
                    <td className="px-3 py-2 text-zinc-500">{r.center_name ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3">
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-zinc-900">
        {value}
      </p>
    </div>
  );
}
