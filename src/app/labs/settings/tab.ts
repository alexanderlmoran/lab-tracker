// Pure helpers shared by the server-component `/labs/settings/page.tsx`
// and the client `SettingsTabs.tsx`. Kept out of SettingsTabs because
// "use client" modules can't be imported into server components for plain
// function calls — only as React components.

export type SettingsTab =
  | "general"
  | "accounts"
  | "emails"
  | "labs"
  | "portals"
  | "scrapers"
  | "reqforms"
  | "patients"
  | "turnarounds"
  | "archived"
  | "deleted";

export const SETTINGS_TABS: Array<{ key: SettingsTab; label: string }> = [
  { key: "general", label: "General" },
  { key: "accounts", label: "Accounts" },
  { key: "emails", label: "Email templates" },
  { key: "labs", label: "Lab catalog" },
  { key: "portals", label: "Lab portals" },
  { key: "scrapers", label: "Scrapers" },
  { key: "reqforms", label: "Req forms" },
  { key: "patients", label: "Patient seed" },
  { key: "turnarounds", label: "Turnarounds" },
  { key: "archived", label: "Archived" },
  { key: "deleted", label: "Deleted" },
];

export function parseSettingsTab(value: string | undefined): SettingsTab {
  switch (value) {
    case "accounts":
    case "emails":
    case "labs":
    case "portals":
    case "scrapers":
    case "reqforms":
    case "patients":
    case "turnarounds":
    case "archived":
    case "deleted":
      return value;
    default:
      return "general";
  }
}
