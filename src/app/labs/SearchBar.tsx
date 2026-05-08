"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

export function SearchBar({ labNames }: { labNames: string[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const [lab, setLab] = useState(searchParams.get("lab") ?? "");
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

  function onLabChange(value: string) {
    setLab(value);
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("lab", value);
    else params.delete("lab");
    const next = params.toString();
    startTransition(() => {
      router.replace(next ? `/labs?${next}` : "/labs");
    });
  }

  function onClear() {
    setQ("");
    setLab("");
    startTransition(() => {
      router.replace("/labs");
    });
  }

  const hasFilters = q.length > 0 || lab.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 bg-white p-2">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search patient name, email, or tracking #"
        className="min-w-[240px] flex-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none"
      />
      <select
        value={lab}
        onChange={(e) => onLabChange(e.target.value)}
        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none"
      >
        <option value="">All labs</option>
        {labNames.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      {hasFilters ? (
        <button
          type="button"
          onClick={onClear}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
