"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LabCase, ActionResult } from "@/lib/types";
import { CaseFormFields } from "./CaseFormFields";
import { NewCaseFormFields } from "./NewCaseFormFields";
import { createLabCases, updateLabCase } from "./actions";

type Props = {
  mode: "create" | "edit";
  initial?: LabCase | null;
  triggerLabel: string;
  triggerClassName?: string;
};

export function CaseDialog({
  mode,
  initial,
  triggerLabel,
  triggerClassName,
}: Props) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Bumped each time the dialog opens so the inner form remounts with fresh
  // state — otherwise the previous patient's name/email/lab linger on the
  // next "New case" click (the <dialog> element doesn't unmount on close).
  const [formKey, setFormKey] = useState(0);

  function open() {
    setError(null);
    if (mode === "create") setFormKey((k) => k + 1);
    ref.current?.showModal();
  }

  function close() {
    ref.current?.close();
  }

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    const onCancel = () => setError(null);
    dlg.addEventListener("cancel", onCancel);
    return () => dlg.removeEventListener("cancel", onCancel);
  }, []);

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result: ActionResult<unknown> =
        mode === "create"
          ? await createLabCases(formData)
          : await updateLabCase(initial!.id, formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      close();
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        className={
          triggerClassName ??
          "rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-800"
        }
      >
        {triggerLabel}
      </button>

      <dialog
        ref={ref}
        className="fixed inset-0 m-auto w-full max-w-2xl rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40"
      >
        <form action={onSubmit} className="flex max-h-[85dvh] flex-col">
          <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
            <h2 className="text-base font-semibold text-zinc-900">
              {mode === "create" ? "New case" : "Edit case"}
            </h2>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
            >
              ×
            </button>
          </div>

          <div className="overflow-y-auto px-6 py-4">
            {mode === "create" ? (
              <NewCaseFormFields key={formKey} />
            ) : (
              <CaseFormFields key={formKey} initial={initial} />
            )}
            {error ? (
              <p className="mt-4 text-sm text-red-600" role="alert">
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-6 py-4">
            <button
              type="button"
              onClick={close}
              disabled={pending}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
            >
              {pending
                ? "Saving…"
                : mode === "create"
                  ? "Create cases"
                  : "Save changes"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
