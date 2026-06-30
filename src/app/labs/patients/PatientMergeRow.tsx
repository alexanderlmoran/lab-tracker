"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { mergePatients } from "./actions";

type Member = { email: string; caseCount: number };

/** One potential-duplicate group: pick which email survives, merge the rest in.
 *  Human-approved — nothing happens until "Merge" is clicked. */
export function PatientMergeRow({ groupId, name, members }: { groupId: string; name: string; members: Member[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [canonical, setCanonical] = useState(members[0]?.email ?? "");
  const [err, setErr] = useState<string | null>(null);

  function merge() {
    setErr(null);
    const aliases = members.filter((m) => m.email !== canonical);
    startTransition(async () => {
      for (const a of aliases) {
        const res = await mergePatients({ aliasEmail: a.email, canonicalEmail: canonical });
        if (!res.ok) {
          setErr(res.error);
          return;
        }
      }
      router.refresh();
    });
  }

  return (
    <li className="rounded-md border border-amber-200 bg-white p-2">
      <div className="text-xs font-semibold text-zinc-900">{name}</div>
      <div className="mt-1 space-y-0.5">
        {members.map((m) => (
          <label key={m.email} className="flex items-center gap-2 text-[11px] text-zinc-700">
            <input
              type="radio"
              name={`canon-${groupId}`}
              checked={canonical === m.email}
              onChange={() => setCanonical(m.email)}
            />
            <span className="min-w-0 flex-1 truncate">
              {m.email} <span className="text-zinc-400">({m.caseCount} case{m.caseCount === 1 ? "" : "s"})</span>
            </span>
            <span className={canonical === m.email ? "text-emerald-600" : "text-zinc-400"}>
              {canonical === m.email ? "keep" : "→ merge in"}
            </span>
          </label>
        ))}
      </div>
      {err ? <p className="mt-1 text-[11px] text-rose-600">{err}</p> : null}
      <button
        type="button"
        disabled={pending}
        onClick={merge}
        className="mt-1.5 rounded border border-amber-400 bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-200 disabled:opacity-50"
      >
        {pending ? "Merging…" : "Merge into selected"}
      </button>
    </li>
  );
}
