import { useEffect, useRef, type RefObject } from "react";

/**
 * Dismissal wiring for hand-rolled dropdowns/popovers (plain absolute divs,
 * not <dialog>s): while `active`, a mousedown outside `ref` OR an Escape
 * press calls `onDismiss`. Escape is preventDefault-ed so it closes the
 * innermost menu without also cancelling an enclosing <dialog>.
 */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onDismiss: () => void,
) {
  // Latest callback in a ref so the listener never goes stale while open.
  const cb = useRef(onDismiss);
  cb.current = onDismiss;
  useEffect(() => {
    if (!active) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) cb.current();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cb.current();
      }
    }
    function onScroll(e: Event) {
      // Scrolling inside the popover (a long suggestion list) is fine; any
      // outside scroll dismisses, so fixed-positioned menus can't drift from
      // their anchor. (Native selects close on scroll too.)
      if (!ref.current?.contains(e.target as Node)) cb.current();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [active, ref]);
}
