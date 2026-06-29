"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

export function SearchBar() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const [, startTransition] = useTransition();

  // Debounce search input → URL push.
  useEffect(() => {
    const handle = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (q) params.set("q", q);
      else params.delete("q");
      const next = params.toString();
      const current = searchParams.toString();
      if (next !== current) {
        startTransition(() => {
          router.replace(next ? `/labs?${next}` : "/labs");
        });
      }
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function onClear() {
    setQ("");
    // Clear only the search-related filters (text + lab + test); leave the time
    // range, merge view, date grouping and tab intact so the board doesn't
    // silently snap back to defaults the user didn't touch.
    const params = new URLSearchParams(searchParams.toString());
    params.delete("q");
    params.delete("lab");
    params.delete("test");
    const next = params.toString();
    startTransition(() => {
      router.replace(next ? `/labs?${next}` : "/labs");
    });
  }

  // Show the clear-X when the search text OR the (now-separate) lab / test
  // filters are active — clearing still resets everything.
  const hasFilters =
    q.length > 0 || !!searchParams.get("lab") || !!searchParams.get("test");

  return (
    <div className="relative flex w-full items-center">
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search name, email, test, or tracking #"
        className="w-full min-w-[180px] rounded-md border border-zinc-300 bg-white py-1.5 pl-2.5 pr-8 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none"
      />
      {hasFilters ? (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear search"
          title="Clear search"
          className="absolute right-1.5 flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
