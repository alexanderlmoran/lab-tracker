"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { useDismiss } from "./use-dismiss";

export type NavMenuItem = {
  href: string;
  label: string;
  badge?: number;
};

/**
 * A category dropdown for the top nav (Medical / Sales / Admin). Reuses the
 * shared popover look (white CSS → reads dark under the inversion theme) and the
 * same .nav styling as the flat links, so the grouped nav matches the rest of
 * the toolbar dropdowns. The trigger highlights when the current page lives
 * inside the group, and bubbles the sum of its items' badges (e.g. unread inbox)
 * so a count isn't hidden when the menu is collapsed.
 */
export function NavMenu({ label, items }: { label: string; items: NavMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(ref, open, () => setOpen(false));
  const pathname = usePathname();
  const search = useSearchParams();

  const hrefMatches = (href: string) => {
    const [path, query] = href.split("?");
    if (pathname !== path) return false;
    if (!query) return true;
    const want = new URLSearchParams(query);
    for (const [k, v] of want) if (search.get(k) !== v) return false;
    return true;
  };

  const active = items.some((i) => hrefMatches(i.href));
  const totalBadge = items.reduce((s, i) => s + (i.badge ?? 0), 0);

  return (
    <div ref={ref} className="nav-menu" data-active={active ? "1" : undefined}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        {totalBadge > 0 ? <span className="badge">{totalBadge}</span> : null}
        <span className="nav-menu-caret">▾</span>
      </button>
      {open ? (
        <div role="menu" className="nav-menu-pop">
          {items.map((i) => (
            <Link
              key={i.href}
              href={i.href}
              role="menuitem"
              data-active={hrefMatches(i.href) ? "1" : undefined}
              onClick={() => setOpen(false)}
            >
              <span>{i.label}</span>
              {i.badge && i.badge > 0 ? <span className="badge">{i.badge}</span> : null}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
