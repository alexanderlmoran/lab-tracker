"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ToolbarSelect } from "../ToolbarSelect";
import {
  PHLEB_COLUMN_LABEL,
  PHLEB_COLUMN_ORDER,
  formatApptDateTime,
  formatPrice,
  getPhlebColumnFor,
  summarizeLabs,
  vendorLabel,
  type PhlebColumnKey,
} from "@/lib/phlebotomy";
import { addCaseToPhlebotomy, type PhlebApptRow } from "./actions";
import { PhlebApptDrawer } from "./PhlebApptDrawer";

type Addable = {
  id: string;
  patient_name: string;
  lab_name: string;
  collection_date: string | null;
};

function Chip({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "muted" | "ok" | "warn";
}) {
  const cls =
    tone === "ok"
      ? "bg-emerald-50 text-emerald-700"
      : tone === "warn"
        ? "bg-amber-50 text-amber-800"
        : tone === "muted"
          ? "bg-zinc-50 text-zinc-500"
          : "bg-zinc-100 text-zinc-600";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{children}</span>;
}

function PhlebCard({ row, onOpen }: { row: PhlebApptRow; onOpen: () => void }) {
  const apptStr = formatApptDateTime(row.appt_at);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="kanban-card w-full rounded-lg border border-zinc-200 bg-white p-2 text-left shadow-sm transition-colors hover:border-zinc-300 hover:bg-zinc-50"
    >
      <div className="truncate text-xs font-semibold text-zinc-900">{row.patient_name}</div>
      <div className="text-[11px] text-zinc-500">
        {row.labs.length ? (
          <span className="line-clamp-2">{summarizeLabs(row.labs)}</span>
        ) : (
          <span className="text-zinc-400">no labs linked</span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {row.vendor ? <Chip>{vendorLabel(row.vendor, row.vendor_other)}</Chip> : null}
        {apptStr ? <Chip>{apptStr}</Chip> : null}
        {row.price_cents != null ? <Chip>{formatPrice(row.price_cents)}</Chip> : null}
        {row.patient_window && !row.appt_at ? <Chip tone="muted">{row.patient_window}</Chip> : null}
        {row.req_forwarded_at ? <Chip tone="ok">req sent</Chip> : null}
        {row.canceled_at && row.status === "canceled" ? <Chip tone="warn">canceled — rebook</Chip> : null}
      </div>
    </button>
  );
}

export function PhlebotomyBoard({ rows, addable }: { rows: PhlebApptRow[]; addable: Addable[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Track the open appointment by case id (not the row object) so the drawer
  // always reads the freshest row after an action + router.refresh() — a stored
  // object reference would go stale and show pre-mutation data.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRow = selectedId ? rows.find((r) => r.case_id === selectedId) ?? null : null;

  // Group into the five lanes; sort each by appointment time then name so the
  // soonest draws sit at the top.
  const byCol = new Map<PhlebColumnKey, PhlebApptRow[]>();
  for (const col of PHLEB_COLUMN_ORDER) byCol.set(col, []);
  for (const r of rows) byCol.get(getPhlebColumnFor(r.status))!.push(r);
  for (const list of byCol.values()) {
    list.sort((a, b) => {
      const at = a.appt_at ?? "";
      const bt = b.appt_at ?? "";
      if (at && bt && at !== bt) return at.localeCompare(bt);
      if (at && !bt) return -1;
      if (!at && bt) return 1;
      return a.patient_name.localeCompare(b.patient_name);
    });
  }

  const totalCost = rows.reduce((s, r) => s + (r.price_cents ?? 0), 0);

  const addOptions = [
    { value: "", label: "Add a case…" },
    ...addable.map((a) => ({
      value: a.id,
      label: `${a.patient_name} — ${a.lab_name}${a.collection_date ? ` (${a.collection_date})` : ""}`,
    })),
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <ToolbarSelect
          ariaLabel="Add a case to mobile phlebotomy"
          value=""
          options={addOptions}
          onChange={(id) => {
            if (!id) return;
            startTransition(async () => {
              await addCaseToPhlebotomy(id);
              router.refresh();
            });
          }}
        />
        <span className="text-xs text-zinc-500">
          {rows.length} appointment{rows.length === 1 ? "" : "s"} · tracked cost {formatPrice(totalCost)}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center">
          <p className="text-sm text-zinc-600">No mobile-phlebotomy draws in progress.</p>
          <p className="mt-1 text-xs text-zinc-500">
            Use <span className="font-medium">Add a case…</span> to schedule a phlebotomist for a patient who can&apos;t self-draw.
          </p>
        </div>
      ) : (
        <div className="grid flex-1 grid-cols-5 gap-2 lg:min-h-0">
          {PHLEB_COLUMN_ORDER.map((col) => {
            const units = byCol.get(col)!;
            return (
              <section key={col} className="kanban-col flex min-w-0 flex-col p-1.5 lg:min-h-0" data-col={col}>
                <header className="flex items-start gap-1 px-1.5 pb-1.5 pt-1">
                  <h3 className="col-head-title min-w-0 flex-1">
                    <span className="col-count-dot">{units.length}</span>
                    <span className="min-w-0 flex-1 text-center">{PHLEB_COLUMN_LABEL[col]}</span>
                  </h3>
                </header>
                <div className="mt-1.5 flex min-h-[40px] flex-col gap-1.5 p-0.5 lg:flex-1 lg:overflow-y-auto">
                  {units.length === 0
                    ? null
                    : units.map((r) => <PhlebCard key={r.case_id} row={r} onOpen={() => setSelectedId(r.case_id)} />)}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <PhlebApptDrawer row={selectedRow} onClose={() => setSelectedId(null)} />
    </div>
  );
}
