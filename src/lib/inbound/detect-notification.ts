// Detects "notification-only" lab emails — provider-side messages that say
// "your results are ready, log in to view" with no PDF attached. These were
// previously misclassified as parser failures; surfacing them as a distinct
// status (`needs_manual_pull`) lets staff click straight through to the lab
// portal instead of digging through error rows.

/** Does this email look like a Kennedy Krieger result? One definition shared
 * by the inbox UI (Forward button), the sync auto-forward, and re-parse. */
export function looksLikeKkEmail(args: {
  fromAddress?: string | null;
  subject?: string | null;
  filenames?: string[];
  extractedLab?: string | null;
}): boolean {
  return (
    args.extractedLab === "Kennedy Krieger" ||
    /geneticslab|kennedy.?krieger/i.test(args.fromAddress ?? "") ||
    /kennedy.?krieger|genetics\s*lab/i.test(args.subject ?? "") ||
    (args.filenames ?? []).some((f) => /kennedy.?krieger|genetics/i.test(f ?? ""))
  );
}

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
  { pattern: /vibrant[-_]?wellness|vibrant[-_]?america|vibrant\.com/i, lab: "Vibrant" },
  { pattern: /gdx\.net|genovadiagnostics|genova/i, lab: "Genova" },
  { pattern: /doctorsdata|doctor['']?sdata/i, lab: "DoctorsData" },
  { pattern: /spectracell/i, lab: "Spectracell" },
  { pattern: /cyrexlabs|cyrex/i, lab: "Cyrex" },
  { pattern: /dutchtest|precisionanalytical/i, lab: "Dutch" },
  { pattern: /glycanage/i, lab: "GlycanAge" },
  { pattern: /accessmedlab|accesslab/i, lab: "Access" },
  { pattern: /trudiagnostic|tru[-_]?age/i, lab: "TruAge" },
  { pattern: /microbiomelabs|microbiome\s?labs/i, lab: "MicrobiomeLabs" },
  { pattern: /microgendx|microgen\s?dx/i, lab: "MicroGenDX" },
  { pattern: /infectolab|qbench\.net/i, lab: "Infectolab" },
  // Kennedy Krieger Genetics Lab — email-only (geneticslab@kennedykrieger.org),
  // password-protected PDF ("kki"). The KK→BodyBio forward + post is built on
  // top of this detection. See project memory / TASKS.md.
  { pattern: /kennedykrieger|geneticslab/i, lab: "Kennedy Krieger" },
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

// Per-lab portal URLs. Entry points only — the operator signs in and then
// navigates to the specific result inside the portal. Verified by user
// 2026-05-12; update here whenever a lab changes their login URL.
export type LabPortal = {
  /** Canonical lab name (matches LAB_CATALOG.provider where applicable). */
  key: string;
  /** Friendly label for buttons / dropdowns. */
  label: string;
  /** Sign-in URL. */
  url: string;
  /** Some labs maintain both patient and provider portals — note which this is. */
  audience?: "patient" | "provider";
};

export const LAB_PORTALS: readonly LabPortal[] = [
  { key: "Access",         label: "Access Med Lab",      url: "https://accessmedlab.com/" },
  { key: "Cyrex",          label: "Cyrex Labs",          url: "https://www.cyrexlabs.com/Home/tabid/40/Default.aspx?returnurl=%2fOrderTests%2ftabid%2f209%2fDefault.aspx" },
  { key: "Genova",         label: "Genova (myGDX)",      url: "https://www.gdx.net/mygdx/login" },
  { key: "DoctorsData",    label: "Doctor's Data",       url: "https://www.doctorsdata.com/#" },
  { key: "GlycanAge",      label: "GlycanAge partners",  url: "https://partners.glycanage.com/dashboard" },
  { key: "Infectolab",     label: "Infectolab (QBench)", url: "https://infectolab.qbench.net/" },
  { key: "MicrobiomeLabs", label: "Microbiome Labs",     url: "https://microbiomelabs.com/my-account/" },
  { key: "MicroGenDX",     label: "MicroGen DX provider", url: "https://providerportal.microgendx.com/", audience: "provider" },
  { key: "MicroGenDX",     label: "MicroGen DX patient", url: "https://microgendx.com/my-account/", audience: "patient" },
  { key: "SpecPortal",     label: "Spec-Portal",         url: "https://spec-portal.com/" },
  { key: "Spectracell",    label: "Spectracell",         url: "https://www.spectracell.com/user-sign-in" },
  { key: "Vibrant",        label: "Vibrant Wellness",    url: "https://portal.vibrant-wellness.com/#/login" },
  { key: "TruDiagnostic",  label: "TruDiagnostic",       url: "https://portal.trudiagnostic.com/sign-in" },
];

// Aliases — multiple lab catalog names that should resolve to the same portal.
// e.g. "TruAge" is the test, "TruDiagnostic" is the lab that runs it.
const PORTAL_ALIASES: Record<string, string> = {
  TruAge: "TruDiagnostic",
};

/** Return the FIRST matching portal for a lab name. When a lab has multiple
 * portals (e.g. MicroGenDX has both provider + patient), the provider one
 * comes first in LAB_PORTALS, so that's what staff get. Use
 * `getAllPortalsForLab()` to see both. */
export function getPortalUrlForLab(labName: string | null | undefined): string | null {
  if (!labName) return null;
  const resolved = PORTAL_ALIASES[labName] ?? labName;
  return LAB_PORTALS.find((p) => p.key === resolved)?.url ?? null;
}

export function getAllPortalsForLab(labName: string | null | undefined): LabPortal[] {
  if (!labName) return [];
  const resolved = PORTAL_ALIASES[labName] ?? labName;
  return LAB_PORTALS.filter((p) => p.key === resolved);
}
