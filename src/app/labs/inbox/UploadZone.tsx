"use client";

import { useRef, useState, useTransition } from "react";
import { uploadInboundEmail } from "./actions";

export function UploadZone() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  function uploadFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter((f) =>
      f.name.toLowerCase().endsWith(".pdf"),
    );
    if (arr.length === 0) {
      setStatus("Only .pdf files are supported.");
      return;
    }
    setStatus(`Uploading ${arr.length} file(s)…`);
    startTransition(async () => {
      let okCount = 0;
      let errCount = 0;
      for (const f of arr) {
        const fd = new FormData();
        fd.append("file", f);
        const res = await uploadInboundEmail(fd);
        if (res.ok) okCount += 1;
        else errCount += 1;
      }
      setStatus(
        errCount === 0
          ? `Uploaded ${okCount} report(s). Parser results below.`
          : `Uploaded ${okCount}; ${errCount} failed.`,
      );
    });
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
      }}
      className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
        dragOver
          ? "border-blue-400 bg-blue-50"
          : "border-zinc-300 bg-white hover:border-zinc-400"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        multiple
        onChange={(e) => e.target.files && uploadFiles(e.target.files)}
        className="hidden"
      />
      <p className="text-sm text-zinc-700">
        Drop a lab report PDF here, or{" "}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="font-medium text-blue-600 underline-offset-2 hover:underline"
        >
          browse
        </button>
        .
      </p>
      <p className="text-xs text-zinc-500">
        PDF only · 10 MB max · Claude extracts patient + result data
      </p>
      {status ? (
        <p
          className={`mt-2 text-xs ${
            pending ? "text-zinc-500" : "text-zinc-700"
          }`}
        >
          {status}
        </p>
      ) : null}
    </div>
  );
}
