"use client";

// Settings home for the requisition-form calibrator. Pick a lab template and
// the same visual ReqFormCalibrator used on a case card opens here — drag/size/
// add fields and Save, with no case attached (sample text fills the preview).
// Lets staff calibrate + test positions anytime, not just while a case is open.

import { useEffect, useState, useTransition } from "react";
import { ReqFormCalibrator } from "../ReqFormCalibrator";
import { listReqFormTemplates } from "../req-form-actions";

type Template = { templateKey: string; label: string };

export function ReqFormsPanel() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    start(async () => {
      const r = await listReqFormTemplates();
      if (r.ok) setTemplates(r.templates);
      else setErr("Couldn't load requisition templates.");
    });
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {pending && !templates.length ? (
          <span className="text-xs text-zinc-500">Loading templates…</span>
        ) : (
          templates.map((t) => (
            <button
              key={t.templateKey}
              type="button"
              onClick={() => setActive(t.templateKey)}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                active === t.templateKey
                  ? "border-indigo-600 bg-indigo-600 text-white"
                  : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              {t.label}
            </button>
          ))
        )}
      </div>
      {err ? (
        <p className="rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[12px] text-rose-700">{err}</p>
      ) : null}

      {active ? (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
          {/* keyed by template so switching tabs fully remounts the calibrator */}
          <ReqFormCalibrator key={active} source={{ templateKey: active }} onBack={() => setActive(null)} />
        </div>
      ) : (
        <p className="text-xs text-zinc-500">
          Pick a lab to drag its requisition fields into place. Saved positions go live on the next
          “Print req form” — no deploy.
        </p>
      )}
    </div>
  );
}
