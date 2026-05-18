"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition, type FormEvent } from "react";

export function SalesFilters({
  q,
  format,
  since,
  until,
}: {
  q: string;
  format: "all" | "guest-sales" | "item-sales";
  since: string;
  until: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [, startTransition] = useTransition();

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(sp.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    startTransition(() => {
      router.replace(qs ? `/labs/sales?${qs}` : "/labs/sales");
    });
  }

  function onSubmitSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setParam("q", String(form.get("q") ?? ""));
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white p-2">
      <form onSubmit={onSubmitSearch} className="flex flex-1 min-w-[200px] items-center gap-1">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search guest, email, invoice, item…"
          className="w-full rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-900 outline-none focus:border-zinc-400"
        />
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-800"
        >
          Search
        </button>
      </form>

      <select
        value={format}
        onChange={(e) => setParam("format", e.target.value === "all" ? "" : e.target.value)}
        className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700"
      >
        <option value="all">All formats</option>
        <option value="guest-sales">Guest-sales</option>
        <option value="item-sales">Item-sales</option>
      </select>

      <label className="flex items-center gap-1 text-xs text-zinc-600">
        From
        <input
          type="date"
          value={since}
          onChange={(e) => setParam("since", e.target.value)}
          className="rounded-md border border-zinc-300 px-1.5 py-1 text-xs"
        />
      </label>
      <label className="flex items-center gap-1 text-xs text-zinc-600">
        To
        <input
          type="date"
          value={until}
          onChange={(e) => setParam("until", e.target.value)}
          className="rounded-md border border-zinc-300 px-1.5 py-1 text-xs"
        />
      </label>

      {q || format !== "all" || since || until ? (
        <button
          type="button"
          onClick={() => {
            startTransition(() => router.replace("/labs/sales"));
          }}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
