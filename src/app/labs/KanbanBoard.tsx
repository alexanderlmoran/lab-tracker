"use client";

import { useRef, useState, useTransition } from "react";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { LabCase } from "@/lib/types";
import {
  COLUMN_LABEL,
  COLUMN_ORDER,
  type ColumnKey,
  getColumnFor,
} from "@/lib/columns";
import { CaseCard } from "./CaseCard";
import {
  ColumnJumpDialog,
  type ColumnJumpHandle,
} from "./ColumnJumpDialog";
import {
  EmailConfirmDialog,
  type EmailConfirmHandle,
} from "./EmailConfirmDialog";
import { bulkArchive, bulkDelete } from "./actions";

function DroppableColumn({
  col,
  count,
  children,
  isOver,
}: {
  col: ColumnKey;
  count: number;
  children: React.ReactNode;
  isOver: boolean;
}) {
  const { setNodeRef } = useDroppable({ id: `col:${col}` });
  return (
    <section
      ref={setNodeRef}
      className={`flex flex-col rounded-lg p-2 transition-colors ${
        isOver ? "bg-zinc-200" : "bg-zinc-100/60"
      }`}
    >
      <header className="flex items-center justify-between px-2 py-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-700">
          {COLUMN_LABEL[col]}
        </h3>
        <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-600">
          {count}
        </span>
      </header>
      <div className="flex min-h-[40px] flex-col gap-2 p-1">{children}</div>
    </section>
  );
}

function DraggableCardWrapper({
  row,
  emailDialogRef,
  columnJumpRef,
  selectMode,
  selected,
  onToggleSelect,
}: {
  row: LabCase;
  emailDialogRef: React.RefObject<EmailConfirmHandle | null>;
  columnJumpRef: React.RefObject<ColumnJumpHandle | null>;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `card:${row.id}`,
    disabled: selectMode,
  });

  if (selectMode) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => onToggleSelect(row.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleSelect(row.id);
          }
        }}
        className={`relative cursor-pointer rounded-md transition-shadow ${
          selected ? "ring-2 ring-blue-500" : "hover:ring-1 hover:ring-zinc-300"
        }`}
      >
        <span
          aria-hidden
          className={`absolute left-2 top-2 z-10 flex h-4 w-4 items-center justify-center rounded border ${
            selected
              ? "border-blue-500 bg-blue-500 text-white"
              : "border-zinc-300 bg-white"
          }`}
        >
          {selected ? (
            <svg viewBox="0 0 12 12" className="h-3 w-3">
              <path
                d="M2 6.5l2.5 2.5L10 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
        </span>
        <div className="pointer-events-none">
          <CaseCard row={row} />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        opacity: isDragging ? 0.4 : 1,
        cursor: "grab",
      }}
    >
      <CaseCard
        row={row}
        emailDialogRef={emailDialogRef}
        columnJumpRef={columnJumpRef}
      />
    </div>
  );
}

export function KanbanBoard({ rows }: { rows: LabCase[] }) {
  const emailDialogRef = useRef<EmailConfirmHandle | null>(null);
  const columnJumpRef = useRef<ColumnJumpHandle | null>(null);
  const [overCol, setOverCol] = useState<ColumnKey | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [, startBulk] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  function onBulkArchive() {
    if (selected.size === 0) return;
    if (!confirm(`Archive ${selected.size} selected case(s)?`)) return;
    startBulk(async () => {
      const r = await bulkArchive({ caseIds: [...selected] });
      if (!r.ok) alert(r.error);
      exitSelectMode();
    });
  }

  function onBulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} selected case(s)? They can be restored.`))
      return;
    startBulk(async () => {
      const r = await bulkDelete({ caseIds: [...selected] });
      if (!r.ok) alert(r.error);
      exitSelectMode();
    });
  }

  const grouped: Record<ColumnKey, LabCase[]> = {
    untouched: [],
    sample_sent: [],
    partial_results: [],
    complete_results: [],
    rof_scheduled: [],
    rof_done: [],
    closed: [],
  };
  for (const row of rows) grouped[getColumnFor(row)].push(row);

  function onDragStart(_e: DragStartEvent) {
    setOverCol(null);
  }

  async function onDragEnd(e: DragEndEvent) {
    setOverCol(null);
    const overId = e.over?.id;
    if (!overId || typeof overId !== "string" || !overId.startsWith("col:"))
      return;
    const target = overId.slice("col:".length) as ColumnKey;

    const cardId = String(e.active.id).slice("card:".length);
    const row = rows.find((r) => r.id === cardId);
    if (!row) return;

    const current = getColumnFor(row);
    if (current === target) return;

    if (!emailDialogRef.current || !columnJumpRef.current) return;

    await columnJumpRef.current.open({
      row,
      target,
      emailDialog: emailDialogRef.current,
    });
  }

  function onDragOver(e: { over: { id: string | number } | null }) {
    const overId = e.over?.id;
    if (typeof overId === "string" && overId.startsWith("col:")) {
      setOverCol(overId.slice("col:".length) as ColumnKey);
    } else {
      setOverCol(null);
    }
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs text-zinc-500">
          {selectMode
            ? `${selected.size} selected`
            : "Drag cards between columns, or use Select to bulk-act."}
        </div>
        <div className="flex items-center gap-2">
          {selectMode ? (
            <>
              <button
                type="button"
                onClick={() =>
                  setSelected((s) =>
                    s.size === rows.length
                      ? new Set()
                      : new Set(rows.map((r) => r.id)),
                  )
                }
                className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
              >
                {selected.size === rows.length ? "Clear" : "Select all"}
              </button>
              <button
                type="button"
                onClick={exitSelectMode}
                className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setSelectMode(true)}
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
            >
              Select multiple
            </button>
          )}
        </div>
      </div>

      <DndContext
        id="kanban-dnd"
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragCancel={() => setOverCol(null)}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-7">
          {COLUMN_ORDER.map((col) => {
            const cards = grouped[col];
            return (
              <DroppableColumn
                key={col}
                col={col}
                count={cards.length}
                isOver={overCol === col}
              >
                {cards.length === 0 ? (
                  <p className="px-2 py-3 text-[11px] text-zinc-400">—</p>
                ) : (
                  cards.map((row) => (
                    <DraggableCardWrapper
                      key={row.id}
                      row={row}
                      emailDialogRef={emailDialogRef}
                      columnJumpRef={columnJumpRef}
                      selectMode={selectMode}
                      selected={selected.has(row.id)}
                      onToggleSelect={toggleSelect}
                    />
                  ))
                )}
              </DroppableColumn>
            );
          })}
        </div>
      </DndContext>

      {selectMode && selected.size > 0 ? (
        <div className="fixed inset-x-0 bottom-4 z-30 mx-auto flex w-fit items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-2 shadow-lg">
          <span className="px-2 text-sm font-medium text-zinc-900">
            {selected.size} selected
          </span>
          <button
            type="button"
            onClick={onBulkArchive}
            className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Archive
          </button>
          <button
            type="button"
            onClick={onBulkDelete}
            className="rounded-full border border-red-200 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={exitSelectMode}
            aria-label="Close"
            className="ml-1 rounded-full p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900"
          >
            ×
          </button>
        </div>
      ) : null}

      <EmailConfirmDialog ref={emailDialogRef} />
      <ColumnJumpDialog ref={columnJumpRef} />
    </>
  );
}
