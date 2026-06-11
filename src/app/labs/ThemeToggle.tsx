"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "labTheme";

/**
 * The 💡 dark-theme toggle next to Sign out. Flips the `dark` class on <html>
 * (which activates the inversion theme in globals.css) and persists the
 * choice; the inline boot script in the root layout re-applies it before
 * first paint so a reload doesn't flash light.
 */
export function ThemeToggle() {
  // SSR renders the light icon; sync from the <html> class (set by the boot
  // script) after mount so the bulb reflects the real state.
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "dark" : "light");
    } catch {
      // storage unavailable — the theme still applies for this session
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="theme-toggle"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Lights on" : "Lights off"}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill={dark ? "none" : "#fde047"}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* lightbulb (lucide): filled yellow while the lights are on */}
        <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
        <path d="M9 18h6" />
        <path d="M10 22h4" />
      </svg>
    </button>
  );
}
