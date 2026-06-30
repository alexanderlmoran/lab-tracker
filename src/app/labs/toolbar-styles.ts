// Shared toolbar control look — every toolbar button AND the ToolbarSelect
// triggers render from this so the whole toolbar stays consistent.
//
// IMPORTANT: this app's dark theme is an INVERSION filter on the root (see
// globals.css), NOT per-component dark: variants. So LIGHT css renders DARK in
// dark mode. That's why these are styled LIGHT (white/zinc) — they read as the
// dark/black controls in dark mode, and as normal light buttons in light mode.
// (Hardcoding bg-zinc-900 here would invert to WHITE in dark mode.)
const TOOLBAR_BTN_BASE =
  "rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50";

/**
 * Classy toolbar control classes. `active` = the clicked / open / toggled-on
 * state — it darkens to pure black under the inversion (bg-white → #000) with a
 * highlighted ring so a pressed control reads at a glance.
 */
export function toolbarBtn(active = false): string {
  return active
    ? `${TOOLBAR_BTN_BASE} border-zinc-800 bg-white text-zinc-950 ring-1 ring-zinc-800`
    : `${TOOLBAR_BTN_BASE} border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100`;
}
