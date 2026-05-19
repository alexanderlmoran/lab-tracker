"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import type { LabCase } from "@/lib/types";
import {
  COLUMN_LABEL,
  COLUMN_ORDER,
  completedStepCount,
  getCaseStaleness,
  getColumnFor,
  type ColumnKey,
} from "@/lib/columns";
import { CaseDetail } from "./CaseDetail";
import { archiveLabCase } from "./actions";
import { formatPersonName } from "@/lib/format";
import type { EmailConfirmHandle } from "./EmailConfirmDialog";
import type { ColumnJumpHandle } from "./ColumnJumpDialog";

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * SSR-safe relative time. Server renders empty (Date.now() differs between
 * server and client by enough to flip the rounded minute count), then the
 * client fills in after mount.
 */
function RelativeTime({ iso }: { iso: string }) {
  const [text, setText] = useState<string>("");
  useEffect(() => {
    setText(timeAgo(iso));
    const id = setInterval(() => setText(timeAgo(iso)), 30_000);
    return () => clearInterval(id);
  }, [iso]);
  return <>{text}</>;
}

export function CaseCard({
  row,
  emailDialogRef,
  columnJumpRef,
}: {
  row: LabCase;
  emailDialogRef?: React.RefObject<EmailConfirmHandle | null>;
  columnJumpRef?: React.RefObject<ColumnJumpHandle | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveSubOpen, setMoveSubOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const cardRef = useRef<HTMLDivElement | null>(null);

  function openDialog() {
    dialogRef.current?.showModal();
  }
  function closeDialog() {
    dialogRef.current?.close();
  }

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!cardRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setMoveSubOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  function onArchive() {
    setMenuOpen(false);
    if (!confirm(`Archive case for ${formatPersonName(row.patient_name)}?`)) return;
    startTransition(async () => {
      const res = await archiveLabCase(row.id);
      if (!res.ok) alert(res.error);
    });
  }

  async function onMoveTo(target: ColumnKey) {
    setMenuOpen(false);
    setMoveSubOpen(false);
    if (!emailDialogRef?.current || !columnJumpRef?.current) {
      alert("Move-to is unavailable here.");
      return;
    }
    await columnJumpRef.current.open({
      row,
      target,
      emailDialog: emailDialogRef.current,
    });
  }

  const done = completedStepCount(row);
  const currentCol = getColumnFor(row);
  const staleness = getCaseStaleness(row);

  return (
    <>
      <div
        ref={cardRef}
        className="group relative rounded-md border border-zinc-200 bg-white p-3 shadow-sm transition-shadow hover:shadow"
        onClick={(e) => {
          // Ignore clicks on the kebab area or buttons within
          if ((e.target as HTMLElement).closest("[data-menu]")) return;
          if ((e.target as HTMLElement).closest("button")) return;
          openDialog();
        }}
        style={{ cursor: "pointer" }}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h4 className="truncate text-sm font-medium text-zinc-900">
              {formatPersonName(row.patient_name)}
            </h4>
            <p className="truncate text-xs text-zinc-500">
              {row.lab_name}
              {row.lab_panel ? ` · ${row.lab_panel}` : ""}
              {row.tracking_number ? ` · TRK ${row.tracking_number}` : ""}
            </p>
          </div>
          <div data-menu className="relative" onPointerDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              aria-label="Card actions"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
                setMoveSubOpen(false);
              }}
              className="rounded p-1 text-zinc-400 opacity-60 transition-opacity hover:bg-zinc-100 hover:text-zinc-900 group-hover:opacity-100"
            >
              ⋮
            </button>
            {menuOpen ? (
              <div className="absolute right-0 top-7 z-10 w-48 overflow-visible rounded-md border border-zinc-200 bg-white text-xs shadow-lg">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    openDialog();
                  }}
                  className="block w-full px-3 py-2 text-left text-zinc-700 hover:bg-zinc-50"
                >
                  Open detail
                </button>
                <Link
                  href={`/labs/${row.id}`}
                  className="block w-full px-3 py-2 text-left text-zinc-700 hover:bg-zinc-50"
                  onClick={() => setMenuOpen(false)}
                >
                  Open in full page
                </Link>

                {emailDialogRef && columnJumpRef ? (
                  <div className="relative">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMoveSubOpen((v) => !v);
                      }}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-zinc-700 hover:bg-zinc-50"
                    >
                      <span>Move to</span>
                      <span className="text-zinc-400">▸</span>
                    </button>
                    {moveSubOpen ? (
                      <div className="absolute left-full top-0 z-20 ml-1 w-44 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg">
                        {COLUMN_ORDER.map((col) => (
                          <button
                            key={col}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void onMoveTo(col);
                            }}
                            disabled={col === currentCol}
                            className="block w-full px-3 py-2 text-left text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {COLUMN_LABEL[col]}
                            {col === currentCol ? " (current)" : ""}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onArchive();
                  }}
                  disabled={pending}
                  className="block w-full px-3 py-2 text-left text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                >
                  Archive
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex items-center justify-end">
          <span className="text-[11px] text-zinc-500">{done} / 9</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <p className="text-[11px] text-zinc-400">
            Updated <RelativeTime iso={row.updated_at} />
          </p>
          {staleness.stale ? (
            <span
              title={`No progress in ${staleness.daysSinceProgress} days`}
              className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800"
            >
              Stale · {staleness.daysSinceProgress}d
            </span>
          ) : null}
        </div>
      </div>

      <dialog
        ref={dialogRef}
        className="w-full max-w-3xl rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40"
      >
        <div className="flex max-h-[88dvh] flex-col">
          <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
            <div>
              <h2 className="text-base font-semibold text-zinc-900">
                {formatPersonName(row.patient_name)}
              </h2>
              <p className="text-xs text-zinc-500">{row.patient_email}</p>
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
            <CaseDetail row={row} />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-6 py-3">
            <Link
              href={`/labs/${row.id}`}
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
      </dialog>
    </>
  );
}
