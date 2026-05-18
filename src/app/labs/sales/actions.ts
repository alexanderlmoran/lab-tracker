"use server";

import { z } from "zod";
import { requireRole } from "@/lib/auth-guard";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { ActionResult } from "@/lib/types";

export type SalesInvoiceRow = {
  id: string;
  source_format: "guest-sales" | "item-sales";
  bulk_import_id: string | null;
  guest_name: string;
  email: string | null;
  service_date: string;
  invoice_no: string;
  item_name: string;
  item_type: string | null;
  guest_code: string | null;
  center_code: string | null;
  center_name: string | null;
  item_code: string | null;
  qty: number | null;
  sales_ex_tax: number | null;
  collected: number | null;
  due: number | null;
  payment_type: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Parse "$1,070", "$0", "1234.56", "" → number | null. Centner exports prefix
 * with $ and may include thousands separators; null when blank.
 */
function parseMoney(s: string | null): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseQty(s: string | null): number | null {
  if (!s) return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
}

const SaveInput = z.object({
  bulkImportId: z.string().uuid().nullable(),
  rows: z
    .array(
      z.object({
        sourceFormat: z.enum(["guest-sales", "item-sales"]),
        guestName: z.string().min(1),
        email: z.string().nullable(),
        serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        invoiceNo: z.string().min(1),
        itemName: z.string().min(1),
        itemType: z.string().nullable(),
        guestCode: z.string().nullable(),
        centerCode: z.string().nullable(),
        centerName: z.string().nullable(),
        itemCode: z.string().nullable(),
        qty: z.string().nullable(),
        salesExTax: z.string().nullable(),
        collected: z.string().nullable(),
        due: z.string().nullable(),
        paymentType: z.string().nullable(),
      }),
    )
    .max(2000),
});

export type SaveSalesInvoicesInput = z.infer<typeof SaveInput>;

/**
 * Upsert sales rows from a Centner CSV import. Dedup key matches the unique
 * index in the migration: (invoice_no, item_name, service_date, guest_name).
 * Safe to call repeatedly with the same CSV — re-imports update in place.
 */
export async function saveSalesInvoices(
  input: SaveSalesInvoicesInput,
): Promise<ActionResult<{ insertedOrUpdated: number }>> {
  await requireRole("developer");
  const parsed = SaveInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  if (parsed.data.rows.length === 0) return { ok: true, data: { insertedOrUpdated: 0 } };

  const db = getSupabaseAdmin();
  const payload = parsed.data.rows.map((r) => ({
    source_format: r.sourceFormat,
    bulk_import_id: parsed.data.bulkImportId,
    guest_name: r.guestName,
    email: r.email,
    service_date: r.serviceDate,
    invoice_no: r.invoiceNo,
    item_name: r.itemName,
    item_type: r.itemType,
    guest_code: r.guestCode,
    center_code: r.centerCode,
    center_name: r.centerName,
    item_code: r.itemCode,
    qty: parseQty(r.qty),
    sales_ex_tax: parseMoney(r.salesExTax),
    collected: parseMoney(r.collected),
    due: parseMoney(r.due),
    payment_type: r.paymentType,
    raw_row: r,
  }));

  const { error } = await db
    .from("sales_invoices")
    .upsert(payload, {
      onConflict: "invoice_no,item_name,service_date,guest_name",
    });
  if (error) return { ok: false, error: error.message };

  return { ok: true, data: { insertedOrUpdated: payload.length } };
}

export type SalesQuery = {
  q?: string;
  format?: "guest-sales" | "item-sales" | "all";
  sinceDate?: string;
  untilDate?: string;
  limit?: number;
};

/**
 * Page-load query for the Sales viewer. Returns rows ordered by service_date
 * desc, capped at `limit` (default 500). Search matches guest name, email,
 * invoice no, or item name (case-insensitive substring).
 */
export async function listSalesInvoices(
  query: SalesQuery,
): Promise<ActionResult<SalesInvoiceRow[]>> {
  await requireRole("developer");
  const db = getSupabaseAdmin();
  let q = db.from("sales_invoices").select("*");
  if (query.format && query.format !== "all") {
    q = q.eq("source_format", query.format);
  }
  if (query.sinceDate) q = q.gte("service_date", query.sinceDate);
  if (query.untilDate) q = q.lte("service_date", query.untilDate);
  if (query.q && query.q.trim()) {
    const term = query.q.replace(/[%_,()]/g, " ").trim();
    q = q.or(
      `guest_name.ilike.%${term}%,email.ilike.%${term}%,invoice_no.ilike.%${term}%,item_name.ilike.%${term}%`,
    );
  }
  q = q.order("service_date", { ascending: false }).limit(query.limit ?? 500);

  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? []) as SalesInvoiceRow[] };
}

export type SalesTotals = {
  rowCount: number;
  totalSalesExTax: number;
  totalCollected: number;
  totalDue: number;
};

/**
 * Aggregate totals over a filtered window. Same filter contract as
 * `listSalesInvoices` so the totals match what's visible in the table.
 */
export async function getSalesTotals(
  query: SalesQuery,
): Promise<ActionResult<SalesTotals>> {
  await requireRole("developer");
  const db = getSupabaseAdmin();
  let q = db
    .from("sales_invoices")
    .select("sales_ex_tax, collected, due", { count: "exact" });
  if (query.format && query.format !== "all") {
    q = q.eq("source_format", query.format);
  }
  if (query.sinceDate) q = q.gte("service_date", query.sinceDate);
  if (query.untilDate) q = q.lte("service_date", query.untilDate);
  if (query.q && query.q.trim()) {
    const term = query.q.replace(/[%_,()]/g, " ").trim();
    q = q.or(
      `guest_name.ilike.%${term}%,email.ilike.%${term}%,invoice_no.ilike.%${term}%,item_name.ilike.%${term}%`,
    );
  }
  const { data, error, count } = await q;
  if (error) return { ok: false, error: error.message };
  const rows = (data ?? []) as Array<{
    sales_ex_tax: number | null;
    collected: number | null;
    due: number | null;
  }>;
  let totalSalesExTax = 0;
  let totalCollected = 0;
  let totalDue = 0;
  for (const r of rows) {
    if (r.sales_ex_tax != null) totalSalesExTax += Number(r.sales_ex_tax);
    if (r.collected != null) totalCollected += Number(r.collected);
    if (r.due != null) totalDue += Number(r.due);
  }
  return {
    ok: true,
    data: {
      rowCount: count ?? rows.length,
      totalSalesExTax,
      totalCollected,
      totalDue,
    },
  };
}
