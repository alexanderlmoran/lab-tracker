"use client";

import { useTransition } from "react";
import type { LabCase } from "@/lib/types";
import { CaseDialog } from "./CaseDialog";
import {
  archiveLabCase,
  deleteLabCase,
  restoreLabCase,
  unarchiveLabCase,
} from "./actions";
import { pushLabToPracticeBetter } from "./practicebetter-actions";

export function CaseRowActions({ row }: { row: LabCase }) {
  const [pending, startTransition] = useTransition();

  function onPushPB(kind: "partial" | "complete" | "manual") {
    startTransition(async () => {
      const r = await pushLabToPracticeBetter({
        caseId: row.id,
        kind,
        force: true,
      });
      if (!r.ok) {
        alert(`PracticeBetter push failed: ${r.error}`);
        return;
      }
      const d = r.data;
      if (d?.skippedReason) {
        alert(`Skipped: ${d.skippedReason} (record ${d.recordId || "—"})`);
      } else if (d?.createdNewRecord) {
        alert(`Created new PB client record ${d.recordId} and pushed lab note.`);
      } else {
        alert(`Pushed to PB record ${d?.recordId}.`);
      }
    });
  }

  function onArchive() {
    if (!confirm(`Archive case for ${row.patient_name}?`)) return;
    startTransition(async () => {
      const r = await archiveLabCase(row.id);
      if (!r.ok) alert(r.error);
    });
  }

  function onUnarchive() {
    startTransition(async () => {
      const r = await unarchiveLabCase(row.id);
      if (!r.ok) alert(r.error);
    });
  }

  function onDelete() {
    if (
      !confirm(
        `Delete case for ${row.patient_name}? It will move to the Deleted folder and can be restored.`,
      )
    )
      return;
    startTransition(async () => {
      const r = await deleteLabCase(row.id);
      if (!r.ok) alert(r.error);
    });
  }

  function onRestore() {
    startTransition(async () => {
      const r = await restoreLabCase(row.id);
      if (!r.ok) alert(r.error);
    });
  }

  const archived = row.archived_at !== null;
  const deleted = row.deleted_at !== null;

  return (
    <div className="flex items-center justify-end gap-2">
      {!deleted ? (
        <CaseDialog
          mode="edit"
          initial={row}
          triggerLabel="Edit"
          triggerClassName="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
        />
      ) : null}
      {deleted ? (
        <button
          type="button"
          onClick={onRestore}
          disabled={pending}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
        >
          Restore
        </button>
      ) : archived ? (
        <>
          <button
            type="button"
            onClick={onUnarchive}
            disabled={pending}
            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
          >
            Unarchive
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={pending}
            className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-60"
          >
            Delete
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => onPushPB("manual")}
            disabled={pending}
            title={
              row.practicebetter_record_id
                ? `PB record: ${row.practicebetter_record_id}`
                : "Looks up PB client by patient email and appends a lab note."
            }
            className="rounded-md border border-indigo-200 bg-white px-2.5 py-1 text-xs text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
          >
            Send to PB
          </button>
          <button
            type="button"
            onClick={onArchive}
            disabled={pending}
            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
          >
            Archive
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={pending}
            className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-60"
          >
            Delete
          </button>
        </>
      )}
    </div>
  );
}
