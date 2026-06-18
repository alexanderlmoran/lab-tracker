"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LabCase, StepNumber } from "@/lib/types";
import {
  COLUMN_LABEL,
  LAB_BOARD_COLUMN_ORDER,
  type ColumnKey,
  daysFromTodayIso,
  expectedCountdown,
  getCaseStaleness,
  getColumnFor,
  isProbablyReady,
} from "@/lib/columns";
import { planColumnJump } from "@/lib/column-jump";
import { trackingDestinationWarning } from "@/lib/labs/catalog";
import { labelForCase } from "@/lib/labs/label";
import { archiveLabCase, setStepCompleted } from "./actions";
import { CaseDetail } from "./CaseDetail";
import { easternDateIso, formatPersonName, formatShortDate } from "@/lib/format";
import {
  ZERO_COUNTS,
  attemptCardClasses,
  CHIP,
  TRACKING_BADGE,
  RailChip,
  AttemptRailChip,
  EmailRailChip,
  type CardCounts,
} from "./card-counts";
import { useDismiss } from "./use-dismiss";
import { isMergeMode, MERGE_STORAGE_KEY, type MergeMode } from "./MergeViewMenu";

function formatExpectedRange(min: string | null, max: string | null): string | null {
  if (!min && !max) return null;
  const fmt = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  if (min && max && min !== max) return `${fmt(min)} – ${fmt(max)}`;
  return fmt(max ?? min ?? "");
}

// Grouping key for same-accession duplicate cards (same patient + ACC#) — the
// same rule the dup chip uses. Null when there's no accession to group on.
function dupKey(r: LabCase): string | null {
  const ref = r.lab_external_ref?.trim();
  if (!ref) return null;
  const who = (r.patient_email || r.patient_name || "").trim().toLowerCase();
  return `${who}::${ref}`;
}

// Per-column chip policy (Alex, 2026-06-11): once the result is ON PB the
// shipping/staleness chips are noise. Complete Uploaded + ROF Scheduled keep
// ONLY the human-contact signals (✉ emails + 📞 attempts — who still needs a
// call); the last three lanes (ROF Done, Protocol received, Completed) show
// nothing. Mirrored in the Legend — update both together.
type BadgeTier = "full" | "contact" | "none";
function badgeTier(col: ColumnKey): BadgeTier {
  if (col === "rof_done" || col === "closed" || col === "completed") return "none";
  if (col === "complete_results" || col === "rof_scheduled") return "contact";
  return "full";
}
// Tracking #, expected window and pickup are operational shipping info — hide
// from "Complete Uploaded" onward, where the sample is long delivered.
const TRACKING_META_HIDDEN = new Set<ColumnKey>([
  "complete_results",
  "rof_scheduled",
  "rof_done",
  "closed",
  "completed",
]);

// Per-column sort (the little control in each column header). null = the
// board's default ready-first ordering. Each field has a natural direction
// (names A–Z, dates newest-first) and the ↑/↓ arrow flips it.
type SortField = "name" | "date" | "type" | "typehx";
type SortDir = "asc" | "desc";
type ColumnSort = { field: SortField; dir: SortDir } | null;
const SORT_FIELD_LABEL: Record<SortField, string> = {
  name: "Name",
  date: "Date",
  type: "Type",
  typehx: "Type · date",
};
const SORT_NATURAL_DIR: Record<SortField, SortDir> = {
  name: "asc",
  date: "desc",
  type: "asc",
  typehx: "desc",
};
// Persisted so the board comes back the way you left it after a reload.
const SORT_STORAGE_KEY = "labKanbanSortByCol";

function sortUnits(units: LabCase[][], sort: ColumnSort): LabCase[][] {
  if (!sort) return units;
  // Representative card = the unit's most-advanced member — the same one the
  // merged card displays — so the sort matches what's on screen.
  const rep = (u: LabCase[]) => u[u.length - 1];
  const name = (c: LabCase) => formatPersonName(c.patient_name).toLowerCase();
  const type = (c: LabCase) => labelForCase(c).toLowerCase();
  const flip = sort.dir === "asc" ? 1 : -1;
  // Date-less cards sink to the bottom in EITHER direction (oldest-first must
  // not float every card with no collection date to the top).
  const byDate = (a: LabCase, b: LabCase) => {
    const da = a.collection_date;
    const db = b.collection_date;
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return flip * da.localeCompare(db);
  };
  const cmp: Record<SortField, (a: LabCase[], b: LabCase[]) => number> = {
    name: (a, b) => flip * name(rep(a)).localeCompare(name(rep(b))),
    date: (a, b) => byDate(rep(a), rep(b)),
    type: (a, b) => flip * type(rep(a)).localeCompare(type(rep(b))),
    // Types stay A–Z; the arrow flips the date order within each type group.
    typehx: (a, b) => type(rep(a)).localeCompare(type(rep(b))) || byDate(rep(a), rep(b)),
  };
  // .sort is stable, so ties keep the board's ready-first ordering.
  return [...units].sort(cmp[sort.field]);
}

// The header sort control: a quiet ⇅ when the column is on default order, a
// compact "Date ↓" pill when sorted. The menu picks the field; picking the
// active field again flips its direction (same as clicking a table header).
function SortControl({
  col,
  sort,
  onChange,
}: {
  col: ColumnKey;
  sort: ColumnSort;
  onChange: (s: ColumnSort) => void;
}) {
  const [open, setOpen] = useState(false);
  // Viewport coords for the menu. The .kanban-col sections clip their contents
  // (overflow:hidden in hud.css for the rounded gradient), and the columns are
  // narrower than the menu — so an absolute menu gets its left edge cut off.
  // position:fixed escapes the clip; useDismiss closes on any outside scroll
  // so the menu can't drift from its anchor.
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useDismiss(wrapRef, open, () => setOpen(false));

  function toggle() {
    if (!open && wrapRef.current) {
      const r = wrapRef.current.getBoundingClientRect();
      // Right-align to the button, clamped so column 1 stays on-screen.
      setMenuPos({ top: r.bottom + 4, left: Math.max(8, r.right - 128) });
    }
    setOpen((v) => !v);
  }

  function pick(field: SortField) {
    onChange(
      sort?.field === field
        ? { field, dir: sort.dir === "asc" ? "desc" : "asc" }
        : { field, dir: SORT_NATURAL_DIR[field] },
    );
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={`Sort ${COLUMN_LABEL[col]}`}
        title={
          sort
            ? `Sorted by ${SORT_FIELD_LABEL[sort.field].toLowerCase()} (${sort.dir === "asc" ? "ascending" : "descending"})`
            : "Sort the cards in this column"
        }
        className={
          sort
            ? "flex items-center gap-0.5 whitespace-nowrap rounded-full border border-indigo-200 bg-indigo-50 px-1.5 text-[10px] font-medium leading-4 text-indigo-700 hover:bg-indigo-100"
            : "rounded px-0.5 text-[11px] leading-4 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
        }
      >
        {sort ? `${SORT_FIELD_LABEL[sort.field]} ${sort.dir === "asc" ? "↑" : "↓"}` : "⇅"}
      </button>
      {open ? (
        <div
          className="fixed z-50 w-32 overflow-hidden rounded-md border border-zinc-200 bg-white py-0.5 shadow-lg"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          {(Object.keys(SORT_FIELD_LABEL) as SortField[]).map((f) => {
            const isActive = sort?.field === f;
            return (
              <button
                key={f}
                type="button"
                onClick={() => pick(f)}
                title={isActive ? "Flip direction" : undefined}
                className={`flex w-full items-center justify-between px-2.5 py-1 text-left text-[11px] ${
                  isActive
                    ? "bg-indigo-50 font-medium text-indigo-700"
                    : "text-zinc-700 hover:bg-zinc-50"
                }`}
              >
                <span>{SORT_FIELD_LABEL[f]}</span>
                {isActive ? <span>{sort.dir === "asc" ? "↑" : "↓"}</span> : null}
              </button>
            );
          })}
          {sort ? (
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="block w-full border-t border-zinc-100 px-2.5 py-1 text-left text-[11px] text-zinc-500 hover:bg-zinc-50"
            >
              Clear — ready first
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LabCard({
  row,
  onOpen,
  counts,
  dupSiblings,
  hasPendingPdf,
}: {
  row: LabCase;
  onOpen: (row: LabCase, autoReview?: boolean) => void;
  counts: CardCounts;
  /** Other cards for the same patient sharing this card's accession. */
  dupSiblings?: LabCase[];
  /** A result PDF is staged awaiting Approve — clicking the card jumps straight
   *  to the review modal. */
  hasPendingPdf?: boolean;
}) {
  const expected = formatExpectedRange(
    row.expected_result_at_min,
    row.expected_result_at_max,
  );
  const stale = getCaseStaleness(row);
  const probablyReady = isProbablyReady(row);
  const countdown = expectedCountdown(row);
  const destWarning = trackingDestinationWarning({
    labName: row.lab_name,
    labPanel: row.lab_panel,
    trackingStatus: row.tracking_status,
    trackingLocation: row.tracking_location,
  });
  const labLabel = labelForCase(row);
  const trackingMeta = row.tracking_status
    ? TRACKING_BADGE[row.tracking_status]
    : null;

  // Per-column policy: how many badges + whether tracking meta shows.
  const col = getColumnFor(row);
  const tier = badgeTier(col);
  const showMeta = !TRACKING_META_HIDDEN.has(col);

  // Chips live in a wrap row BELOW the text (not a right-side rail) so a narrow
  // column — there are 10 lanes now — never squeezes the lab/patient text into
  // one-word-per-line. Only render the row when there's at least one chip so
  // sparse cards (TODO / Ready to ship) stay tight. The set shown is tiered:
  // "none" → nothing; "contact" → ✉ emails + 📞 attempts only; "full" → all.
  const fullChips =
    hasPendingPdf ||
    Boolean(row.tracking_status) ||
    probablyReady ||
    (dupSiblings?.length ?? 0) > 0 ||
    counts.openAttempts > 0 ||
    Boolean(countdown) ||
    Boolean(destWarning) ||
    counts.emailCount > 0 ||
    stale.stale;
  const hasChips =
    tier === "none"
      ? false
      : tier === "contact"
        ? counts.openAttempts > 0 || counts.emailCount > 0
        : fullChips;

  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", row.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onOpen(row, hasPendingPdf)}
      className={`flex w-full cursor-grab flex-col gap-1 rounded-md border p-1.5 text-left shadow-sm transition-shadow hover:shadow active:cursor-grabbing ${
        hasPendingPdf
          ? "border-amber-400 bg-amber-50"
          : probablyReady
            ? "border-blue-300 bg-blue-50"
            : attemptCardClasses(counts.openAttempts)
      }`}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {/* Patient-first (Alex, 2026-06-11): the NAME is the line staff scan
            for; the lab type is the detail. */}
        <p className="truncate text-[13px] font-semibold leading-tight text-zinc-900">
          {formatPersonName(row.patient_name)}
        </p>
        <p className="truncate text-[12px] text-zinc-500">{labLabel}</p>
        {showMeta && (expected || row.tracking_number || row.pickup_confirmation) ? (
          <div className="flex flex-col gap-0.5 text-[10px] text-zinc-400">
            {expected ? <span className="truncate">↳ {expected}</span> : null}
            {row.tracking_number ? (
              <span className="truncate">TRK {row.tracking_number}</span>
            ) : null}
            {row.pickup_confirmation ? (
              <span
                className="truncate text-emerald-600"
                title={`Pickup scheduled${row.pickup_scheduled_date ? ` for ${row.pickup_scheduled_date}` : ""} (${(row.pickup_carrier ?? "fedex").toUpperCase()})`}
              >
                📦 {row.pickup_confirmation}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {hasChips ? (
        <div className="flex flex-wrap items-center gap-1">
          {hasPendingPdf ? (
            <RailChip
              className="border-amber-400 bg-amber-100 font-semibold text-amber-800"
              title="Result PDF staged — click to review & approve"
            >
              review
            </RailChip>
          ) : null}
          {tier === "full" ? (
            <>
              {trackingMeta ? (
                <RailChip
                  className={trackingMeta.className}
                  title={row.tracking_status_detail ?? undefined}
                >
                  {trackingMeta.label}
                </RailChip>
              ) : row.tracking_status ? (
                <RailChip className={CHIP.muted}>{row.tracking_status}</RailChip>
              ) : null}
              {probablyReady ? (
                <RailChip className={CHIP.state} title="Likely ready — check lab portal">
                  ready?
                </RailChip>
              ) : null}
              {dupSiblings && dupSiblings.length > 0 ? (
                <RailChip
                  className="border-purple-300 bg-purple-50 text-purple-700"
                  title={`Same ACC# ${row.lab_external_ref} as ${dupSiblings.length} other card(s) for this patient — likely one lab split into multiple cards (e.g. PT/PTT/PT-INR). Tracking#: ${dupSiblings.map((s) => s.tracking_number ?? "—").join(", ")}. Merge/dismiss the extras.`}
                >
                  dup ×{dupSiblings.length + 1}
                </RailChip>
              ) : null}
              {countdown ? (
                <RailChip
                  className={
                    countdown.tone === "overdue"
                      ? CHIP.alert
                      : countdown.tone === "due"
                        ? CHIP.caution
                        : CHIP.good
                  }
                  title={
                    countdown.tone === "overdue"
                      ? `Expected by ${formatShortDate(row.expected_result_at_max)} — past`
                      : `Expected by ${formatShortDate(row.expected_result_at_max)}`
                  }
                >
                  {countdown.label}
                </RailChip>
              ) : null}
              {destWarning ? (
                <RailChip className={CHIP.warn} title={destWarning}>
                  wrong city?
                </RailChip>
              ) : null}
            </>
          ) : null}
          {/* Contact signals render for BOTH "full" and "contact" tiers. */}
          <AttemptRailChip openAttempts={counts.openAttempts} />
          <EmailRailChip emailCount={counts.emailCount} />
          {tier === "full" && stale.stale ? (
            <RailChip
              className={CHIP.caution}
              title={`No progress in ${stale.daysSinceProgress} days`}
            >
              {stale.daysSinceProgress}d
            </RailChip>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}

// Merged "elongated" card for a same-accession order whose cards are folded
// into one (merge-dupes view), even when those cards span multiple columns.
// Shows the shared ACC# + every sibling's tracking #. Clicking opens the
// most-advanced member; the review + step actions cascade across the whole
// group (siblings move together), so resolving from here resolves all.
function MergedDupCard({
  rows,
  onOpen,
  hasPendingPdf,
  mode,
}: {
  rows: LabCase[];
  onOpen: (row: LabCase, autoReview?: boolean) => void;
  hasPendingPdf: boolean;
  /** "dupes" = one accession's panels (lab-first header); "patient"/"date" =
   *  a patient's cards collapsed within a column (patient-first header). */
  mode: "off" | "dupes" | "patient" | "date";
}) {
  // rows arrive in column order (leftmost first); open the most-advanced one so
  // the dialog reflects where the order actually is.
  const lead = rows[rows.length - 1];
  const isDupes = mode === "dupes";
  // Same per-column policy as LabCard: ACC#/TRK are shipping-era info — hide
  // them from Complete Uploaded onward (they were showing in Protocol
  // received, where they're noise).
  const showMeta = !TRACKING_META_HIDDEN.has(getColumnFor(lead));
  // Sub-panels of one physical order usually share ONE tracking # — dedupe so
  // the card shows "TRK 7917…" once, not the same number repeated ×3.
  const trackings = [
    ...new Set(rows.map((r) => r.tracking_number).filter(Boolean) as string[]),
  ];
  const labels = [...new Set(rows.map((r) => labelForCase(r)))];
  return (
    <button
      type="button"
      onClick={() => onOpen(lead, hasPendingPdf)}
      // Whole-card tint of the merge accent (the light pinkish purple) so a
      // merged unit reads at a glance in ANY merge view; text stays zinc.
      className={`flex w-full flex-col gap-1 rounded-md border-2 border-dashed p-1.5 text-left shadow-sm transition-shadow hover:shadow ${
        hasPendingPdf
          ? "border-amber-400 bg-amber-50"
          : "border-purple-300 bg-purple-100"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        {/* Patient-first, same as LabCard (Alex, 2026-06-11). */}
        <p className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-tight text-zinc-900">
          {formatPersonName(lead.patient_name)}
        </p>
        <span className="shrink-0 rounded bg-purple-200 px-1.5 text-[10px] font-semibold text-purple-800">
          {isDupes ? `merged ×${rows.length}` : `${rows.length} labs`}
        </span>
      </div>
      {isDupes ? (
        <p className="truncate text-[12px] text-zinc-500">{labelForCase(lead)}</p>
      ) : (
        <p className="truncate text-[11px] text-zinc-500">
          {mode === "date" && lead.collection_date ? `${lead.collection_date} · ` : ""}
          {labels.join(" · ")}
        </p>
      )}
      {isDupes && showMeta ? (
        <div className="flex flex-col gap-0.5 text-[10px] text-zinc-400">
          {lead.lab_external_ref ? <span>ACC# {lead.lab_external_ref}</span> : null}
          {trackings.length ? <span className="truncate">TRK {trackings.join(" · ")}</span> : null}
        </div>
      ) : null}
      {hasPendingPdf ? (
        <span className="self-start rounded border border-amber-400 bg-amber-100 px-1 text-[10px] font-semibold text-amber-800">
          review — applies to all {rows.length}
        </span>
      ) : null}
    </button>
  );
}

function StaticColumn({
  col,
  count,
  children,
  isDropOver,
  onCardDrop,
  onColDragOver,
  sort,
  onSortChange,
}: {
  col: ColumnKey;
  count: number;
  children: React.ReactNode;
  /** This column is the current drag target — highlight it. */
  isDropOver?: boolean;
  /** A card was dropped on this column. */
  onCardDrop?: (caseId: string, col: ColumnKey) => void;
  /** Drag entered (col) / left (null) this column. */
  onColDragOver?: (col: ColumnKey | null) => void;
  /** This column's current sort + a setter (the header ⇅/pill control). */
  sort?: ColumnSort;
  onSortChange?: (s: ColumnSort) => void;
}) {
  // Pending Upload is the one lane that owes a human action (Approve → PB). Make
  // it pop when it has cases so it can't hide among the 9 equal-width columns.
  const needsAction = col === "pending_upload" && count > 0;
  return (
    <section
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onColDragOver?.(col);
      }}
      onDragLeave={(e) => {
        // Only clear when leaving the column itself, not when moving between its cards.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onColDragOver?.(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onColDragOver?.(null);
        const id = e.dataTransfer.getData("text/plain");
        if (id) onCardDrop?.(id, col);
      }}
      className={`kanban-col flex min-w-0 flex-1 basis-0 flex-col p-1.5 lg:min-h-0 ${
        isDropOver
          ? "rounded-md ring-2 ring-indigo-400"
          : needsAction
            ? "rounded-md bg-amber-50/50 ring-1 ring-amber-300"
            : ""
      }`}
      data-col={col}
    >
      {/* Full titles wrap to a second line in the narrow lanes — truncating to
          "COMPLETE UPLO…" hid which lane was which. flex-wrap lets the
          sort/count controls drop below the title when both can't fit (e.g.
          an active sort pill on a long-titled column). */}
      <header className="flex flex-wrap items-start justify-between gap-x-1 gap-y-0.5 px-1.5 py-1">
        {/* Count lives INSIDE the accent dot (replaces the old right-side
            count chip — Alex, 2026-06-11). Amber when Pending Upload owes a
            human action. */}
        <h3 className={`col-head-title min-w-0 ${needsAction ? "text-amber-800" : ""}`}>
          <span className={`col-count-dot${needsAction ? " col-count-dot--alert" : ""}`}>
            {count}
          </span>
          {COLUMN_LABEL[col]}
        </h3>
        <div className="flex shrink-0 items-center gap-1">
          {onSortChange ? (
            <SortControl col={col} sort={sort ?? null} onChange={onSortChange} />
          ) : null}
        </div>
      </header>
      <div className="flex min-h-[40px] flex-col gap-1.5 p-0.5 lg:flex-1 lg:overflow-y-auto">
        {children}
      </div>
    </section>
  );
}

/** "06/18/2026" header for the TO DO date dividers, with a Today/Tomorrow/overdue
 *  hint. Undated cases get their own header (never hidden). */
function todoDateHeader(iso: string | null): string {
  if (!iso) return "No collection date";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const pretty = m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
  const d = daysFromTodayIso(iso);
  if (d === 0) return `Today · ${pretty}`;
  if (d === 1) return `Tomorrow · ${pretty}`;
  if (d < 0) return `${pretty} · ${-d}d overdue`;
  return pretty;
}

/** TO DO as a WEEK VIEW: ALWAYS render today → +7 as date sections (even when a
 *  day has no labs — that's how the user sees the whole week, not just the days
 *  that happen to have work). Plus overdue (past, dated), beyond-window (future
 *  past +7), and undated sections — but those only appear when they hold labs.
 *  The lead card's collection_date buckets each unit; stable, so the per-column
 *  sort still orders WITHIN a day. Nothing is hidden. */
function groupTodoByDate(units: LabCase[][]): { key: string; label: string; items: LabCase[][] }[] {
  const byDate = new Map<string, LabCase[][]>();
  for (const u of units) {
    const k = u[0].collection_date ?? "nodate";
    const arr = byDate.get(k);
    if (arr) arr.push(u);
    else byDate.set(k, [u]);
  }

  const today = easternDateIso();
  const base = Date.parse(today + "T00:00:00Z");
  const windowKeys: string[] = [];
  for (let i = 0; i <= 7; i++) windowKeys.push(new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  const lastWindow = windowKeys[windowKeys.length - 1];
  const dated = [...byDate.keys()].filter((k) => k !== "nodate");

  const out: { key: string; label: string; items: LabCase[][] }[] = [];
  const push = (key: string, items: LabCase[][]) => out.push({ key, label: todoDateHeader(key === "nodate" ? null : key), items });
  // Overdue (dated before today) — only if present.
  for (const k of dated.filter((k) => k < today).sort()) push(k, byDate.get(k)!);
  // The week — today → +7, ALWAYS (empty days included).
  for (const k of windowKeys) push(k, byDate.get(k) ?? []);
  // Beyond the window (dated after +7) — only if present.
  for (const k of dated.filter((k) => k > lastWindow).sort()) push(k, byDate.get(k)!);
  // Undated — only if present.
  if (byDate.has("nodate")) push("nodate", byDate.get("nodate")!);
  return out;
}

export function LabKanbanBoard({
  rows,
  counts,
  pendingPdfCaseIds,
}: {
  rows: LabCase[];
  counts?: Record<string, CardCounts>;
  /** Case IDs whose attached PDF is still waiting on staff Approve/Wrong-PDF.
   * Used to lift those rows into the "Pending Upload" column. */
  pendingPdfCaseIds?: string[];
}) {
  const pendingPdfSet = useMemo(
    () => new Set(pendingPdfCaseIds ?? []),
    [pendingPdfCaseIds],
  );
  const searchParams = useSearchParams();

  const probablyReadyOnly = searchParams.get("ready") === "1";
  const staleOnly = searchParams.get("stale") === "1";

  const filtered = useMemo(() => {
    let list = rows;
    if (probablyReadyOnly) list = list.filter(isProbablyReady);
    if (staleOnly) list = list.filter((r) => getCaseStaleness(r).stale);
    return list;
  }, [rows, probablyReadyOnly, staleOnly]);

  // Same-accession duplicate detection. One patient with >1 card sharing the
  // SAME accession is almost always one lab split into multiple tracker cards
  // (e.g. a PT/PTT/PT-INR shipped together — same draw, same accession, separate
  // tracking#). Flag them so staff merge/dismiss the extras instead of uploading
  // the same result twice. Computed over ALL rows so siblings in other columns
  // still count. Keyed by patient + accession.
  const dupByCaseId = useMemo(() => {
    const groups = new Map<string, LabCase[]>();
    for (const r of rows) {
      const ref = r.lab_external_ref?.trim();
      if (!ref) continue;
      const who = (r.patient_email || r.patient_name || "").trim().toLowerCase();
      const key = `${who}::${ref}`;
      const arr = groups.get(key) ?? [];
      arr.push(r);
      groups.set(key, arr);
    }
    const out = new Map<string, LabCase[]>();
    for (const arr of groups.values()) {
      if (arr.length < 2) continue;
      for (const r of arr) out.set(r.id, arr.filter((x) => x.id !== r.id));
    }
    return out;
  }, [rows]);

  // Optimistic column overrides for drag-drop: the card jumps to its target
  // lane the moment the move is confirmed instead of waiting ~seconds for the
  // server action + full refresh. Cleared when fresh rows arrive (the server
  // truth) or reverted if the action fails.
  const [optimisticCols, setOptimisticCols] = useState<Record<string, ColumnKey>>({});
  useEffect(() => {
    setOptimisticCols({});
  }, [rows]);

  const grouped: Record<ColumnKey, LabCase[]> = {
    untouched: [],
    ready_to_ship: [],
    sample_sent: [],
    partial_results: [],
    complete_results: [],
    pending_upload: [],
    rof_scheduled: [],
    rof_done: [],
    closed: [],
    completed: [],
  };
  for (const r of filtered) {
    grouped[
      optimisticCols[r.id] ??
        getColumnFor(r, { hasPendingPdf: pendingPdfSet.has(r.id) })
    ].push(r);
  }
  for (const col of LAB_BOARD_COLUMN_ORDER) {
    // Float likely-ready cards to the top of their column so the "go get this
    // result" ones are seen first; otherwise newest-updated first.
    grouped[col].sort(
      (a, b) =>
        Number(isProbablyReady(b)) - Number(isProbablyReady(a)) ||
        b.updated_at.localeCompare(a.updated_at),
    );
  }

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [activeRow, setActiveRow] = useState<LabCase | null>(null);
  const [autoReview, setAutoReview] = useState(false);
  const router = useRouter();
  const [, startMove] = useTransition();
  const [dragOverCol, setDragOverCol] = useState<ColumnKey | null>(null);
  // Per-column sort (the header control). Missing key = default ready-first
  // order. Persisted to localStorage so a reload keeps the arrangement.
  const [sortByCol, setSortByCol] = useState<
    Partial<Record<ColumnKey, NonNullable<ColumnSort>>>
  >({});
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SORT_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      const clean: Partial<Record<ColumnKey, NonNullable<ColumnSort>>> = {};
      for (const [col, s] of Object.entries(
        (parsed ?? {}) as Record<string, NonNullable<ColumnSort>>,
      )) {
        if (
          col in COLUMN_LABEL &&
          s &&
          s.field in SORT_FIELD_LABEL &&
          (s.dir === "asc" || s.dir === "desc")
        ) {
          clean[col as ColumnKey] = { field: s.field, dir: s.dir };
        }
      }
      setSortByCol(clean);
    } catch {
      // corrupt/legacy storage — fall back to default order
    }
  }, []);
  function setColumnSort(col: ColumnKey, next: ColumnSort) {
    setSortByCol((s) => {
      const out = { ...s };
      if (next) out[col] = next;
      else delete out[col];
      try {
        window.localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(out));
      } catch {
        // storage unavailable (private mode) — sort still works for the session
      }
      return out;
    });
  }

  // Drag a card onto a column to move it there. Applies the column's defining
  // step(s) (planColumnJump → setStepCompleted with cascadePrior), or archives
  // for "Completed". Derived lanes (TODO / Ready to ship / Pending Upload) can't
  // be set by a move — they follow from tracking/results — so we no-op those.
  // A confirm guards the move since some steps fire emails (5 Nadia, 6 Allison).
  function handleDropCase(caseId: string, targetCol: ColumnKey) {
    const row = rows.find((r) => r.id === caseId);
    if (!row || getColumnFor(row) === targetCol) return;
    if (targetCol === "untouched" || targetCol === "ready_to_ship" || targetCol === "pending_upload") {
      window.alert(
        `"${COLUMN_LABEL[targetCol]}" is set automatically (from the tracking # / results), not by moving a card here.`,
      );
      return;
    }
    if (
      !window.confirm(
        `Move ${formatPersonName(row.patient_name)} — ${labelForCase(row)} to "${COLUMN_LABEL[targetCol]}"?`,
      )
    ) {
      return;
    }
    // Jump the card to its lane NOW; the server action + refresh follow.
    setOptimisticCols((prev) => ({ ...prev, [caseId]: targetCol }));
    startMove(async () => {
      let res;
      if (targetCol === "completed") {
        res = await archiveLabCase(caseId);
      } else {
        const plan = planColumnJump(row, targetCol);
        if (plan.length === 0) {
          setOptimisticCols((prev) => {
            const { [caseId]: _, ...rest } = prev;
            return rest;
          });
          return;
        }
        const maxStep = Math.max(...plan.map((p) => p.step)) as StepNumber;
        res = await setStepCompleted({ caseId, step: maxStep, completed: true, cascadePrior: true });
      }
      if (res && !res.ok) {
        setOptimisticCols((prev) => {
          const { [caseId]: _, ...rest } = prev;
          return rest;
        });
        window.alert(res.error ?? "Could not move the card.");
        return;
      }
      router.refresh();
    });
  }
  // Merge VIEW mode. "dupes" (default) collapses a same-accession order (Vibrant
  // Zoomer split into Foundational/Gut/Toxin panel cards) into ONE card across
  // columns. "patient" / "date" collapse a patient's cards WITHIN each column
  // (by patient, or by patient+collection-date) so a busy patient reads as one
  // unit per lane. "off" expands everything.
  // The merge control lives in the toolbar now (MergeViewMenu, left of the
  // search bar). It writes ?merge= + localStorage; the board only reads —
  // param wins, the stored value covers param-less visits.
  const mergeParam = searchParams.get("merge");
  const [storedMerge, setStoredMerge] = useState<MergeMode>("dupes");
  useEffect(() => {
    try {
      const m = window.localStorage.getItem(MERGE_STORAGE_KEY);
      if (isMergeMode(m)) setStoredMerge(m);
    } catch {
      // storage unavailable — default stands
    }
  }, [mergeParam]);
  const mergeMode: MergeMode = isMergeMode(mergeParam) ? mergeParam : storedMerge;

  // Board-wide merged-group plan. A same-accession group is ONE physical order
  // split across cards; when those cards land in DIFFERENT columns (only one
  // advanced) the old per-column collapse left a "ghost" sibling card behind
  // (backlog #4). So we plan groups across the whole board: each group renders
  // a single merged card in its LEAD column (where the most-advanced member
  // sits) and is SUPPRESSED everywhere else. Built only when merge-dupes is on.
  const mergePlan = useMemo(() => {
    // leadColByKey: which column gets the merged card. memberIdsByKey: every
    // card in the group (across columns). suppressedIds: sibling cards that
    // should NOT render as their own card (they're folded into the merged one).
    const groupsByKey = new Map<string, LabCase[]>();
    if (mergeMode === "dupes") {
      for (const col of LAB_BOARD_COLUMN_ORDER) {
        for (const r of grouped[col]) {
          const key = dupKey(r);
          if (!key) continue;
          const arr = groupsByKey.get(key) ?? [];
          arr.push(r);
          groupsByKey.set(key, arr);
        }
      }
    }
    const leadColByKey = new Map<string, ColumnKey>();
    const membersByKey = new Map<string, LabCase[]>();
    const suppressedIds = new Set<string>();
    for (const [key, members] of groupsByKey) {
      if (members.length < 2) continue;
      // Lead column = the furthest-right (most-advanced) column any member sits
      // in, so a merged order shows up where its progress actually is.
      let leadCol = getColumnFor(members[0]);
      let leadIdx = LAB_BOARD_COLUMN_ORDER.indexOf(leadCol);
      for (const m of members) {
        const c = getColumnFor(m);
        const i = LAB_BOARD_COLUMN_ORDER.indexOf(c);
        if (i > leadIdx) {
          leadIdx = i;
          leadCol = c;
        }
      }
      leadColByKey.set(key, leadCol);
      membersByKey.set(key, members);
      for (const m of members) suppressedIds.add(m.id);
    }
    return { leadColByKey, membersByKey, suppressedIds };
  }, [mergeMode, grouped]);

  // Units to render in a column: the column's own cards, EXCEPT cards folded
  // into a merged group (suppressed everywhere but their lead column), PLUS the
  // merged cards whose lead column is this one. Without merge-dupes, one unit
  // per card (unchanged behavior).
  function unitsFor(col: ColumnKey): LabCase[][] {
    if (mergeMode === "off") return grouped[col].map((r) => [r]);

    // By-patient / by-date: group a patient's cards WITHIN this column (the user
    // wants merge to "respect each column"). Same patient → one unit; date mode
    // splits a patient further by collection date.
    if (mergeMode === "patient" || mergeMode === "date") {
      const norm = (v: string | null) => (v ?? "").toLowerCase().trim();
      const keyFn = (r: LabCase) =>
        mergeMode === "patient"
          ? norm(r.patient_email) || `solo:${r.id}`
          : `${norm(r.patient_email)}|${r.collection_date ?? "nodate"}`;
      const order: string[] = [];
      const groups = new Map<string, LabCase[]>();
      for (const r of grouped[col]) {
        const k = keyFn(r);
        if (!groups.has(k)) {
          groups.set(k, []);
          order.push(k);
        }
        groups.get(k)!.push(r);
      }
      return order.map((k) => groups.get(k)!);
    }

    // dupes: cross-column same-accession collapse (one card in the lead column).
    const out: LabCase[][] = [];
    const emitted = new Set<string>(); // group keys already rendered this column
    for (const r of grouped[col]) {
      const key = dupKey(r);
      // A merged-group member: render the merged unit once, anchored to the
      // FIRST member that sits in this group's lead column (so the order shows
      // up where its progress is). Every member is suppressed as its own card.
      if (key && mergePlan.suppressedIds.has(r.id)) {
        if (mergePlan.leadColByKey.get(key) === col && !emitted.has(key)) {
          out.push(mergePlan.membersByKey.get(key)!);
          emitted.add(key);
        }
        continue;
      }
      out.push([r]);
    }
    return out;
  }

  function openLabDetail(row: LabCase, review = false) {
    setActiveRow(row);
    setAutoReview(review);
    queueMicrotask(() => dialogRef.current?.showModal());
  }
  function closeDialog() {
    dialogRef.current?.close();
    setActiveRow(null);
  }

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    function onClose() {
      setActiveRow(null);
    }
    el.addEventListener("close", onClose);
    return () => el.removeEventListener("close", onClose);
  }, []);

  // Background workers advance cases asynchronously (Approve → on PB ~10s
  // later; hourly scrapes stage results) — without this the board shows stale
  // lanes until a manual reload (the 2026-06-11 "manual upload stuck in
  // Pending Upload" confusion). router.refresh() re-pulls server data; client
  // state (open dialog, sorts, merge view) is untouched.
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 45_000);
    return () => clearInterval(id);
  }, [router]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-row flex-nowrap gap-1.5 pb-2 lg:flex-1 lg:min-h-0">
        {LAB_BOARD_COLUMN_ORDER.map((col) => {
          // Units actually rendered here. With merge-dupes a group's cards
          // collapse into one merged card in the group's lead column, so the
          // count reflects rendered units (not raw rows) — no ghost left behind.
          const units = sortUnits(unitsFor(col), sortByCol[col] ?? null);
          const renderUnit = (unit: LabCase[]) =>
            unit.length > 1 ? (
              <MergedDupCard
                key={`merged:${unit[0].id}`}
                rows={unit}
                mode={mergeMode}
                onOpen={openLabDetail}
                hasPendingPdf={unit.some((r) => pendingPdfSet.has(r.id))}
              />
            ) : (
              <LabCard
                key={unit[0].id}
                row={unit[0]}
                onOpen={openLabDetail}
                counts={counts?.[unit[0].id] ?? ZERO_COUNTS}
                dupSiblings={dupByCaseId.get(unit[0].id)}
                hasPendingPdf={pendingPdfSet.has(unit[0].id)}
              />
            );
          return (
            <StaticColumn
              key={col}
              col={col}
              count={units.length}
              isDropOver={dragOverCol === col}
              onCardDrop={handleDropCase}
              onColDragOver={setDragOverCol}
              sort={sortByCol[col] ?? null}
              onSortChange={(s) => setColumnSort(col, s)}
            >
              {units.length === 0 ? (
                <p className="px-2 py-3 text-[11px] text-zinc-400">—</p>
              ) : col === "untouched" ? (
                // TO DO: split into dated sections (today, tomorrow, …) so staff
                // scroll a week of work by date instead of one undifferentiated list.
                groupTodoByDate(units).map((g) => (
                  <Fragment key={`todo:${g.key}`}>
                    <div className="sticky top-0 z-10 -mx-0.5 border-b border-orange-200 bg-orange-100/95 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-orange-700 backdrop-blur">
                      {g.label}{" "}
                      <span className="font-normal normal-case text-orange-500/70">({g.items.length})</span>
                    </div>
                    {g.items.length ? (
                      g.items.map(renderUnit)
                    ) : (
                      <p className="px-2 py-1 text-[11px] text-zinc-300">—</p>
                    )}
                  </Fragment>
                ))
              ) : (
                units.map(renderUnit)
              )}
            </StaticColumn>
          );
        })}
      </div>

      <dialog
        ref={dialogRef}
        onClick={(e) => {
          // Click on the backdrop (the dialog element itself, outside the
          // content) closes the card. Clicks inside the content bubble up with
          // a different target, so they don't close it.
          if (e.target === e.currentTarget) closeDialog();
        }}
        className="w-full max-w-3xl rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40"
      >
        {activeRow ? (
          <div className="flex max-h-[88dvh] flex-col">
            <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-900">
                  {formatPersonName(activeRow.patient_name)}
                </h2>
                <p className="text-xs text-zinc-500">
                  {labelForCase(activeRow)}
                  {" · "}
                  {COLUMN_LABEL[getColumnFor(activeRow)]}
                </p>
              </div>
              <button
                type="button"
                onClick={closeDialog}
                aria-label="Close"
                className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
              >
                ×
              </button>
            </div>
            <div className="overflow-y-auto px-6 py-5">
              <CaseDetail
                // Render from the freshest row by id (router.refresh updates
                // `rows`); activeRow is only the "which card is open" pointer,
                // so without this an in-dialog edit wouldn't show until reopen.
                row={rows.find((r) => r.id === activeRow.id) ?? activeRow}
                initialOpenAttempts={counts?.[activeRow.id]?.openAttempts ?? 0}
                autoReview={autoReview}
                dupSiblings={dupByCaseId.get(activeRow.id)}
              />
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-6 py-3">
              <Link
                href={`/labs/${activeRow.id}`}
                className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
              >
                Open in full page →
              </Link>
              <button
                type="button"
                onClick={closeDialog}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
              >
                Close
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
