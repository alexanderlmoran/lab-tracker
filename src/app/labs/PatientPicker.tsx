"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import type { LabCase } from "@/lib/types";
import {
  searchPatients,
  type PatientSuggestion,
} from "./patient-search-action";
import { useDismiss } from "./use-dismiss";

const inputClass =
  "mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10";
const labelClass = "block text-xs font-medium text-zinc-700";

/**
 * Patient name + email inputs with a typeahead that searches existing
 * patients in our own lab_cases table. Selecting a suggestion fills name +
 * email (and carries forward the patient's phone / DOB silently as hidden
 * inputs so they're not lost on re-save). Phone / address stay hidden per UX
 * decision 2026-05-12.
 *
 * `editableDob` surfaces a visible DOB date input (backlog #23). On edit, the
 * saved value propagates to the whole patient (all cases + patients_seed) so
 * req forms etc. can reuse it — see updateLabCase. When false the DOB rides as
 * a hidden input as before.
 */
export function PatientPicker({
  initial,
  editableDob = false,
}: {
  initial?: LabCase | null;
  editableDob?: boolean;
}) {
  const v = initial ?? null;
  const listboxId = useId();

  const [name, setName] = useState(v?.patient_name ?? "");
  const [email, setEmail] = useState(v?.patient_email ?? "");
  const [phone, setPhone] = useState(v?.patient_phone ?? "");
  const [dob, setDob] = useState(v?.patient_dob ?? "");
  /** Becomes true after the user picks a suggestion, so we can show a
   * "loaded from prior visit" cue. Cleared as soon as they edit the email
   * field manually (signals they're typing a different patient). */
  const [prefilled, setPrefilled] = useState(false);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PatientSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [, startSearch] = useTransition();

  const containerRef = useRef<HTMLDivElement | null>(null);

  // Debounced lookup. 200ms is enough to feel instant without firing on
  // every keystroke for a slow typer.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const handle = setTimeout(() => {
      startSearch(async () => {
        const r = await searchPatients({ query });
        if (r.ok) setResults(r.data ?? []);
      });
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  // Close the suggestion list when the user clicks outside the picker.
  useDismiss(containerRef, open, () => {
    setOpen(false);
    setActiveIdx(-1);
  });

  function applySuggestion(s: PatientSuggestion) {
    if (s.name) setName(s.name);
    if (s.email) setEmail(s.email);
    setPhone(s.phone ?? "");
    setDob(s.dobIso ?? "");
    setPrefilled(true);
    setOpen(false);
    setActiveIdx(-1);
    setQuery("");
  }

  function onNameChange(next: string) {
    setName(next);
    setQuery(next);
    setOpen(true);
    setActiveIdx(-1);
    // Editing the name after a prefill almost always means a different
    // patient — drop the "loaded from prior visit" cue.
    if (prefilled) setPrefilled(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      applySuggestion(results[activeIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setActiveIdx(-1);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:col-span-2">
      <div className="relative sm:col-span-2" ref={containerRef}>
        <label htmlFor="patientName" className={labelClass}>
          Name <span className="text-red-600">*</span>
          <span className="ml-2 text-[10px] font-normal text-zinc-400">
            type to search past patients
          </span>
        </label>
        <input
          id="patientName"
          name="patientName"
          required
          maxLength={200}
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={
            activeIdx >= 0 ? `${listboxId}-opt-${activeIdx}` : undefined
          }
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          onFocus={() => name.length >= 2 && setOpen(true)}
          onKeyDown={onKeyDown}
          className={inputClass}
        />
        {open && results.length > 0 ? (
          <ul
            id={listboxId}
            role="listbox"
            className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-auto rounded-md border border-zinc-200 bg-white shadow-lg"
          >
            {results.map((s, i) => (
              <li
                key={s.key}
                id={`${listboxId}-opt-${i}`}
                role="option"
                aria-selected={i === activeIdx}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySuggestion(s);
                }}
                onMouseEnter={() => setActiveIdx(i)}
                className={`cursor-pointer px-3 py-2 text-sm ${
                  i === activeIdx ? "bg-zinc-100" : "hover:bg-zinc-50"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-zinc-900">
                    {s.name ?? "—"}
                  </span>
                  {s.seededOnly ? (
                    <span
                      className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                      title="In the seed list but no prior lab case — this would be their first."
                    >
                      no prior labs
                    </span>
                  ) : null}
                </div>
                <div className="text-xs text-zinc-500">
                  {s.email ?? "no email on file"}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="sm:col-span-2">
        <label htmlFor="patientEmail" className={labelClass}>
          Email <span className="text-red-600">*</span>
          {prefilled ? (
            <span
              className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800"
              title={
                "Loaded from prior visit — phone" +
                (dob ? " and DOB" : "") +
                " carried over silently."
              }
            >
              ✓ prior visit
              {phone || dob ? (
                <span className="ml-1 font-normal text-emerald-700">
                  ({[phone ? "phone" : null, dob ? "DOB" : null]
                    .filter(Boolean)
                    .join(" + ")}{" "}
                  on file)
                </span>
              ) : null}
            </span>
          ) : null}
        </label>
        <input
          id="patientEmail"
          name="patientEmail"
          type="email"
          required
          maxLength={200}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (prefilled) setPrefilled(false);
          }}
          className={inputClass}
        />
      </div>

      {/* DOB: editable on the edit-case form (#23) so it saves to the patient
          and feeds req forms; otherwise hidden to preserve a pre-filled value
          without blowing away historical data. Phone stays hidden either way. */}
      {editableDob ? (
        <div className="sm:col-span-2">
          <label htmlFor="patientDob" className={labelClass}>
            Date of birth{" "}
            <span className="font-normal text-zinc-400">
              (saves to the patient — reused by req forms)
            </span>
          </label>
          <input
            id="patientDob"
            name="patientDob"
            type="date"
            value={dob}
            onChange={(e) => setDob(e.target.value)}
            className={inputClass}
          />
        </div>
      ) : (
        <input type="hidden" name="patientDob" value={dob} readOnly />
      )}
      <input type="hidden" name="patientPhone" value={phone} readOnly />
    </div>
  );
}
