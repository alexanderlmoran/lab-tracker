"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LabCase } from "@/lib/types";
import { CaseDialog } from "./CaseDialog";
import { formatPersonName } from "@/lib/format";
import {
  archiveLabCase,
  deleteLabCase,
  restoreLabCase,
  unarchiveLabCase,
} from "./actions";
export function CaseRowActions({ row }: { row: LabCase }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onArchive() {
    if (!confirm(`Archive case for ${formatPersonName(row.patient_name)}?`)) return;
    startTransition(async () => {
      const r = await archiveLabCase(row.id);
      if (!r.ok) {
        alert(r.error);
        return;
      }
      router.refresh();
    });
  }

  function onUnarchive() {
    startTransition(async () => {
      const r = await unarchiveLabCase(row.id);
      if (!r.ok) {
        alert(r.error);
        return;
      }
      router.refresh();
    });
  }

  function onDelete() {
    if (
      !confirm(
        `Delete case for ${formatPersonName(row.patient_name)}? It will move to the Deleted folder and can be restored.`,
      )
    )
      return;
    startTransition(async () => {
      const r = await deleteLabCase(row.id);
      if (!r.ok) {
        alert(r.error);
        return;
      }
      router.refresh();
    });
  }

  function onRestore() {
    startTransition(async () => {
      const r = await restoreLabCase(row.id);
      if (!r.ok) {
        alert(r.error);
        return;
      }
      router.refresh();
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
