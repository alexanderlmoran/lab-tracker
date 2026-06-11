"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { confirmIvMatchAndPost, enqueueIvPost, markIvAlreadyDone, type HeldIvPost } from "./actions";

const PB_URL = "https://my.practicebetter.io";

/** IV posts the worker held for a human to resolve (low-confidence match, no
 *  template, etc.). Lets staff re-try or vouch for the matched patient. */
export function HeldReview({ held }: { held: HeldIvPost[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (held.length === 0) return null;

  const run = (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } finally {
        setBusyId(null);
      }
    });
  };

  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50">
      <div className="border-b border-amber-200 px-4 py-2 text-sm font-semibold text-amber-900">
        Needs review — {held.length} post{held.length === 1 ? "" : "s"} held
        <span className="ml-2 font-normal text-amber-700">(the worker couldn&apos;t confidently match the patient or template)</span>
      </div>
      <ul className="divide-y divide-amber-200">
        {held.map((h) => {
          const busy = pending && busyId === h.jobId;
          return (
            <li key={h.jobId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
              <span className="font-medium text-zinc-900">{h.patientName ?? "—"}</span>
              <span className="text-zinc-600">{h.serviceName}</span>
              <span className="tabular-nums text-zinc-500">{h.sessionDate}</span>
              <span className="text-xs text-amber-800">
                {h.matchScore != null ? `score ${h.matchScore} · ` : ""}
                {h.matchReason ?? "held"}
              </span>
              <span className="ml-auto flex items-center gap-2">
                <a
                  href={PB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
                  title="Open PracticeBetter to search the chart / account notes"
                >
                  PB ↗
                </a>
                <Link href={`/labs/iv/${h.sessionId}`} className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100">
                  Open
                </Link>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(h.jobId, () => markIvAlreadyDone(h.sessionId))}
                  className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
                  title="Already charted by hand in PB — dismiss from review"
                >
                  {busy ? "…" : "Already done"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(h.jobId, () => enqueueIvPost(h.sessionId))}
                  className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
                >
                  {busy ? "…" : "Re-try"}
                </button>
                {h.candidateId && !h.isTie && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(h.jobId, () => confirmIvMatchAndPost(h.sessionId, h.candidateId!))}
                    className="rounded bg-amber-700 px-2 py-0.5 text-xs font-medium text-white hover:bg-amber-800 disabled:opacity-50"
                    title="Vouch for the matched PB patient and post to it"
                  >
                    {busy ? "…" : "Confirm & post"}
                  </button>
                )}
                {h.isTie && <span className="text-xs text-red-700" title="Two close candidates — open the chart and verify the patient by hand">⚠ ambiguous</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
