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
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [active, ref]);
}
