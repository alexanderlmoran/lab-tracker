"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import type { LabCase } from "@/lib/types";
import {
  searchPBClients,
  type PBClientSuggestion,
} from "./patient-search-action";

const inputClass =
  "mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10";
const labelClass = "block text-xs font-medium text-zinc-700";

function formatName(s: PBClientSuggestion): string {
  return [s.firstName, s.lastName].filter(Boolean).join(" ").trim() || "—";
}

/**
 * Patient inputs (name/email/phone/DOB) with a typeahead that queries the
 * cached PB client list. Selecting a suggestion fills all four fields plus
 * the hidden `practiceBetterRecordId` so the case is pre-linked to PB. Users
 * can still edit any field after selection — useful for the rare case where
 * PB has a typo or stale info.
 *
 * Why a single component instead of four separate inputs: the autocomplete
 * needs to write into all four at once, and threading that through bare HTML
 * inputs in CaseFormFields would couple form layout to fetch state.
 */
export function PatientPicker({ initial }: { initial?: LabCase | null }) {
  const v = initial ?? null;
  const listboxId = useId();

  const [name, setName] = useState(v?.patient_name ?? "");
  const [email, setEmail] = useState(v?.patient_email ?? "");
  const [phone, setPhone] = useState(v?.patient_phone ?? "");
  const [dob, setDob] = useState(v?.patient_dob ?? "");
  const [recordId, setRecordId] = useState(v?.practicebetter_record_id ?? "");

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PBClientSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [, startSearch] = useTransition();

  const containerRef = useRef<HTMLDivElement | null>(null);
  // Track the latest in-flight query so a slower earlier response can't
  // overwrite a faster later response (race fix without AbortController,
  // which server actions don't expose).
  const latestQueryRef = useRef("");

  // Debounce the network search — fire 250ms after the user stops typing.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const handle = setTimeout(() => {
      latestQueryRef.current = query;
      startSearch(async () => {
        const r = await searchPBClients({ query });
        if (latestQueryRef.current !== query) return;
        if (r.ok) setResults(r.data ?? []);
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  // Close the suggestion panel on outside click.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setActiveIdx(-1);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function applySuggestion(s: PBClientSuggestion) {
    const fullName = formatName(s);
    setName(fullName);
    if (s.email) setEmail(s.email);
    if (s.phone) setPhone(s.phone);
    if (s.dobIso) setDob(s.dobIso);
    setRecordId(s.recordId);
    setOpen(false);
    setActiveIdx(-1);
    setQuery("");
  }

  function onNameChange(next: string) {
    setName(next);
    setQuery(next);
    setOpen(true);
    setActiveIdx(-1);
    // If the user types a new name after a previous selection, clear the PB
    // link — it almost certainly no longer applies. Don't clear email/phone
    // automatically; they may want to keep reusing those.
    if (recordId) setRecordId("");
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
            type to search Practice Better
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
                key={s.recordId}
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
                <div className="font-medium text-zinc-900">{formatName(s)}</div>
                <div className="text-xs text-zinc-500">
                  {s.email ?? "no email on file"}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div>
        <label htmlFor="patientEmail" className={labelClass}>
          Email <span className="text-red-600">*</span>
        </label>
        <input
          id="patientEmail"
          name="patientEmail"
          type="email"
          required
          maxLength={200}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="patientPhone" className={labelClass}>
          Phone
        </label>
        <input
          id="patientPhone"
          name="patientPhone"
          type="tel"
          maxLength={40}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="patientDob" className={labelClass}>
          DOB
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

      <input
        type="hidden"
        name="practiceBetterRecordId"
        value={recordId}
        readOnly
      />
    </div>
  );
}
