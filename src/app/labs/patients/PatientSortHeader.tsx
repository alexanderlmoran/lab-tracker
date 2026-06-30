"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/** Clickable sortable column header for the patients table — mirrors the kanban
 *  sort arrows. Sort state lives in the URL (?psort=field&pdir=asc|desc) so it's
 *  shareable and survives refresh. Click toggles direction; default is activity-
 *  desc (handled in the page). */
export function PatientSortHeader({
  field,
  label,
  align = "left",
}: {
  field: "name" | "cases" | "activity";
  label: string;
  align?: "left" | "right";
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [, startTransition] = useTransition();

  const curField = sp.get("psort") ?? "activity";
  const curDir = sp.get("pdir") === "asc" ? "asc" : "desc";
  const active = curField === field;
  const arrow = active ? (curDir === "asc" ? "↑" : "↓") : "↕";

  function toggle() {
    const params = new URLSearchParams(sp.toString());
    params.set("psort", field);
    params.set("pdir", active && curDir === "asc" ? "desc" : "asc");
    startTransition(() => router.replace(`/labs/patients?${params.toString()}`));
  }

  return (
    <th className={`px-4 py-2 font-semibold ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={toggle}
        className={`inline-flex items-center gap-1 ${active ? "text-zinc-900" : "text-zinc-600"} hover:text-zinc-900`}
      >
        {label}
        <span className="text-[10px] text-zinc-400">{arrow}</span>
      </button>
    </th>
  );
}
