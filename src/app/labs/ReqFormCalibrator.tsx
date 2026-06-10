"use client";

// Visual calibrator for req-form field positions. Renders the blank template
// (pdf.js) and overlays each field as draggable SVG <text>. SVG text is anchored
// at its alphabetic baseline — the exact anchor pdf-lib's drawText uses — so what
// you see on screen is pixel-for-pixel where it gets stamped (WYSIWYG).
//
// Move a field: drag it. Resize: select it, use −/+ or the [ ] keys. Set its
// start point: select it, then tap anywhere on the page. Save writes the coords
// to the template's overrides, which fillReqForm merges on the next render — live
// immediately, no deploy.

import { useCallback, useEffect, useRef, useState } from "react";
import { loadReqFormCalibration, saveReqFormPositions } from "./req-form-actions";
import type { FieldOverrides, CustomField } from "@/lib/req-forms/overrides";

const TARGET_W = 760; // on-screen page width (px); native points scale to fit this

// pdfjs MUST run as its own standalone bundle. Letting the app bundler (webpack/
// turbopack) re-process pdfjs-dist throws "Object.defineProperty called on non-
// object" (its internal bundle runtime collides with the host's). So we load the
// self-hosted legacy build (public/pdfjs/, copied by the copy-pdf-worker script)
// via a NATIVE dynamic import the bundler can't see and won't touch.
type PdfjsApi = typeof import("pdfjs-dist");
const nativeImport = new Function("u", "return import(u)") as (u: string) => Promise<unknown>;
async function loadPdfjs(): Promise<PdfjsApi> {
  const pdfjs = (await nativeImport("/pdfjs/pdf.min.js")) as PdfjsApi;
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.js";
  return pdfjs;
}

// custom items are user-added fields (label editable, deletable); known items
// are the spec's fields (label fixed, value resolved from the case).
type Item = { field: string; text: string; x: number; yTop: number; size: number; page: number; custom: boolean; label: string };

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

export function ReqFormCalibrator({
  source,
  onBack,
  values,
  customVals,
  onValueChange,
}: {
  // Calibrate from a case card ({ caseId } — previews the case's real values) or
  // from Settings ({ templateKey } — any template, no case attached).
  source: { caseId: string } | { templateKey: string };
  onBack: () => void;
  values?: Record<string, string | undefined>; // current dialog field values (your edits)
  customVals?: Record<string, string>; // current custom-field values
  // edits made here flow back to the dialog/generate so the printed PDF matches
  onValueChange?: (field: string, value: string, custom: boolean) => void;
}) {
  // captured once at mount — the values shown when you clicked Calibrate
  const live = useRef({ values: values ?? {}, customVals: customVals ?? {} });
  // stable id for the load effect — the object identity of `source` isn't.
  const sourceKey = "caseId" in source ? source.caseId : source.templateKey;
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const baseFields = useRef<FieldOverrides>({});
  const [scale, setScale] = useState(0); // px per native point
  const [cssH, setCssH] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  // bumped to force-remount the text input (on field switch / clear) so its
  // uncontrolled defaultValue refreshes — but NOT while typing, so the caret stays.
  const [inputRev, setInputRev] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ field: string; px: number; py: number; x0: number; y0: number; moved: boolean } | null>(null);

  // 1) Load template bytes + current positions, then render the page.
  const load = useCallback(async () => {
    setStatus("loading");
    setErr(null);
    setSaved(null);
    const r = await loadReqFormCalibration(source);
    if (!r.ok) {
      setErr(r.error);
      setStatus("error");
      return;
    }
    setLabel(r.label);
    setTemplateKey(r.templateKey);
    baseFields.current = r.fields;
    // Show your actual edited values (spaced dates, real name, custom field text)
    // so the overlay is a true preview — fall back to the resolved sample when a
    // field is blank so it stays placeable.
    const liveText = (it: { field: string; custom: boolean; text: string; label: string }) => {
      const v = it.custom ? live.current.customVals[it.field] : live.current.values[it.field];
      if (v != null && v.trim() !== "") return v;
      return it.custom ? it.label : it.text;
    };
    setItems(
      r.items.filter((it) => it.page === 0).map((it) => ({ ...it, text: liveText(it) })),
    );

    let phase = "load pdfjs";
    try {
      const pdfjs = await loadPdfjs();
      phase = "parse pdf";
      const doc = await pdfjs.getDocument({ data: b64ToBytes(r.templateBase64) }).promise;
      phase = "get page";
      const page = await doc.getPage(1);
      const native = page.getViewport({ scale: 1 }); // width/height in PDF points
      const s = TARGET_W / native.width;
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: s * dpr });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${native.width * s}px`;
      canvas.style.height = `${native.height * s}px`;
      phase = "render";
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      setScale(s);
      setCssH(native.height * s);
      setStatus("ready");
    } catch (e) {
      setErr(`[${phase}] ${e instanceof Error ? e.message : "Failed to render the template."}`);
      setStatus("error");
    }
    // key off the primitive id, not the (re-created each render) `source` object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const cssW = TARGET_W;
  const update = (field: string, patch: Partial<Item>) =>
    setItems((arr) => arr.map((it) => (it.field === field ? { ...it, ...patch } : it)));
  const sel = items.find((it) => it.field === selected) ?? null;

  // ── Drag (move a field) ───────────────────────────────────────────────────
  function onFieldDown(e: React.PointerEvent, it: Item) {
    e.stopPropagation();
    setSelected(it.field);
    setSaved(null);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { field: it.field, px: e.clientX, py: e.clientY, x0: it.x, y0: it.yTop, moved: false };
  }
  function onFieldMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || scale <= 0) return;
    const dx = (e.clientX - d.px) / scale;
    const dy = (e.clientY - d.py) / scale;
    if (Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) > 2) d.moved = true;
    update(d.field, { x: d.x0 + dx, yTop: d.y0 + dy });
  }
  function onFieldUp() {
    drag.current = null;
  }

  // ── Tap-to-place (set the selected field's start point) ───────────────────
  function onSvgDown(e: React.PointerEvent) {
    if (e.target !== svgRef.current || !sel || scale <= 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    update(sel.field, { x: (e.clientX - rect.left) / scale, yTop: (e.clientY - rect.top) / scale });
    setSaved(null);
  }

  // ── Keyboard: nudge position (arrows, Shift=10pt) + size ([ ] or − =) ──────
  function onKeyDown(e: React.KeyboardEvent) {
    if (!sel) return;
    const step = e.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    if (moves[e.key]) {
      e.preventDefault();
      update(sel.field, { x: sel.x + moves[e.key][0], yTop: sel.yTop + moves[e.key][1] });
    } else if (e.key === "[" || e.key === "-") {
      e.preventDefault();
      update(sel.field, { size: Math.max(6, sel.size - 1) });
    } else if (e.key === "]" || e.key === "=" || e.key === "+") {
      e.preventDefault();
      update(sel.field, { size: sel.size + 1 });
    } else if (e.key === "Escape") {
      setSelected(null);
    }
  }

  function resize(delta: number) {
    if (!sel) return;
    update(sel.field, { size: Math.max(6, sel.size + delta) });
    setSaved(null);
  }
  // Edit a field's displayed text. Update LOCAL state only while typing (keeps the
  // caret where it is — lifting to the parent on every keystroke makes the caret
  // jump to the end). Push the value up to the dialog on blur instead.
  function setText(it: Item, v: string) {
    update(it.field, { text: v });
    setSaved(null);
  }
  function liftText(it: Item) {
    onValueChange?.(it.field, it.text, it.custom);
  }
  function clearText(it: Item) {
    update(it.field, { text: "" });
    onValueChange?.(it.field, "", it.custom);
    setInputRev((r) => r + 1); // remount the uncontrolled input so it shows empty
    setSaved(null);
  }

  // ── Add / delete a user-defined field ─────────────────────────────────────
  function addField() {
    if (scale <= 0) return;
    const key = `c_${crypto.randomUUID().slice(0, 8)}`;
    const it: Item = {
      field: key, custom: true, label: "New field", text: "New field",
      x: (cssW * 0.28) / scale, yTop: (cssH * 0.22) / scale, size: 30, page: 0,
    };
    setItems((arr) => [...arr, it]);
    setSelected(key);
    setSaved(null);
  }
  function deleteField(field: string) {
    setItems((arr) => arr.filter((it) => it.field !== field));
    setSelected(null);
    setSaved(null);
  }

  // Split edits into spec-field position overrides + custom field definitions.
  function buildOverrides(): { fields: FieldOverrides; custom: CustomField[] } {
    const fields: FieldOverrides = { ...baseFields.current };
    const custom: CustomField[] = [];
    for (const it of items) {
      const pos = { x: Math.round(it.x), yTop: Math.round(it.yTop), size: Math.round(it.size) };
      if (it.custom) {
        custom.push({ key: it.field, label: it.label.trim() || "Field", page: it.page, ...pos });
      } else {
        fields[it.field as keyof FieldOverrides] = { ...fields[it.field as keyof FieldOverrides], ...pos };
      }
    }
    return { fields, custom };
  }

  async function save() {
    setSaving(true);
    setSaved(null);
    const { fields, custom } = buildOverrides();
    const r = await saveReqFormPositions(templateKey, fields, custom);
    setSaving(false);
    setSaved(r.ok ? "Saved — live on the next preview." : `Error: ${r.error}`);
  }
  async function copyJson() {
    await navigator.clipboard.writeText(JSON.stringify(buildOverrides(), null, 2));
    setSaved("Copied overrides JSON to clipboard.");
  }
  async function reset() {
    setSaving(true);
    await saveReqFormPositions(templateKey, {}, []); // clear overrides → back to specs.ts
    setSaving(false);
    await load();
  }

  return (
    <div className="flex flex-col" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-zinc-900">Calibrate · {label}</span>
          {sel ? (
            <span className="flex items-center gap-1.5 text-[12px] text-zinc-600">
              {sel.custom ? (
                <input
                  value={sel.label}
                  onChange={(e) => update(sel.field, { label: e.target.value })}
                  placeholder="Name"
                  title="Field name (saved to this template)"
                  className="w-24 rounded border border-emerald-400 bg-emerald-50 px-1.5 py-0.5 text-[12px] text-zinc-900"
                />
              ) : (
                <span className="rounded bg-indigo-100 px-1.5 py-0.5 font-medium text-indigo-700">{sel.field}</span>
              )}
              {/* the actual text stamped on the form — edit it here, live. UNCONTROLLED
                  (defaultValue + key) so the browser owns the caret; remounts only on
                  field-switch or clear, never while typing. */}
              <input
                key={`${selected}-${inputRev}`}
                defaultValue={sel.text}
                onChange={(e) => setText(sel, e.target.value)}
                onBlur={() => liftText(sel)}
                placeholder="Text…"
                title="Text printed on the form — add spaces, fix casing, etc."
                className="w-44 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-[12px] text-zinc-900"
              />
              <button type="button" onClick={() => clearText(sel)} title="Clear this field's text" className="rounded border border-zinc-300 px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-100">✕</button>
              <button type="button" onClick={() => resize(-1)} className="h-5 w-5 rounded border border-zinc-300 text-zinc-700 hover:bg-zinc-100">−</button>
              <span className="tabular-nums">{Math.round(sel.size)}pt</span>
              <button type="button" onClick={() => resize(1)} className="h-5 w-5 rounded border border-zinc-300 text-zinc-700 hover:bg-zinc-100">+</button>
              {sel.custom ? (
                <button type="button" onClick={() => deleteField(sel.field)} className="ml-1 rounded border border-rose-300 px-1.5 py-0.5 text-rose-600 hover:bg-rose-50">Delete</button>
              ) : null}
            </span>
          ) : (
            <span className="text-[12px] text-zinc-400">Tap a field · edit its text/size here · drag to move · tap page to set start · or add a field →</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={addField} disabled={status !== "ready"} className="rounded-md border border-emerald-500 bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50" title="Add a field you position and type yourself">+ Add field</button>
          <button type="button" onClick={onBack} className="rounded p-1 text-zinc-500 hover:bg-zinc-100" aria-label="Back">×</button>
        </div>
      </div>

      <div className="max-h-[68vh] overflow-auto bg-zinc-100 p-3">
        {status === "loading" ? <p className="px-2 py-8 text-center text-sm text-zinc-500">Loading template…</p> : null}
        {status === "error" ? <p className="m-2 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700">{err}</p> : null}
        <div className="relative mx-auto shadow-sm" style={{ width: cssW, height: cssH || undefined }}>
          <canvas ref={canvasRef} className="block bg-white" />
          {scale > 0 ? (
            <svg
              ref={svgRef}
              width={cssW}
              height={cssH}
              className="absolute inset-0"
              style={{ touchAction: "none", cursor: sel ? "crosshair" : "default" }}
              onPointerDown={onSvgDown}
            >
              {items.map((it) => {
                const active = it.field === selected;
                const shownText = it.text || it.label || it.field; // custom fields show label until a value is typed
                const fpx = it.size * scale;
                const w = Math.max(8, shownText.length * it.size * 0.52 * scale);
                // custom fields tint green so they're distinct from spec fields
                const hue = it.custom ? "16,185,129" : "99,102,241";
                return (
                  <g
                    key={it.field}
                    style={{ cursor: "move" }}
                    onPointerDown={(e) => onFieldDown(e, it)}
                    onPointerMove={onFieldMove}
                    onPointerUp={onFieldUp}
                  >
                    {/* grab/selection box around the glyph run (cap-top ≈ 0.72em above baseline) */}
                    <rect
                      x={it.x * scale - 1}
                      y={it.yTop * scale - fpx * 0.72}
                      width={w + 2}
                      height={fpx * 0.92}
                      fill={active ? `rgba(${hue},0.16)` : "transparent"}
                      stroke={active ? `rgb(${hue})` : `rgba(${hue},0.35)`}
                      strokeWidth={active ? 1 : 0.5}
                      rx={2}
                    />
                    <text
                      x={it.x * scale}
                      y={it.yTop * scale}
                      fontSize={fpx}
                      fontFamily="Helvetica, Arial, sans-serif"
                      fill="#000"
                      style={{ userSelect: "none" }}
                    >
                      {shownText}
                    </text>
                  </g>
                );
              })}
            </svg>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onBack} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50">← Back to edit</button>
          <button type="button" onClick={reset} disabled={saving || status !== "ready"} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 disabled:opacity-50">Reset to defaults</button>
        </div>
        <div className="flex items-center gap-2">
          {saved ? <span className="text-[12px] text-zinc-500">{saved}</span> : null}
          <button type="button" onClick={copyJson} disabled={status !== "ready"} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">Copy JSON</button>
          <button type="button" onClick={save} disabled={saving || status !== "ready"} className="rounded-md border border-indigo-600 bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {saving ? "Saving…" : "Save positions"}
          </button>
        </div>
      </div>
    </div>
  );
}
