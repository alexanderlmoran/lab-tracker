// Live field-position overrides for req-form templates. The static specs in
// specs.ts are the code source of truth, but calibrating coordinates by hand is
// slow. The visual calibrator writes per-template overrides here (a JSON blob in
// the same templates bucket), merged over the spec at fill time — so dragging a
// field to the right spot goes live immediately, no deploy. Bake the final
// numbers back into specs.ts when they settle.

import "server-only";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { FieldPos, ReqField } from "./types";

const BUCKET = "req-form-templates";
const keyFor = (templateKey: string) => `__overrides/${templateKey}.json`;

export type FieldOverrides = Partial<Record<ReqField, FieldPos>>;

/** Read a template's saved overrides (empty object if none / unreadable). */
export async function loadOverrides(templateKey: string): Promise<FieldOverrides> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.storage.from(BUCKET).download(keyFor(templateKey));
  if (error || !data) return {};
  try {
    const parsed = JSON.parse(await data.text());
    return parsed && typeof parsed === "object" ? (parsed as FieldOverrides) : {};
  } catch {
    return {};
  }
}

/** Persist a template's overrides (full field map). cacheControl 0 keeps reads fresh. */
export async function saveOverrides(templateKey: string, fields: FieldOverrides): Promise<void> {
  const db = getSupabaseAdmin();
  const body = new Blob([JSON.stringify(fields, null, 2)], { type: "application/json" });
  const { error } = await db.storage.from(BUCKET).upload(keyFor(templateKey), body, {
    upsert: true,
    contentType: "application/json",
    cacheControl: "0",
  });
  if (error) throw new Error(`save req-form overrides failed: ${error.message}`);
}

/** spec positions with per-field overrides applied (override wins, field-by-field). */
export function mergeFields(base: FieldOverrides, overrides: FieldOverrides): FieldOverrides {
  const out: FieldOverrides = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v) out[k as ReqField] = { ...out[k as ReqField], ...v };
  }
  return out;
}
