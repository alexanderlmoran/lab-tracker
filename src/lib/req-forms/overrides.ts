// Live field-position overrides for req-form templates. The static specs in
// specs.ts are the code source of truth, but calibrating coordinates by hand is
// slow. The visual calibrator writes per-template overrides here (a JSON blob in
// the same templates bucket), merged over the spec at fill time — so dragging a
// field to the right spot goes live immediately, no deploy. Bake the final
// numbers back into specs.ts when they settle.
//
// Overrides also hold CUSTOM fields — boxes the user adds in the calibrator and
// types into in the dialog (collection time, AM/PM, fasting note, etc.) — so new
// fields never require a code change.

import "server-only";
import { getSupabaseAdmin } from "@/utils/supabase/admin";
import type { FieldPos, ReqField } from "./types";

const BUCKET = "req-form-templates";
const keyFor = (templateKey: string) => `__overrides/${templateKey}.json`;

export type FieldOverrides = Partial<Record<ReqField, FieldPos>>;

/** A user-added field: its own key + label, positioned like any other. The value
 *  is typed per-case in the dialog (not stored here). */
export type CustomField = {
  key: string; // stable id, e.g. "c_ab12cd34"
  label: string; // shown in the dialog as the input's label
  x: number;
  yTop: number;
  size: number;
  page?: number;
};

export type TemplateOverrides = { fields: FieldOverrides; custom: CustomField[] };

/** Old saves were a bare FieldOverrides map; new saves are {fields, custom}.
 *  No ReqField is named "fields"/"custom", so the presence of either key tells
 *  the shapes apart. */
function normalize(raw: unknown): TemplateOverrides {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if ("fields" in o || "custom" in o) {
      return {
        fields: (o.fields as FieldOverrides) ?? {},
        custom: Array.isArray(o.custom) ? (o.custom as CustomField[]) : [],
      };
    }
    return { fields: o as FieldOverrides, custom: [] }; // legacy bare map
  }
  return { fields: {}, custom: [] };
}

/** Read a template's saved overrides (empty if none / unreadable). */
export async function loadOverrides(templateKey: string): Promise<TemplateOverrides> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.storage.from(BUCKET).download(keyFor(templateKey));
  if (error || !data) return { fields: {}, custom: [] };
  try {
    return normalize(JSON.parse(await data.text()));
  } catch {
    return { fields: {}, custom: [] };
  }
}

/** Persist a template's overrides. cacheControl 0 keeps reads fresh. */
export async function saveOverrides(templateKey: string, ov: TemplateOverrides): Promise<void> {
  const db = getSupabaseAdmin();
  const body = new Blob([JSON.stringify(ov, null, 2)], { type: "application/json" });
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
