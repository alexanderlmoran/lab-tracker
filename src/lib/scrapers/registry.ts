// Canonical registry of lab portals the tracker knows about. Used by the
// Settings → Scrapers page to show what's configured, what's missing, and
// what bash command to run for each.
//
// `key` is the worker-side scraper filename slug — i.e. an entry with
// key='access' implies a scraper at worker/src/scrapers/access.ts. When
// adding a new portal, add the entry here AND scaffold the scraper file.
// The settings page does a filesystem check against this list to mark each
// row 🟢 configured / 🟡 not yet configured.
//
// `loginUrl` is what gets passed to lab-portal-capture so the Playwright
// session lands on the right page. Worker keeps the cookies under
// worker/captures/<key>/<timestamp>/.

export type ScraperRegistryEntry = {
  /** Filesystem slug (worker/src/scrapers/<key>.ts). */
  key: string;
  /** Display name. Matches lab_name on cases. */
  labName: string;
  /** Login URL passed to capture.sh. */
  loginUrl: string;
  /** Free-text hint shown next to "Add scraper" button. */
  notes?: string;
};

export const SCRAPER_REGISTRY: ScraperRegistryEntry[] = [
  {
    key: "access",
    labName: "Access",
    loginUrl: "https://labgen.accessmedlab.com/Login.aspx",
    notes: "labgen ExtJS UI. Uses route-intercept to bypass Chrome PDF viewer.",
  },
  {
    key: "vibrant",
    labName: "Vibrant",
    loginUrl: "https://portal.vibrant-america.com/",
    notes: "Covers ~30 Zenoti services (Panel, Zoomer, Add-on variants).",
  },
  {
    key: "cyrex",
    labName: "Cyrex",
    loginUrl: "https://portal.cyrexlabs.com/",
  },
  {
    key: "spectracell",
    labName: "Spectracell",
    loginUrl: "https://lpaweb.spectracell.com/",
    notes: "Includes interpretation report variant.",
  },
  {
    key: "genova",
    labName: "Genova",
    loginUrl: "https://www.gdx.net/account/login",
  },
  {
    key: "glycanage",
    labName: "GlycanAge",
    loginUrl: "https://app.glycanage.com/login",
  },
  {
    key: "doctorsdata",
    labName: "DoctorsData",
    loginUrl: "https://www.doctorsdata.com/secure/practitioner",
  },
  {
    key: "rgcc",
    labName: "RGCC",
    loginUrl: "https://www.rgcc-group.com/",
    notes: "May not have a digital portal — confirm before capturing.",
  },
  {
    key: "lifelength",
    labName: "LifeLength",
    loginUrl: "https://www.lifelength.com/",
  },
  {
    key: "kennedykrieger",
    labName: "KennedyKrieger",
    loginUrl: "https://www.kennedykrieger.org/",
  },
  {
    key: "golda",
    labName: "GOLDA",
    loginUrl: "https://www.goldahormones.com/",
    notes: "Both saliva-only and saliva+urine variants route here.",
  },
];

export function captureCommandFor(entry: ScraperRegistryEntry): string {
  return `bash ~/.claude/skills/lab-portal-capture/capture.sh ${entry.key} '${entry.loginUrl}'`;
}
