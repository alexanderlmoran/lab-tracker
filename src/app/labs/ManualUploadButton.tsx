"use client";

import { useRef, useState, useTransition } from "react";
import { getManualUploadUrl, recordResultPdf } from "./probe-actions";

// Pick a PDF from disk and post it on a case — the manual fallback for any
// lab the scraper can't pull (no scraper, EBOO, session-down, etc.). The
// upload is auto-approved (the uploader is the reviewer) and queued straight
// to PracticeBetter; the card lands in Complete Uploaded when PB confirms.
export function ManualUploadButton({
  caseId,
  onUploaded,
  label = "Upload result PDF",
}: {
  caseId: string;
  onUploaded?: () => void;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Pick a PDF file.");
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setError("PDF too large (max 50 MB).");
      return;
    }
    setError(null);
    start(async () => {
      try {
        // Direct-to-storage: mint a signed URL, PUT the file STRAIGHT to Supabase
        // Storage, then record it by path — the bytes never go through a server
        // action, so there's no body-size cap (the old base64 path crashed the
        // page on PDFs over ~4.5 MB on Vercel).
        const urlRes = await getManualUploadUrl(caseId, file.name);
        if (!urlRes.ok || !urlRes.data) {
          setError((!urlRes.ok && urlRes.error) || "Couldn't start the upload");
          return;
        }
        const put = await fetch(urlRes.data.uploadUrl, {
          method: "PUT",
          headers: { "content-type": "application/pdf" },
          body: file,
        });
        if (!put.ok) {
          setError(`Upload failed (${put.status}) — try again.`);
          return;
        }
        const rec = await recordResultPdf({
          caseId,
          storagePath: urlRes.data.storagePath,
          filename: file.name,
          sizeBytes: file.size,
        });
        if (!rec.ok) {
          setError(rec.error ?? "Upload failed");
          return;
        }
        onUploaded?.();
      } catch {
        setError("Upload failed — try again.");
      }
    });
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={onPick} />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title="Pick a result PDF from your computer — it posts to PracticeBetter without a separate Approve"
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
      >
        {busy ? "Uploading…" : `⬆ ${label}`}
      </button>
      {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
    </span>
  );
}
