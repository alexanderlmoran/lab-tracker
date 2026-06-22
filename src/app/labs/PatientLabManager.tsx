"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LabCase, StepNumber } from "@/lib/types";
import {
  COLUMN_LABEL,
  LAB_BOARD_COLUMN_ORDER,
  type ColumnKey,
  caseWithStepsThrough,
  getColumnFor,
} from "@/lib/columns";
import { planColumnJump, isColumnJumpTarget } from "@/lib/column-jump";
import { probeKeyForLab } from "@/lib/scrapers/normalize-lab";
import { normalizeScannedTracking } from "@/lib/tracking/normalize";
import { labelForCase, panelFor } from "@/lib/labs/label";
import { LabCombobox } from "./LabCombobox";
import {
  bulkSetStepCompleted,
  bulkUpdatePatientCases,
  createLabCases,
  deleteLabCase,
  listPatientCases,
  setStepCompleted,
} from "./actions";
import { probeCaseResult } from "./probe-actions";
import { BarcodeScanner } from "./BarcodeScanner";

// Editable view of one existing case. We keep the originals alongside so Save
// only writes the fields the operator actually changed (matches updateLabCase).
type RowEdit = {
  caseId: string;
  who: string;
  labLabel: string;
  tracking: string;
  accession: string;
  collection: string;
  origTracking: string;
  origAccession: string;
  origCollection: string;
  column: string;
  step1Done: boolean;
  labName: string;
  probe: { state: "idle" | "loading" | "done"; msg: string | null };
};

// A lab being added to this patient (goes through createLabCases on save).
type NewLab = {
  key: number;
  /** Which person this lab is for (families share one email → one card). */
  who: string;
  labName: string;
  labPanel: string | null;
  partialExpected: boolean;
  accession: string;
  noAccession: boolean;
  tracking: string;
  collection: string;
};

const s = (v: string | null | undefined) => v ?? "";
const normName = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();

function toRowEdit(c: LabCase): RowEdit {
  return {
    caseId: c.id,
    who: c.patient_name,
    labLabel: labelForCase(c),
    tracking: s(c.tracking_number),
    accession: s(c.lab_external_ref),
    collection: s(c.collection_date),
    origTracking: s(c.tracking_number),
    origAccession: s(c.lab_external_ref),
    origCollection: s(c.collection_date),
    column: COLUMN_LABEL[getColumnFor(c)],
    step1Done: Boolean(c.step1_sample_sent),
    labName: c.lab_name,
    probe: { state: "idle", msg: null },
  };
}

const inputCls =
  "w-full rounded border border-zinc-300 bg-white px-1.5 py-1 text-[12px] text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none";

// Columns a lab can be MOVED to (reaching them ticks a step). The derived lanes
// — TO DO / Ready to Ship / Pending Upload — follow from tracking/results and
// have no step to flip, so they're never move targets (same rule as the board).
const JUMP_TARGETS: ColumnKey[] = LAB_BOARD_COLUMN_ORDER.filter((c) => isColumnJumpTarget(c));

/**
 * "Manage labs" — a per-patient grid for editing tracking #, accession, and
 * collection date across all of a patient's labs at once, stamping one tracking
 * # / collection date across them ("shipped together"), and adding more labs
 * without re-typing patient info — in one Save. Save writes only what changed
 * and never marks anything sent (adding a tracking # leaves the card in "Ready
 * to ship"); the separate blue button marks the in-scope labs Sample sent.
 * Collapses the ~6-clicks-per-card edit loop into a single screen.
 */
export function ManageLabsButton({
  patientName,
  patientEmail,
  cases,
  variant = "chip",
}: {
  patientName: string;
  patientEmail: string;
  /** Preloaded cases (patient board groups already have them). When omitted,
   * the button fetches the patient's labs by email on open — so it can live
   * anywhere (lab board card detail, the full case page) without threading
   * the sibling cases through. */
  cases?: LabCase[];
  /** "chip" = tiny outline button (patient card header); "button" = a normal
   * button for the case detail / edit surface. */
  variant?: "chip" | "button";
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<RowEdit[]>([]);
  const [srcCases, setSrcCases] = useState<LabCase[]>([]);
  const [loading, setLoading] = useState(false);
  const [newLabs, setNewLabs] = useState<NewLab[]>([]);
  const [bulkTracking, setBulkTracking] = useState("");
  const [bulkAccession, setBulkAccession] = useState("");
  const [bulkCollection, setBulkCollection] = useState("");
  // A long-tenured patient can accumulate dozens of labs across many draw days;
  // `groupFilter` narrows the grid (and every bulk action) to one collection
  // date so a fresh shipment isn't lost in the history. "" = show all.
  const [groupFilter, setGroupFilter] = useState("");
  // Narrow the grid to one kanban column (TO DO / Ready to Ship / …) alongside
  // the date filter — so a fresh shipment or a specific lane is easy to act on.
  const [columnFilter, setColumnFilter] = useState("");
  // Optional header sort (Collected / Acc# / Status), display-only.
  const [sort, setSort] = useState<{ key: "lab" | "collection" | "accession" | "column"; dir: "asc" | "desc" } | null>(null);
  // Inline two-step delete confirm — replaces window.confirm(), which is
  // unreliable inside a modal <dialog> (it can silently return false, which
  // reads as "the delete won't work, I had to leave the modal to delete").
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  // A pending "move this lab to another status" awaiting its inline confirm
  // (moving to Complete Uploaded / ROF Scheduled alerts Nadia·Allison — surfaced
  // before Move; patient emails never auto-fire from a move).
  const [moveRow, setMoveRow] = useState<{ caseId: string; target: ColumnKey } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  // Which field a barcode scan should fill. `id` is a caseId for existing rows
  // or `new:<key>` for an add-lab row; `field` is which input it lands in.
  const [scan, setScan] = useState<{ id: string; field: "tracking" | "accession" } | null>(null);
  const newKey = useRef(1);

  // A patient card groups by email, so a family on one shared email (e.g. kids
  // under a parent's address) lands here as several distinct names. When that
  // happens, show a "Who" column + row checkboxes so apply-to-all can be scoped
  // to one person (their accession differs from a sibling's).
  const multiName = useMemo(
    () => new Set(rows.map((r) => normName(r.who))).size > 1,
    [rows],
  );
  // Distinct people in this group (a family on a shared email), display-cased —
  // the "Who" options when adding a lab to a multi-person card.
  const personNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      const k = normName(r.who);
      if (!seen.has(k)) seen.set(k, r.who);
    }
    return [...seen.values()];
  }, [rows]);

  // Distinct collection dates ("collection groups") present in this patient's
  // labs, newest first; rows with no date collapse into one "— no date —"
  // bucket. Drives the date filter (only shown when there's >1 group).
  const NO_DATE = "__none__";
  const groups = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) seen.add(r.collection.trim() || NO_DATE);
    return [...seen].sort((a, b) =>
      a === NO_DATE ? 1 : b === NO_DATE ? -1 : b.localeCompare(a),
    );
  }, [rows]);
  // The filter actually in force: ignore a stale group that no longer exists
  // (its last lab was deleted, or a date edit moved every row out of it) so the
  // grid falls back to "all" instead of stranding the operator on an empty view
  // — derived during render, no effect needed.
  const effectiveGroup = groupFilter && groups.includes(groupFilter) ? groupFilter : "";

  // Distinct kanban columns present, in board order — drives the column filter
  // (only shown when there's more than one lane to choose between).
  const columns = useMemo(() => {
    const order = LAB_BOARD_COLUMN_ORDER.map((k) => COLUMN_LABEL[k]);
    const seen = new Set(rows.map((r) => r.column));
    return order.filter((label) => seen.has(label));
  }, [rows]);
  const effectiveColumn = columnFilter && columns.includes(columnFilter) ? columnFilter : "";

  // Rows shown after the date + column filters. Everything downstream (the grid,
  // apply-to-all, the bulk actions) operates on these so a filtered view can't
  // touch a lab the operator can't see.
  const visibleRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          (!effectiveGroup || (r.collection.trim() || NO_DATE) === effectiveGroup) &&
          (!effectiveColumn || r.column === effectiveColumn),
      ),
    [rows, effectiveGroup, effectiveColumn],
  );
  const anyFilter = effectiveGroup !== "" || effectiveColumn !== "";

  // Display sort (membership unchanged, so bulk-action scoping still keys off
  // visibleRows). Status sorts by board order so "up the chain" reads top-down.
  const colRank = useMemo(() => {
    const order = LAB_BOARD_COLUMN_ORDER.map((k) => COLUMN_LABEL[k]);
    return (label: string) => {
      const i = order.indexOf(label);
      return i === -1 ? order.length : i;
    };
  }, []);
  const sortedRows = useMemo(() => {
    if (!sort) return visibleRows;
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (r: RowEdit) =>
      sort.key === "lab"
        ? r.labLabel.toLowerCase()
        : sort.key === "collection"
          ? r.collection || ""
          : sort.key === "accession"
            ? r.accession.toLowerCase()
            : String(colRank(r.column)).padStart(3, "0");
    return [...visibleRows].sort((a, b) => val(a).localeCompare(val(b)) * dir);
  }, [visibleRows, sort, colRank]);

  // Seed editable state each time the dialog opens, so a re-open after a save
  // reflects the refreshed rows (no stale edits linger). Uses preloaded cases
  // when given, else fetches the patient's labs by email.
  function seed(list: LabCase[]) {
    setSrcCases(list);
    setRows(list.map(toRowEdit));
  }
  function openDialog() {
    setNewLabs([]);
    setBulkTracking("");
    setBulkAccession("");
    setBulkCollection("");
    setGroupFilter("");
    setColumnFilter("");
    setSort(null);
    setConfirmDel(null);
    setMoveRow(null);
    setSelected(new Set());
    setError(null);
    setOpen(true);
    queueMicrotask(() => dialogRef.current?.showModal());
    if (cases && cases.length > 0) {
      seed(cases);
      return;
    }
    setRows([]);
    setSrcCases([]);
    setLoading(true);
    listPatientCases(patientEmail.toLowerCase())
      .then((list) => seed(list))
      .catch(() => setError("Could not load this patient's labs."))
      .finally(() => setLoading(false));
  }
  function closeDialog() {
    dialogRef.current?.close();
    setOpen(false);
  }
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onClose = () => setOpen(false);
    el.addEventListener("close", onClose);
    return () => el.removeEventListener("close", onClose);
  }, []);

  function patchRow(caseId: string, patch: Partial<RowEdit>) {
    setRows((rs) => rs.map((r) => (r.caseId === caseId ? { ...r, ...patch } : r)));
  }

  // Header sort (Collected / Acc# / Status) — click cycles asc → desc → off.
  function toggleSort(key: "lab" | "collection" | "accession" | "column") {
    setSort((s) => (s?.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null));
  }
  const sortArrow = (key: string) => (sort?.key === key ? (sort.dir === "asc" ? " ↑" : " ↓") : "");

  // A barcode came back — drop it into whichever field opened the scanner.
  function applyScan(code: string) {
    const target = scan;
    setScan(null);
    if (!target) return;
    // A FedEx label's big barcode is the 34-digit "96" string — slice out the
    // real tracking number. Accession barcodes pass through untouched.
    const value =
      target.field === "tracking" ? normalizeScannedTracking(code) : code.trim();
    if (!value) return;
    if (target.id.startsWith("new:")) {
      const key = Number(target.id.slice(4));
      patchNewLab(key, target.field === "tracking" ? { tracking: value } : { accession: value });
    } else {
      patchRow(target.id, target.field === "tracking" ? { tracking: value } : { accession: value });
    }
  }

  // Soft-delete a row (recoverable from Settings → Deleted). Writes immediately
  // — there's no "undo on cancel" — then drops it from the grid. Gated by an
  // inline confirm (setConfirmDel) rather than window.confirm().
  function performDelete(caseId: string) {
    setConfirmDel(null);
    startSave(async () => {
      const r = await deleteLabCase(caseId);
      if (!r.ok) {
        setError(r.error ?? "Could not delete");
        return;
      }
      setRows((rs) => rs.filter((row) => row.caseId !== caseId));
      setSrcCases((cs) => cs.filter((c) => c.id !== caseId));
      router.refresh();
    });
  }

  // Staff-alert side-effects a move to `target` would fire (surfaced before the
  // operator confirms). NOTE: patient-facing emails are NOT auto-sent by a step
  // toggle — they fire only via the explicit Send-email button (see
  // setStepCompleted, backlog #11) — so the only auto side-effects are the Nadia
  // (step 5) and Allison (step 6) staff alerts, gated on the move's target step.
  function moveWarning(c: LabCase, target: ColumnKey): string | null {
    const plan = planColumnJump(c, target).filter((p) => !p.alreadyComplete);
    const bits = [
      plan.some((p) => p.step === 5) && "alerts Nadia (once all the patient's labs reach here)",
      plan.some((p) => p.step === 6) && "alerts Allison + closes the protocol step",
    ].filter(Boolean) as string[];
    return bits.length ? `⚠ ${bits.join(" + ")}` : null;
  }

  // Move a lab to another status — the SAME mechanism as a board drag-drop
  // (planColumnJump → setStepCompleted with cascadePrior), so the lane, emails,
  // and step cascade all behave identically. Writes immediately and reflects the
  // new lane in the grid without a refetch (unsaved field edits are preserved).
  function applyMove(caseId: string, target: ColumnKey) {
    setMoveRow(null);
    const c = srcCases.find((x) => x.id === caseId);
    if (!c) return;
    const plan = planColumnJump(c, target);
    if (plan.length === 0) {
      setError(`"${COLUMN_LABEL[target]}" is set automatically (from tracking / results), not by moving.`);
      return;
    }
    const maxStep = Math.max(...plan.map((p) => p.step)) as StepNumber;
    setError(null);
    startSave(async () => {
      const r = await setStepCompleted({ caseId, step: maxStep, completed: true, cascadePrior: true });
      if (!r.ok) {
        setError(r.error ?? "Could not move this lab.");
        return;
      }
      const patched = caseWithStepsThrough(c, maxStep);
      setSrcCases((cs) => cs.map((x) => (x.id === caseId ? patched : x)));
      setRows((rs) =>
        rs.map((row) =>
          row.caseId === caseId
            ? { ...row, column: COLUMN_LABEL[getColumnFor(patched)], step1Done: row.step1Done || maxStep >= 1 }
            : row,
        ),
      );
      router.refresh();
    });
  }

  function toggleSel(caseId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(caseId)) next.delete(caseId);
      else next.add(caseId);
      return next;
    });
  }
  // Click a person's name → FOCUS just their rows (replace the selection), so
  // working one family member at a time can't bleed onto a sibling. Clicking
  // the already-focused person clears it. Row checkboxes stay additive for
  // fine-grained tweaks.
  function selectPerson(who: string) {
    const ids = rows.filter((r) => normName(r.who) === normName(who)).map((r) => r.caseId);
    setSelected((prev) => {
      const isExactly = prev.size === ids.length && ids.every((id) => prev.has(id));
      return isExactly ? new Set<string>() : new Set(ids);
    });
  }

  function applyToAll() {
    const t = bulkTracking.trim();
    const a = bulkAccession.trim();
    const c = bulkCollection.trim();
    // Scope to the checked rows when any are selected (the family case —
    // stamp avva's accession on avva's panels, not her sibling's); else to the
    // rows currently visible under the date filter. New labs only get stamped
    // when nothing is scoped (no selection and no active date filter).
    const scoped = selected.size > 0 || anyFilter;
    const visibleIds = new Set(visibleRows.map((r) => r.caseId));
    const hit = (r: RowEdit) =>
      selected.size > 0 ? selected.has(r.caseId) : visibleIds.has(r.caseId);
    if (t) {
      setRows((rs) => rs.map((r) => (hit(r) ? { ...r, tracking: t } : r)));
      if (!scoped) setNewLabs((ns) => ns.map((n) => ({ ...n, tracking: t })));
    }
    if (a) {
      // Accession is normally unique per lab — stamp it across rows only when
      // they're sub-panels of one physical test (e.g. Vibrant Zoomer's
      // Nutrient/Foundational/Gut share one kit + accession).
      setRows((rs) => rs.map((r) => (hit(r) ? { ...r, accession: a } : r)));
      if (!scoped) setNewLabs((ns) => ns.map((n) => ({ ...n, accession: a, noAccession: false })));
    }
    if (c) {
      setRows((rs) => rs.map((r) => (hit(r) ? { ...r, collection: c } : r)));
      if (!scoped) setNewLabs((ns) => ns.map((n) => ({ ...n, collection: c })));
    }
  }

  async function probeRow(r: RowEdit) {
    patchRow(r.caseId, { probe: { state: "loading", msg: null } });
    const res = await probeCaseResult({ caseId: r.caseId });
    if (!res.ok) {
      patchRow(r.caseId, { probe: { state: "done", msg: res.error ?? "Probe failed" } });
      return;
    }
    const hit = (res.data?.found ?? []).find((f) => f.ref);
    if (hit?.ref) {
      patchRow(r.caseId, {
        accession: hit.ref,
        probe: { state: "done", msg: `found ${hit.ref}` },
      });
    } else {
      patchRow(r.caseId, { probe: { state: "done", msg: "not in portal yet" } });
    }
  }

  function addNewLab() {
    setNewLabs((ns) => [
      ...ns,
      {
        key: newKey.current++,
        who: multiName ? "" : (personNames[0] ?? patientName),
        labName: "",
        labPanel: null,
        partialExpected: false,
        accession: "",
        noAccession: false,
        tracking: bulkTracking.trim(),
        collection: bulkCollection.trim(),
      },
    ]);
  }
  function patchNewLab(key: number, patch: Partial<NewLab>) {
    setNewLabs((ns) => ns.map((n) => (n.key === key ? { ...n, ...patch } : n)));
  }
  function removeNewLab(key: number) {
    setNewLabs((ns) => ns.filter((n) => n.key !== key));
  }

  const fieldUpdates = useMemo(
    () =>
      rows
        .filter(
          (r) =>
            r.tracking !== r.origTracking ||
            r.accession !== r.origAccession ||
            r.collection !== r.origCollection,
        )
        .map((r) => ({
          caseId: r.caseId,
          trackingNumber: r.tracking,
          accession: r.accession,
          collectionDate: r.collection,
        })),
    [rows],
  );
  const pendingNewLabs = useMemo(() => newLabs.filter((n) => n.labName.trim().length > 0), [newLabs]);
  // Save writes ONLY what changed — tracking #, accession, collection date, and
  // any new labs. It never ticks step 1: entering a tracking # leaves the card
  // in "Ready to ship" (decoupled, backlog #2 — step 1 ticks on the FedEx scan
  // or via the explicit blue "Mark sample sent" button below, never on Save).
  const dirty = fieldUpdates.length > 0 || pendingNewLabs.length > 0;

  // The in-scope rows the "Mark all sample sent" bulk action would advance:
  // not-yet-sent rows in the current selection (or the date-filtered view).
  const sampleSentScope = useMemo(() => {
    const visibleIds = new Set(visibleRows.map((r) => r.caseId));
    return rows
      .filter((r) => {
        const inScope = selected.size > 0 ? selected.has(r.caseId) : visibleIds.has(r.caseId);
        return inScope && !r.step1Done;
      })
      .map((r) => r.caseId);
  }, [rows, visibleRows, selected]);

  function onSaveAll() {
    setError(null);

    // Validate new labs need an accession (or the explicit opt-out), mirroring
    // createLabCases so the error surfaces before the round-trip.
    const missing = pendingNewLabs.find((n) => !n.noAccession && !n.accession.trim());
    if (missing) {
      setError(`Accession # is required for “${missing.labName}”. Enter it, or tick “No accession #”.`);
      return;
    }

    // Several people share this email → require a Who so the lab lands on the
    // right chart.
    const missingWho = multiName ? pendingNewLabs.find((n) => !n.who.trim()) : undefined;
    if (missingWho) {
      setError(`Pick who “${missingWho.labName || "the new lab"}” is for — several people share this email.`);
      return;
    }

    // Dedup: don't add a lab a person already has (same provider + panel). Keyed
    // by person so adding David's Vibrant doesn't block adding Leila's. Different
    // panels of one provider (Vibrant Total Tox vs Zoomer) are still allowed.
    const labKey = (who: string, name: string, panel: string) =>
      `${normName(who)}|${normName(name)}|${normName(panel)}`;
    const existingKeys = new Set(
      rows.map((r) =>
        labKey(r.who, r.labName, panelFor(srcCases.find((c) => c.id === r.caseId) ?? { lab_name: r.labName, lab_panel: null, zenoti_service_name: null })),
      ),
    );
    const dup = pendingNewLabs.find((n) =>
      existingKeys.has(labKey(n.who || patientName, n.labName, n.labPanel ?? "")),
    );
    if (dup) {
      setError(`“${dup.labName}${dup.labPanel ? ` · ${dup.labPanel}` : ""}” already exists for this patient — remove the duplicate row.`);
      return;
    }

    startSave(async () => {
      if (fieldUpdates.length > 0) {
        const r = await bulkUpdatePatientCases({ updates: fieldUpdates });
        if (!r.ok) {
          setError(r.error ?? "Could not save edits");
          return;
        }
      }

      if (pendingNewLabs.length > 0) {
        // Group by person so a family's new labs each land on the right chart.
        // Email is shared across the group; phone/dob/address come from one of
        // that person's existing cases.
        const byWho = new Map<string, NewLab[]>();
        for (const n of pendingNewLabs) {
          const who = (n.who || patientName).trim();
          const arr = byWho.get(who) ?? [];
          arr.push(n);
          byWho.set(who, arr);
        }
        for (const [who, labs] of byWho) {
          const personCase =
            srcCases.find((c) => normName(c.patient_name) === normName(who)) ?? srcCases[0];
          const fd = new FormData();
          fd.set("patientName", who);
          fd.set("patientEmail", patientEmail);
          fd.set("patientPhone", s(personCase?.patient_phone));
          fd.set("patientDob", s(personCase?.patient_dob));
          fd.set("patientAddress", s(personCase?.patient_address));
          if (personCase?.auto_send_emails) fd.set("autoSendEmails", "on");
          fd.set("notes", "");
          fd.set(
            "labsJson",
            JSON.stringify(
              labs.map((n) => ({
                labName: n.labName.trim(),
                labPanel: n.labPanel,
                trackingNumber: n.tracking.trim() || null,
                labExternalRef: n.accession.trim() || null,
                noAccession: n.noAccession,
                collectionDate: n.collection.trim() || null,
                partialExpected: n.partialExpected,
              })),
            ),
          );
          const r = await createLabCases(fd);
          if (!r.ok) {
            setError(r.error ?? "Could not add labs");
            return;
          }
        }
      }

      router.refresh();
      closeDialog();
    });
  }

  // Bulk action: advance the in-scope, not-yet-sent rows to step 1 (Sample
  // sent) and write immediately — no Save round-trip, no patient emails (step 1
  // never fires email; those are step 5/6). The dialog stays open so the
  // operator can keep editing tracking / accession after stamping sent.
  function markAllSampleSent() {
    if (sampleSentScope.length === 0) return;
    setError(null);
    startSave(async () => {
      const r = await bulkSetStepCompleted({ caseIds: sampleSentScope, step: 1, completed: true });
      if (!r.ok) {
        setError(r.error ?? "Could not mark sample-sent");
        return;
      }
      // Reflect locally so the rows drop out of scope without a reload.
      setRows((rs) =>
        rs.map((row) => (sampleSentScope.includes(row.caseId) ? { ...row, step1Done: true } : row)),
      );
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          openDialog();
        }}
        className={
          variant === "button"
            ? "rounded-md border border-indigo-300 bg-white px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
            : "shrink-0 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 hover:bg-zinc-50"
        }
        title="Edit tracking / accession / collection across all of this patient's labs"
      >
        Manage labs
      </button>

      <dialog
        ref={dialogRef}
        className="w-full max-w-4xl rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40"
      >
        {open ? (
          <div className="flex max-h-[90dvh] flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900">Manage labs — {patientName}</h2>
                <p className="text-[11px] text-zinc-500">
                  {rows.length} lab{rows.length === 1 ? "" : "s"}
                  {anyFilter ? ` · ${visibleRows.length} shown` : ""} · {patientEmail}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {/* Collection-group filter — only when there's more than one draw
                    day to choose between (otherwise it's noise). */}
                {groups.length > 1 ? (
                  <label className="flex items-center gap-1.5 text-[11px] text-zinc-600">
                    <span>Collected</span>
                    <select
                      value={groupFilter}
                      onChange={(e) => setGroupFilter(e.target.value)}
                      className="rounded border border-zinc-300 bg-white px-1.5 py-1 text-[12px] text-zinc-900 focus:border-indigo-400 focus:outline-none"
                    >
                      <option value="">All dates ({rows.length})</option>
                      {groups.map((g) => {
                        const count = rows.filter(
                          (r) => (r.collection.trim() || NO_DATE) === g,
                        ).length;
                        return (
                          <option key={g} value={g}>
                            {g === NO_DATE ? "— no date —" : g} ({count})
                          </option>
                        );
                      })}
                    </select>
                  </label>
                ) : null}
                {/* Kanban-column filter — only when the patient's labs span more
                    than one lane (otherwise it's noise). */}
                {columns.length > 1 ? (
                  <label className="flex items-center gap-1.5 text-[11px] text-zinc-600">
                    <span>Status</span>
                    <select
                      value={columnFilter}
                      onChange={(e) => setColumnFilter(e.target.value)}
                      className="rounded border border-zinc-300 bg-white px-1.5 py-1 text-[12px] text-zinc-900 focus:border-indigo-400 focus:outline-none"
                    >
                      <option value="">All columns ({rows.length})</option>
                      {columns.map((col) => {
                        const count = rows.filter((r) => r.column === col).length;
                        return (
                          <option key={col} value={col}>
                            {col} ({count})
                          </option>
                        );
                      })}
                    </select>
                  </label>
                ) : null}
                <button
                  type="button"
                  onClick={closeDialog}
                  aria-label="Close"
                  className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                >
                  ×
                </button>
              </div>
            </div>

            <div className="overflow-y-auto px-5 py-4">
              {loading ? (
                <p className="px-1 py-6 text-center text-[12px] text-zinc-500">
                  Loading this patient&rsquo;s labs…
                </p>
              ) : null}
              {/* Apply-to-all (shipped together / same draw day) */}
              <div
                className={`mb-3 flex flex-wrap items-end gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 ${
                  loading ? "hidden" : ""
                }`}
              >
                <span className="text-[11px] font-medium text-zinc-600">
                  {selected.size > 0
                    ? `Apply to ${selected.size} selected:`
                    : anyFilter
                      ? `Apply to ${visibleRows.length} shown:`
                      : "Apply to all:"}
                </span>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-zinc-500">Collected</span>
                  <input
                    type="date"
                    value={bulkCollection}
                    onChange={(e) => setBulkCollection(e.target.value)}
                    className={`${inputCls} w-36`}
                  />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-zinc-500">Tracking #</span>
                  <input
                    type="text"
                    value={bulkTracking}
                    onChange={(e) => setBulkTracking(e.target.value)}
                    placeholder="one # for the whole shipment"
                    className={`${inputCls} w-48`}
                  />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-zinc-500">Acc# (same test)</span>
                  <input
                    type="text"
                    value={bulkAccession}
                    onChange={(e) => setBulkAccession(e.target.value)}
                    placeholder="shared accession"
                    className={`${inputCls} w-40 font-mono`}
                  />
                </label>
                <button
                  type="button"
                  onClick={applyToAll}
                  className="rounded border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  Apply
                </button>
              </div>

              {/* Existing labs */}
              <div className="overflow-hidden rounded-md border border-zinc-200">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="bg-zinc-50 text-[10px] uppercase tracking-wide text-zinc-500">
                      {multiName ? <th className="px-2 py-1.5 font-medium" /> : null}
                      {multiName ? <th className="px-2 py-1.5 font-medium">Who</th> : null}
                      <th className="px-2 py-1.5 font-medium">
                        <button type="button" onClick={() => toggleSort("lab")} className="uppercase tracking-wide hover:text-zinc-800">
                          Lab{sortArrow("lab")}
                        </button>
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        <button type="button" onClick={() => toggleSort("collection")} className="uppercase tracking-wide hover:text-zinc-800">
                          Collected{sortArrow("collection")}
                        </button>
                      </th>
                      <th className="px-2 py-1.5 font-medium">Tracking #</th>
                      <th className="px-2 py-1.5 font-medium">
                        <button type="button" onClick={() => toggleSort("accession")} className="uppercase tracking-wide hover:text-zinc-800">
                          Acc#{sortArrow("accession")}
                        </button>
                      </th>
                      <th className="px-2 py-1.5 font-medium">
                        <button type="button" onClick={() => toggleSort("column")} className="uppercase tracking-wide hover:text-zinc-800">
                          Status{sortArrow("column")}
                        </button>
                      </th>
                      <th className="px-2 py-1.5 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((r) => (
                      <tr
                        key={r.caseId}
                        className={`border-t border-zinc-100 align-top ${
                          selected.has(r.caseId) ? "bg-indigo-50/50" : ""
                        }`}
                      >
                        {multiName ? (
                          <td className="px-2 py-1.5">
                            <input
                              type="checkbox"
                              checked={selected.has(r.caseId)}
                              onChange={() => toggleSel(r.caseId)}
                              aria-label={`Select ${r.who} — ${r.labLabel}`}
                            />
                          </td>
                        ) : null}
                        {multiName ? (
                          <td className="px-2 py-1.5">
                            <button
                              type="button"
                              onClick={() => selectPerson(r.who)}
                              title="Select all of this person's labs"
                              className="text-[12px] font-medium text-indigo-700 hover:underline"
                            >
                              {r.who}
                            </button>
                          </td>
                        ) : null}
                        <td className="px-2 py-1.5 text-[12px] text-zinc-800">{r.labLabel}</td>
                        <td className="px-2 py-1.5">
                          <input
                            type="date"
                            value={r.collection}
                            onChange={(e) => patchRow(r.caseId, { collection: e.target.value })}
                            className={`${inputCls} w-32`}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-1">
                            <input
                              type="text"
                              value={r.tracking}
                              onChange={(e) => patchRow(r.caseId, { tracking: e.target.value })}
                              className={`${inputCls} w-40`}
                            />
                            <button
                              type="button"
                              onClick={() => setScan({ id: r.caseId, field: "tracking" })}
                              title="Scan tracking barcode"
                              aria-label="Scan tracking barcode"
                              className="shrink-0 rounded border border-zinc-300 bg-white px-1 py-1 text-[11px] hover:bg-zinc-50"
                            >
                              📷
                            </button>
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-1">
                            <input
                              type="text"
                              value={r.accession}
                              onChange={(e) => patchRow(r.caseId, { accession: e.target.value })}
                              className={`${inputCls} w-28 font-mono`}
                            />
                            <button
                              type="button"
                              onClick={() => setScan({ id: r.caseId, field: "accession" })}
                              title="Scan accession barcode"
                              aria-label="Scan accession barcode"
                              className="shrink-0 rounded border border-zinc-300 bg-white px-1 py-1 text-[11px] hover:bg-zinc-50"
                            >
                              📷
                            </button>
                            {probeKeyForLab(r.labName) ? (
                              <button
                                type="button"
                                onClick={() => probeRow(r)}
                                disabled={r.probe.state === "loading"}
                                title="Find this result in the portal by patient name"
                                className="shrink-0 rounded border border-indigo-300 bg-white px-1 py-1 text-[11px] text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
                              >
                                {r.probe.state === "loading" ? "…" : "🔍"}
                              </button>
                            ) : null}
                          </div>
                          {r.probe.msg ? (
                            <p className="mt-0.5 text-[10px] text-zinc-500">{r.probe.msg}</p>
                          ) : null}
                        </td>
                        <td className="px-2 py-1.5 text-[11px] text-zinc-500">
                          {(() => {
                            const sc = srcCases.find((x) => x.id === r.caseId);
                            const curCol = sc ? getColumnFor(sc) : null;
                            if (moveRow?.caseId === r.caseId) {
                              const warn = sc ? moveWarning(sc, moveRow.target) : null;
                              return (
                                <div className="flex flex-col gap-1">
                                  <span className="text-zinc-700">→ {COLUMN_LABEL[moveRow.target]}</span>
                                  {warn ? <span className="text-[10px] text-amber-700">{warn}</span> : null}
                                  <div className="flex gap-1">
                                    <button
                                      type="button"
                                      onClick={() => applyMove(r.caseId, moveRow.target)}
                                      disabled={saving}
                                      className="rounded border border-emerald-300 bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                                    >
                                      Move
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setMoveRow(null)}
                                      className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-[10px] text-zinc-600 hover:bg-zinc-50"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              );
                            }
                            return (
                              <div className="flex items-center gap-1">
                                <span>{r.column}</span>
                                <select
                                  value=""
                                  disabled={saving}
                                  onChange={(e) => {
                                    const t = e.target.value as ColumnKey;
                                    if (t) setMoveRow({ caseId: r.caseId, target: t });
                                  }}
                                  title="Move this lab to another status"
                                  className="rounded border border-zinc-300 bg-white px-1 py-0.5 text-[10px] text-zinc-700 focus:border-indigo-400 focus:outline-none disabled:opacity-50"
                                >
                                  <option value="">Move ▾</option>
                                  {JUMP_TARGETS.filter((t) => t !== curCol).map((t) => (
                                    <option key={t} value={t}>
                                      {COLUMN_LABEL[t]}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-2 py-1.5">
                          {confirmDel === r.caseId ? (
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => performDelete(r.caseId)}
                                disabled={saving}
                                className="rounded border border-rose-300 bg-rose-600 px-1.5 py-0.5 text-[11px] font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDel(null)}
                                className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-50"
                              >
                                ✕
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDel(r.caseId)}
                              disabled={saving}
                              title="Delete this lab (recoverable from Settings → Deleted)"
                              aria-label="Delete this lab"
                              className="rounded border border-rose-200 bg-white px-1.5 py-0.5 text-[11px] text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                            >
                              ✕
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Add labs */}
              {newLabs.length > 0 ? (
                <div className="mt-3 flex flex-col gap-2">
                  {newLabs.map((n) => (
                    <div
                      key={n.key}
                      className="flex flex-wrap items-end gap-2 rounded-md border border-emerald-200 bg-emerald-50/40 px-3 py-2"
                    >
                      {multiName ? (
                        <label className="flex flex-col gap-0.5">
                          <span className="text-[10px] text-zinc-500">Who</span>
                          <select
                            value={n.who}
                            onChange={(e) => patchNewLab(n.key, { who: e.target.value })}
                            className={`${inputCls} w-36`}
                          >
                            <option value="">— pick —</option>
                            {personNames.map((nm) => (
                              <option key={nm} value={nm}>
                                {nm}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                      <div className="min-w-[200px] flex-1">
                        <span className="mb-0.5 block text-[10px] text-zinc-500">Lab</span>
                        <LabCombobox
                          onSelectionChange={(entry) =>
                            patchNewLab(n.key, {
                              labName: entry?.provider ?? "",
                              labPanel: entry?.panel ?? null,
                              partialExpected: Boolean(entry?.partialExpected),
                            })
                          }
                        />
                      </div>
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[10px] text-zinc-500">Collected</span>
                        <input
                          type="date"
                          value={n.collection}
                          onChange={(e) => patchNewLab(n.key, { collection: e.target.value })}
                          className={`${inputCls} w-32`}
                        />
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[10px] text-zinc-500">Tracking #</span>
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            value={n.tracking}
                            onChange={(e) => patchNewLab(n.key, { tracking: e.target.value })}
                            className={`${inputCls} w-36`}
                          />
                          <button
                            type="button"
                            onClick={() => setScan({ id: `new:${n.key}`, field: "tracking" })}
                            title="Scan tracking barcode"
                            className="shrink-0 rounded border border-zinc-300 bg-white px-1 py-1 text-[11px] hover:bg-zinc-50"
                          >
                            📷
                          </button>
                        </div>
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[10px] text-zinc-500">Acc#</span>
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            value={n.accession}
                            disabled={n.noAccession}
                            onChange={(e) => patchNewLab(n.key, { accession: e.target.value })}
                            className={`${inputCls} w-24 font-mono disabled:bg-zinc-100`}
                          />
                          <button
                            type="button"
                            onClick={() => setScan({ id: `new:${n.key}`, field: "accession" })}
                            disabled={n.noAccession}
                            title="Scan accession barcode"
                            className="shrink-0 rounded border border-zinc-300 bg-white px-1 py-1 text-[11px] hover:bg-zinc-50 disabled:opacity-50"
                          >
                            📷
                          </button>
                        </div>
                      </label>
                      <label className="flex items-center gap-1 pb-1.5 text-[10px] text-zinc-600">
                        <input
                          type="checkbox"
                          checked={n.noAccession}
                          onChange={(e) => patchNewLab(n.key, { noAccession: e.target.checked })}
                        />
                        No acc#
                      </label>
                      <button
                        type="button"
                        onClick={() => removeNewLab(n.key)}
                        className="pb-1.5 text-[11px] text-rose-600 hover:underline"
                      >
                        remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <button
                type="button"
                onClick={addNewLab}
                className="mt-3 rounded-md border border-dashed border-zinc-300 bg-white px-3 py-1.5 text-[12px] font-medium text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50"
              >
                + Add lab
              </button>
              {multiName ? (
                <p className="mt-1 text-[11px] text-zinc-500">
                  Several people share this email — pick who each new lab is for.
                </p>
              ) : null}

              {error ? (
                <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
                  {error}
                </p>
              ) : null}
            </div>

            {/* Action bar — 3-colored-button pattern (matches PdfReviewModal):
                neutral Cancel, sky "mark sample sent" bulk action, emerald
                primary Save-all. */}
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 bg-zinc-50 px-5 py-3">
              <button
                type="button"
                onClick={closeDialog}
                disabled={saving}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={markAllSampleSent}
                disabled={saving || sampleSentScope.length === 0}
                title="Tick step 1 (Sample sent) on these labs now — writes immediately, no patient emails"
                className="rounded-md border border-sky-300 bg-white px-3 py-1.5 text-[13px] font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-50"
              >
                Mark {selected.size > 0 ? "selected" : anyFilter ? "shown" : "all"} sent
                {sampleSentScope.length > 0 ? ` (${sampleSentScope.length})` : ""} · no email
              </button>
              <button
                type="button"
                onClick={onSaveAll}
                disabled={saving || !dirty}
                title="Save tracking #, accession, collection date and any new labs. Does not mark anything sent."
                className="rounded-md bg-emerald-600 px-4 py-1.5 text-[13px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {saving
                  ? "Saving…"
                  : `Save${
                      fieldUpdates.length + pendingNewLabs.length > 0
                        ? ` (${fieldUpdates.length + pendingNewLabs.length})`
                        : ""
                    }`}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>

      {scan ? (
        <BarcodeScanner
          title={scan.field === "tracking" ? "Scan tracking barcode" : "Scan accession barcode"}
          onClose={() => setScan(null)}
          onDetect={applyScan}
        />
      ) : null}
    </>
  );
}
