"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  enqueueIvPost,
  saveIvChart,
  type ComponentRow,
  type IvChart,
  type IvSessionDetail,
  type Vitals,
} from "../actions";
import { ivChartMissing, QUICK_FILL_NORMAL } from "../chart-util";

const INPUT =
  "w-full rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none";
const LABEL = "text-xs font-medium text-zinc-600";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-zinc-900">{title}</h2>
      {children}
    </section>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-zinc-800">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-zinc-900" />
      {label}
    </label>
  );
}

function VitalsGrid({ value, onChange }: { value: Vitals; onChange: (v: Vitals) => void }) {
  const fields: Array<[keyof Vitals, string, string]> = [
    ["bp", "Blood Pressure", "120/80"],
    ["spo2", "SpO₂", "99"],
    ["temp", "Temp", "98.6"],
    ["hr", "Heart Rate", "72"],
    ["resp", "Respirations", "16"],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {fields.map(([k, lbl, ph]) => (
        <div key={k}>
          <div className={LABEL}>{lbl}</div>
          <input className={INPUT} value={value[k] ?? ""} placeholder={ph} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />
        </div>
      ))}
    </div>
  );
}

const RADIO = "flex flex-wrap gap-2";
function RadioRow<T extends string>({ options, value, onChange }: { options: Array<[T, string]>; value: T | undefined; onChange: (v: T) => void }) {
  return (
    <div className={RADIO}>
      {options.map(([v, lbl]) => (
        <button key={v} type="button" onClick={() => onChange(v)} className={`rounded border px-3 py-1 text-sm ${value === v ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 text-zinc-700 hover:bg-zinc-100"}`}>
          {lbl}
        </button>
      ))}
    </div>
  );
}

export function IvChartForm({ session }: { session: IvSessionDetail }) {
  const [chart, setChart] = useState<IvChart>(() => {
    const c = (session.chart ?? {}) as IvChart;
    return {
      assessment: c.assessment ?? {},
      preVitals: c.preVitals ?? {},
      postVitals: c.postVitals ?? {},
      ivStart: c.ivStart ?? {},
      attempts: c.attempts,
      location: c.location,
      infusionFlowingWell: c.infusionFlowingWell,
      components: c.components?.length ? c.components : [{ name: "", standardDose: "", addOnDose: "", lot: "", exp: "" }],
      infusionReaction: c.infusionReaction ?? { occurred: false },
      ivRemoval: c.ivRemoval,
      pc: c.pc ?? {},
      notes: c.notes ?? "",
    };
  });
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  const set = (patch: Partial<IvChart>) => setChart((c) => ({ ...c, ...patch }));
  const setComp = (i: number, patch: Partial<ComponentRow>) =>
    setChart((c) => ({ ...c, components: (c.components ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  // Quick fill: stamp the "normal visit" boilerplate (assessment, cath, attempts,
  // location, flowing, no reaction, removed) without touching vitals/components.
  const quickFill = () => setChart((c) => ({ ...c, ...QUICK_FILL_NORMAL, assessment: { ...c.assessment, ...QUICK_FILL_NORMAL.assessment } }));
  const missing = ivChartMissing(chart);

  function save(markReady: boolean) {
    setError(null);
    startTransition(async () => {
      try {
        await saveIvChart(session.id, chart, { markReady });
        setSavedAt(new Date().toLocaleTimeString());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function chartAndPost() {
    setError(null);
    startTransition(async () => {
      try {
        await saveIvChart(session.id, chart, { markReady: true });
        await enqueueIvPost(session.id);
        setSavedAt(new Date().toLocaleTimeString());
        setQueued(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  const isPc = session.kind === "pc";
  const isEbo = session.kind === "ebo";
  const a = chart.assessment ?? {};

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link href="/labs/iv" className="text-xs text-zinc-500 hover:text-zinc-800">← IV Charting</Link>
          <h1 className="text-lg font-semibold text-zinc-900">{session.patient_full_name || "—"}</h1>
          <p className="text-sm text-zinc-600">
            {session.service_name}
            {session.therapist_name ? ` · ${session.therapist_name}` : ""}
            {session.start_at ? ` · ${session.start_at.replace("T", " ").slice(0, 16)}` : ""}
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Template: {isPc ? "Phosphatidylcholine Infusion" : session.template_hint || "—"} · status: {session.charting_status}
          </p>
        </div>
        <button
          type="button"
          onClick={quickFill}
          className="shrink-0 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
          title="Stamp the normal-visit defaults (assessment, 22ga, 1 attempt, R antecubital, flowing, no reaction, removed)"
        >
          ⚡ Quick fill (normal)
        </button>
      </div>

      {isPc && (
        <Section title="Phosphatidylcholine Infusion">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className={LABEL}>Infusion #</div>
              <input className={INPUT} type="number" value={chart.pc?.infusionNumber ?? ""} placeholder="e.g. 30" onChange={(e) => set({ pc: { ...chart.pc, infusionNumber: e.target.value ? Number(e.target.value) : null } })} />
            </div>
            <div>
              <div className={LABEL}># Vials</div>
              <input className={INPUT} value={chart.pc?.vialCount ?? ""} placeholder="e.g. 20+2" onChange={(e) => set({ pc: { ...chart.pc, vialCount: e.target.value } })} />
            </div>
          </div>
        </Section>
      )}

      <Section title="Initial Assessment">
        <div className="grid gap-2 sm:grid-cols-2">
          <Check label="Initial check-in" checked={!!a.initialCheckIn} onChange={(v) => set({ assessment: { ...a, initialCheckIn: v } })} />
          <Check label="Risks & benefits discussed" checked={!!a.risksDiscussed} onChange={(v) => set({ assessment: { ...a, risksDiscussed: v } })} />
          <Check label="Consent / liability signed" checked={!!a.consentSigned} onChange={(v) => set({ assessment: { ...a, consentSigned: v } })} />
          <Check label="Health intake signed" checked={!!a.intakeSigned} onChange={(v) => set({ assessment: { ...a, intakeSigned: v } })} />
          <Check label="Medical history & meds discussed" checked={!!a.historyDiscussed} onChange={(v) => set({ assessment: { ...a, historyDiscussed: v } })} />
        </div>
      </Section>

      <Section title="Pre-Infusion Vitals">
        <VitalsGrid value={chart.preVitals ?? {}} onChange={(v) => set({ preVitals: v })} />
      </Section>

      <Section title="IV Start">
        <div className="space-y-3">
          <div>
            <div className={LABEL}>Catheter size</div>
            <RadioRow options={[["20", "20"], ["22", "22"], ["picc", "PICC Line"]]} value={chart.ivStart?.cath} onChange={(v) => set({ ivStart: { cath: v } })} />
          </div>
          <div>
            <div className={LABEL}>Attempts</div>
            <RadioRow options={[["1", "1"], ["2", "2"], ["already", "Already inserted"]]} value={chart.attempts} onChange={(v) => set({ attempts: v })} />
          </div>
          <div>
            <div className={LABEL}>Location</div>
            <RadioRow options={[["right_antecubital", "R Antecubital"], ["left_antecubital", "L Antecubital"], ["left_arm", "L Arm"]]} value={chart.location || undefined} onChange={(v) => set({ location: v })} />
          </div>
          <Check label="Infusion flowing well, no pain/swelling/irritation; no allergic reaction" checked={!!chart.infusionFlowingWell} onChange={(v) => set({ infusionFlowingWell: v })} />
        </div>
      </Section>

      <Section title="Components">
        <div className="space-y-2">
          <div className="hidden grid-cols-[1fr_110px_110px_24px] gap-2 text-[11px] font-medium text-zinc-500 sm:grid">
            <span>Product</span><span>Std dose</span><span>Add-on</span><span />
          </div>
          {(chart.components ?? []).map((r, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_110px_110px_24px]">
              <input className={INPUT} placeholder="Product" value={r.name ?? ""} onChange={(e) => setComp(i, { name: e.target.value })} />
              <input className={INPUT} placeholder="Std dose" value={r.standardDose ?? ""} onChange={(e) => setComp(i, { standardDose: e.target.value })} />
              <input className={INPUT} placeholder="Add-on" value={r.addOnDose ?? ""} onChange={(e) => setComp(i, { addOnDose: e.target.value })} />
              <button type="button" aria-label="Remove row" className="text-zinc-400 hover:text-red-600" onClick={() => set({ components: (chart.components ?? []).filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <button type="button" className="text-xs font-medium text-zinc-600 hover:text-zinc-900" onClick={() => set({ components: [...(chart.components ?? []), { name: "", standardDose: "", addOnDose: "" }] })}>
            + Add component
          </button>
          <p className="text-[11px] text-zinc-400">This table is exactly what posts to the PB note — enter each component given, with its dose. (Lot # / stock tracking is coming separately.)</p>
        </div>
      </Section>

      <Section title="IM Medication (if given)">
        <div className="space-y-2">
          <Check label="IM shot given" checked={!!chart.imShotGiven} onChange={(v) => set({ imShotGiven: v })} />
          {chart.imShotGiven && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <input className={INPUT} placeholder="Medication (e.g. B12)" value={chart.imMedication?.name ?? ""} onChange={(e) => set({ imMedication: { ...chart.imMedication, name: e.target.value } })} />
              <input className={INPUT} placeholder="Dose" value={chart.imMedication?.dose ?? ""} onChange={(e) => set({ imMedication: { ...chart.imMedication, dose: e.target.value } })} />
              <input className={INPUT} placeholder="Location (e.g. left deltoid)" value={chart.imMedication?.location ?? ""} onChange={(e) => set({ imMedication: { ...chart.imMedication, location: e.target.value } })} />
            </div>
          )}
        </div>
      </Section>

      <Section title="Infusion Reaction & Removal">
        <div className="space-y-2">
          <Check label="Infusion reaction occurred" checked={!!chart.infusionReaction?.occurred} onChange={(v) => set({ infusionReaction: { ...chart.infusionReaction, occurred: v } })} />
          {chart.infusionReaction?.occurred && (
            <input className={INPUT} placeholder="Reaction details" value={chart.infusionReaction?.note ?? ""} onChange={(e) => set({ infusionReaction: { ...chart.infusionReaction, note: e.target.value } })} />
          )}
          <Check label="IV removed — catheter intact, pressure dressing placed, no reaction" checked={!!chart.ivRemoval} onChange={(v) => set({ ivRemoval: v })} />
        </div>
      </Section>

      <Section title="Post-Infusion Vitals">
        <VitalsGrid value={chart.postVitals ?? {}} onChange={(v) => set({ postVitals: v })} />
      </Section>

      <Section title="Notes">
        <textarea className={`${INPUT} min-h-[64px]`} value={chart.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} placeholder="Optional free-text notes" />
      </Section>

      {/* Actions */}
      <div className="sticky bottom-0 -mx-4 flex items-center gap-3 border-t border-zinc-200 bg-zinc-50/95 px-4 py-3 backdrop-blur">
        <button type="button" disabled={pending} onClick={() => save(false)} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-50">
          {pending ? "Saving…" : "Save draft"}
        </button>
        <button type="button" disabled={pending} onClick={() => save(true)} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-50">
          Mark charted
        </button>
        {isEbo ? (
          <span className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900">
            EBOO/EBO2 are charted manually in PB — auto-post disabled.
          </span>
        ) : (
          <button type="button" disabled={pending} onClick={chartAndPost} className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50">
            Chart & post to PB
          </button>
        )}
        {!isEbo && missing.length > 0 && !queued && !error && (
          <span className="text-xs text-amber-700">⚠ Posts anyway, flagged incomplete — still to fill: {missing.join(", ")}.</span>
        )}
        {queued && !error && <span className="text-xs text-green-700">Queued — worker grades the patient match (auto-posts at ≥95, else holds for review).{missing.length ? " Flagged incomplete." : ""}</span>}
        {savedAt && !queued && !error && <span className="text-xs text-green-700">Saved {savedAt}</span>}
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </div>
  );
}
