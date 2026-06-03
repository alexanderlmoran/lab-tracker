import type { LabCase } from "@/lib/types";

// Display label for a case's lab + panel.
//
// Zenoti sends multi-panel tests as one service string ("Labs - Vibrant -
// Total Tox (urine)", "Labs - Vibrant Zoomer - Gut"), but the sync only stores
// the provider in lab_name ("Vibrant") and leaves lab_panel null — so a bare
// "Vibrant" (or the catalog's "Vibrant (panel unspecified)") is all the UI had.
// The panel still lives in zenoti_service_name, so recover it from there when
// lab_panel is empty: strip the "Labs - " prefix and a redundant leading
// provider, leaving the panel ("Total Tox (urine)", "Zoomer - Gut").

type LabelCase = Pick<LabCase, "lab_name" | "lab_panel" | "zenoti_service_name">;

/** The panel portion alone (lab_panel, else parsed from the Zenoti service), or "". */
export function panelFor(c: LabelCase): string {
  if (c.lab_panel && c.lab_panel.trim()) return c.lab_panel.trim();
  const svc = c.zenoti_service_name?.trim();
  if (!svc) return "";
  const stripped = svc.replace(/^labs\s*-\s*/i, "").trim();
  const lab = (c.lab_name ?? "").trim();
  const panel = lab && stripped.toLowerCase().startsWith(lab.toLowerCase())
    ? stripped.slice(lab.length).replace(/^[\s·•\-]+/, "").trim()
    : stripped;
  return panel;
}

/** "Vibrant · Total Tox (urine)" — provider, then panel when we can recover one. */
export function labelForCase(c: LabelCase): string {
  const panel = panelFor(c);
  return panel ? `${c.lab_name} · ${panel}` : c.lab_name;
}
