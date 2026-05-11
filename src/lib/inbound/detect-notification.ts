// Detects "notification-only" lab emails — provider-side messages that say
// "your results are ready, log in to view" with no PDF attached. These were
// previously misclassified as parser failures; surfacing them as a distinct
// status (`needs_manual_pull`) lets staff click straight through to the lab
// portal instead of digging through error rows.

const NOTIFICATION_KEYWORDS: readonly string[] = [
  "log in to view",
  "login to view",
  "log in to access",
  "sign in to view",
  "sign in to access",
  "view your results",
  "view results online",
  "access your results",
  "results are ready",
  "results are now available",
  "results are available",
  "secure portal",
  "patient portal",
  "results have been posted",
  "results have been uploaded",
  "your test results are",
];

export function isNotificationOnlyEmail(input: {
  subject: string | null | undefined;
  bodyText: string | null | undefined;
  attachmentCount: number;
}): boolean {
  if (input.attachmentCount > 0) return false;
  const haystack = `${input.subject ?? ""}\n${input.bodyText ?? ""}`.toLowerCase();
  if (!haystack.trim()) return false;
  return NOTIFICATION_KEYWORDS.some((kw) => haystack.includes(kw));
}

// Lab identity inferred from sender domain (most reliable) with a subject
// fallback. Returns the canonical `lab_name` from LAB_CATALOG so the inbox
// row can render the right portal link.
const SENDER_TO_LAB: ReadonlyArray<{ pattern: RegExp; lab: string }> = [
  { pattern: /vibrant[-_]?america|vibrantwellness|vibrant\.com/i, lab: "Vibrant" },
  { pattern: /gdx\.net|genovadiagnostics|genova/i, lab: "Genova" },
  { pattern: /doctorsdata|doctor['']?sdata/i, lab: "DoctorsData" },
  { pattern: /spectracell/i, lab: "Spectracell" },
  { pattern: /cyrexlabs|cyrex/i, lab: "Cyrex" },
  { pattern: /dutchtest|precisionanalytical/i, lab: "Dutch" },
  { pattern: /glycanage/i, lab: "GlycanAge" },
  { pattern: /accessmedlab|accesslab/i, lab: "Access" },
];

export function detectLabFromEmail(input: {
  subject: string | null | undefined;
  fromAddress: string | null | undefined;
  bodyText: string | null | undefined;
}): string | null {
  const haystacks = [
    input.fromAddress ?? "",
    input.subject ?? "",
    input.bodyText ?? "",
  ];
  for (const h of haystacks) {
    if (!h) continue;
    for (const { pattern, lab } of SENDER_TO_LAB) {
      if (pattern.test(h)) return lab;
    }
  }
  return null;
}

// Per-lab portal URLs. Best-effort — these are entry points; the operator
// signs in and navigates to the specific result. Null = no known portal,
// surface a "manual" hint in the UI instead of a button.
const LAB_PORTALS: Record<string, string> = {
  Vibrant: "https://portal.vibrant-america.com/",
  Genova: "https://portal.gdx.net/",
  DoctorsData: "https://www.doctorsdata.com/my-account/",
  Spectracell: "https://www.spectracell.com/login/",
  Cyrex: "https://www.cyrexlabs.com/customer/account/login/",
  Dutch: "https://portal.dutchtest.com/",
  GlycanAge: "https://results.glycanage.com/",
};

export function getPortalUrlForLab(labName: string | null | undefined): string | null {
  if (!labName) return null;
  return LAB_PORTALS[labName] ?? null;
}
