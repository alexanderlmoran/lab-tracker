"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Main-page notification for new inbound lab emails (backlog #15). The nav
// badge in HudPulse is always-on; this is the louder, dismissible banner the
// operator sees first thing on /labs. Dismissal is keyed by the current count
// so a freshly-arrived email re-surfaces the banner even after a prior dismiss.
const DISMISS_KEY = "labs.inboxNotice.dismissedCount";

export function InboxNotice({ count }: { count: number }) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (count <= 0) {
      setDismissed(true);
      return;
    }
    let prior = 0;
    try {
      prior = Number(sessionStorage.getItem(DISMISS_KEY) ?? "0") || 0;
    } catch {
      prior = 0;
    }
    // Re-show whenever the count climbs past what was last dismissed.
    setDismissed(count <= prior);
  }, [count]);

  if (count <= 0 || dismissed) return null;

  const onDismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, String(count));
    } catch {
      /* ignore storage failures — banner just won't persist its dismissal */
    }
    setDismissed(true);
  };

  return (
    <div className="mb-3 flex items-center gap-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">
      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-indigo-600 px-1.5 text-[11px] font-semibold text-white">
        {count}
      </span>
      <span className="text-indigo-900">
        {count === 1 ? "new lab email" : "new lab emails"} waiting in the inbox —
        review to post results.
      </span>
      <Link
        href="/labs/inbox"
        className="ml-auto rounded-md border border-indigo-300 bg-white px-2.5 py-1 text-[11px] font-medium text-indigo-800 hover:bg-indigo-100"
      >
        Open inbox →
      </Link>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="rounded-md px-1.5 py-1 text-[11px] font-medium text-indigo-500 hover:text-indigo-800"
      >
        ✕
      </button>
    </div>
  );
}
