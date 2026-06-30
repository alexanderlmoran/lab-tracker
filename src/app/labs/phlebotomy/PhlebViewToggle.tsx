"use client";

import Link from "next/link";
import { toolbarBtn } from "../toolbar-styles";

/**
 * Board / Calendar switch for the Phlebotomy tab. Both are `?tab=` views of the
 * same mobile-draw dataset; this segmented control flips between them so the
 * calendar reads as a sub-view of Phlebotomy rather than a separate top tab.
 */
export function PhlebViewToggle({ current }: { current: "phlebotomy" | "calendar" }) {
  return (
    <div className="inline-flex items-center gap-1">
      <Link href="/labs?tab=phlebotomy" className={toolbarBtn(current === "phlebotomy")}>
        Board
      </Link>
      <Link href="/labs?tab=calendar" className={toolbarBtn(current === "calendar")}>
        Calendar
      </Link>
    </div>
  );
}
