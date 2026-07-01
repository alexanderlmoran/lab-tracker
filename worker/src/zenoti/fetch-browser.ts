// Browser-session transport for Zenoti's daily-appointments call.
//
// We reuse cookies from a Playwright `storage.json` captured via the
// lab-portal-capture skill. No Playwright is loaded at runtime — undici
// makes the HTTP call directly. When the official Zenoti API arrives, we'll
// add a sibling `fetch-api.ts` that produces the same LabAppointment[] and
// swap them at the call site.
//
// Cookie freshness: Zenoti session cookies last ~24h in our experience.
// When this adapter starts returning 401/302 redirects, re-run the capture:
//   bash ~/.claude/skills/lab-portal-capture/capture.sh zenoti \
//     'https://centnerwellness.zenoti.com/'
// and point the storagePath at the new dir.

import { readFile } from "node:fs/promises";
import { request } from "undici";

import { resolveLabName } from "./lab-mapping.js";
import { classifyIvService } from "./iv-mapping.js";
import type {
  IvAppointment,
  LabAppointment,
  ZenotiGuestProfile,
} from "./types.js";

const ZENOTI_BASE = "https://centnerwellness.zenoti.com";
// Pulled from the capture HAR — Centner-specific identifiers.
const ORG_ID = "6219e5ea-a4c4-45d0-91e9-3b9ea77feb67";
const CENTER_ID = "dba6b8ae-615f-4e5c-ad92-d55d48698c42";

type StorageCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
};

type StorageJson = { cookies: StorageCookie[] };

async function loadCookieHeader(storagePath: string): Promise<string> {
  const raw = await readFile(storagePath, "utf-8");
  const parsed = JSON.parse(raw) as StorageJson;
  const matching = parsed.cookies.filter(
    (c) =>
      c.domain === "centnerwellness.zenoti.com" ||
      c.domain === ".zenoti.com" ||
      c.domain === "zenoti.com",
  );
  if (matching.length === 0) {
    throw new Error(
      `No Zenoti cookies in ${storagePath} — capture may have expired`,
    );
  }
  return matching.map((c) => `${c.name}=${c.value}`).join("; ");
}

// Subset of the appointment fields we care about. Zenoti returns ~80 fields
// per appointment; we ignore the ones related to invoicing, theming, and
// resource scheduling.
export type ZenotiApptRow = {
  appointmentid: string;
  userid: string;
  FName?: string;
  LName?: string;
  Name?: string;
  UserEmail?: string;
  mobilephone?: string;
  servicename?: string;
  serviceid?: string;
  /** Format: "HH:MM MM-DD-YYYY", e.g. "11:00 05-21-2026". */
  starttime?: string;
  endtime?: string;
  /** "0" = active; non-zero = cancelled / no-show. */
  cancelOrNoShowStatus?: string;
  note?: string;
  therapistname?: string;
};

function parseZenotiStart(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{2}):(\d{2}) (\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const [, hh, mm, MM, dd, yyyy] = m;
  return `${yyyy}-${MM}-${dd}T${hh}:${mm}:00`;
}

function nonEmpty(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

export type FetchOpts = {
  storagePath: string;
  /** YYYY-MM-DD. Zenoti's setDate takes one day at a time. */
  date: string;
  /** When true, include cancelled / no-show rows. Default false. */
  includeCancelled?: boolean;
};

/** Fetch the raw appointment rows for one day. Shared by the lab and IV
 *  resolvers so the setDate transport + double-parse lives in exactly one
 *  place (a second copy would drift — see global reuse rule). Exported so the
 *  zenoti-debug-day diagnostic can dump the RAW rows Zenoti returns. */
export async function fetchZenotiApptRows(opts: FetchOpts): Promise<ZenotiApptRow[]> {
  const cookieHeader = await loadCookieHeader(opts.storagePath);
  const body = {
    strAppDate: `${opts.date} 00:00:00`,
    orgId: ORG_ID,
    strCenterId: CENTER_ID,
    // MUST be "True": this is Zenoti's therapist FILTER, not a display toggle.
    // "False" returns only the therapists in the captured session's saved book
    // view — so a lab booked under an atypical provider (e.g. "Alexander" rather
    // than the usual lab tech) is silently omitted from the response and never
    // becomes a card, even though its service/date/center are all valid.
    // "True" returns every therapist's appointments; we still filter to "Labs -"
    // services downstream, so this only ever ADDS coverage. (Regression found
    // 2026-07-01: Leila / "Labs - Vibrant Zoomer - Toxin" booked under Alexander.)
    strShowAllTherapist: "True",
    mode: 0,
    includenoshowcancelled: opts.includeCancelled ? 1 : 0,
    includeVirtualAppts: -1,
    isAmenity: false,
    param: { isListView: false },
  };

  const res = await request(`${ZENOTI_BASE}/Appointment/ApptExtV2.aspx/setDate`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      "content-type": "application/json; charset=utf-8",
      "x-requested-with": "XMLHttpRequest",
      accept: "application/json, text/javascript, */*; q=0.01",
    },
    body: JSON.stringify(body),
  });

  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(
      `Zenoti setDate ${res.statusCode}: ${text.slice(0, 200)} ` +
        `(if 401/302, refresh storage.json via lab-portal-capture)`,
    );
  }

  // The legacy ASP.NET endpoint wraps payloads in { d: "<JSON string>" }, and
  // inside that the Appts field is *also* a JSON string. Double parse.
  const outer = (await res.body.json()) as { d?: string | object };
  if (outer.d == null) {
    throw new Error("Zenoti setDate response missing `d` envelope");
  }
  const inner: { Appts?: string | object } =
    typeof outer.d === "string" ? JSON.parse(outer.d) : outer.d;
  const apptsBlock =
    typeof inner.Appts === "string"
      ? JSON.parse(inner.Appts)
      : (inner.Appts as { appointments?: ZenotiApptRow[] } | undefined);
  return apptsBlock?.appointments ?? [];
}

export async function fetchZenotiLabAppointments(
  opts: FetchOpts,
): Promise<LabAppointment[]> {
  const rows = await fetchZenotiApptRows(opts);

  const out: LabAppointment[] = [];
  for (const r of rows) {
    const isCancelled = Number(r.cancelOrNoShowStatus ?? "0") !== 0;
    if (!opts.includeCancelled && isCancelled) {
      continue;
    }
    const serviceName = r.servicename ?? "";
    const labName = resolveLabName(serviceName);
    if (!labName) continue;

    const startAt = parseZenotiStart(r.starttime);
    // TODO(#5): DOB is NOT in the setDate appointment payload (no birth field
    // on ZenotiApptRow — confirmed during IV charting). We carry `zenotiGuestId`
    // (r.userid), so a per-guest detail lookup (e.g. the guest-profile endpoint
    // ApptExtV2 uses on appointment open) could backfill it. Until that HAR is
    // captured, DOB is filled manually on the edit-case form (#23 → saves to
    // the patient + patients_seed) or comes from patients_seed where known.
    out.push({
      zenotiAppointmentId: r.appointmentid,
      zenotiGuestId: r.userid,
      patientFirstName: (r.FName ?? "").trim(),
      patientLastName: (r.LName ?? "").trim(),
      patientFullName: (r.Name ?? "").trim(),
      patientEmail: nonEmpty(r.UserEmail),
      patientPhone: nonEmpty(r.mobilephone),
      serviceName,
      serviceId: r.serviceid ?? "",
      labName,
      startAt,
      collectionDate: startAt ? startAt.slice(0, 10) : null,
      note: nonEmpty(r.note),
      therapistName: nonEmpty(r.therapistname),
      cancelled: isCancelled,
    });
  }
  return out;
}

/** Same transport as fetchZenotiLabAppointments, but keeps the "IV -" services
 *  and classifies each one (kind / add-on / weber / templateHint) for charting.
 *  See classifyIvService in iv-mapping.ts. */
export async function fetchZenotiIvAppointments(
  opts: FetchOpts,
): Promise<IvAppointment[]> {
  const rows = await fetchZenotiApptRows(opts);

  const out: IvAppointment[] = [];
  for (const r of rows) {
    const isCancelled = Number(r.cancelOrNoShowStatus ?? "0") !== 0;
    if (!opts.includeCancelled && isCancelled) {
      continue;
    }
    const serviceName = r.servicename ?? "";
    const info = classifyIvService(serviceName);
    if (!info) continue;

    const startAt = parseZenotiStart(r.starttime);
    out.push({
      zenotiAppointmentId: r.appointmentid,
      zenotiGuestId: r.userid,
      patientFirstName: (r.FName ?? "").trim(),
      patientLastName: (r.LName ?? "").trim(),
      patientFullName: (r.Name ?? "").trim(),
      patientEmail: nonEmpty(r.UserEmail),
      patientPhone: nonEmpty(r.mobilephone),
      serviceName,
      serviceId: r.serviceid ?? "",
      kind: info.kind,
      isAddOn: info.isAddOn,
      weber: info.weber,
      templateHint: info.templateHint,
      startAt,
      collectionDate: startAt ? startAt.slice(0, 10) : null,
      note: nonEmpty(r.note),
      therapistName: nonEmpty(r.therapistname),
      cancelled: isCancelled,
    });
  }
  return out;
}

// --- Appointment consumed products (the "Add consumed products" dialog) -------
//
// Zenoti's logged consumables for an appointment — the ACTUAL products + amounts
// administered (this is where the per-visit dosages live, e.g. PC 22 vials). Same
// cookie transport as setDate; the legacy AppServices.aspx method returns
// { d: "<JSON>" } → { ManuallyTrackedProducts:[...], AutomaticallyTrackedProducts:[...] }.
// Captured from the live dialog's network call (strAppointmentId + strCenterId).

export type AppointmentProduct = {
  name: string; // ProductNameWithUnit, e.g. "Glutathione 200MG/ML (1ml)"
  unitsUsed: string; // "10"
  volumeType: string; // "ml" / "unts"
  volumePerItem: number;
  tracking: "manual" | "auto";
};

export async function fetchZenotiAppointmentProducts(opts: {
  storagePath: string;
  appointmentId: string;
}): Promise<AppointmentProduct[]> {
  const cookieHeader = await loadCookieHeader(opts.storagePath);
  const res = await request(`${ZENOTI_BASE}/Appointment/AppServices.aspx/GetAppointmentProducts`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      "content-type": "application/json; charset=utf-8",
      "x-requested-with": "XMLHttpRequest",
      accept: "application/json, text/javascript, */*; q=0.01",
    },
    body: JSON.stringify({ strAppointmentId: opts.appointmentId, strCenterId: CENTER_ID }),
    // Hard cap so a headless-session hang can never freeze a caller's loop.
    signal: AbortSignal.timeout(12000),
  });
  if (res.statusCode !== 200) {
    throw new Error(`Zenoti GetAppointmentProducts ${res.statusCode}: ${(await res.body.text()).slice(0, 150)}`);
  }
  const outer = (await res.body.json()) as { d?: string | object };
  const data = (typeof outer.d === "string" ? JSON.parse(outer.d) : (outer.d ?? {})) as {
    ManuallyTrackedProducts?: Array<Record<string, unknown>>;
    AutomaticallyTrackedProducts?: Array<Record<string, unknown>>;
  };
  const map = (arr: Array<Record<string, unknown>> | undefined, tracking: "manual" | "auto"): AppointmentProduct[] =>
    (arr ?? []).map((p) => ({
      name: String(p.ProductNameWithUnit ?? "").trim(),
      unitsUsed: String(p.UnitsUsed ?? "").trim(),
      volumeType: String(p.VolumeTypeName ?? "").trim(),
      volumePerItem: Number(p.VolumePerItem ?? 1),
      tracking,
    }));
  return [...map(data.ManuallyTrackedProducts, "manual"), ...map(data.AutomaticallyTrackedProducts, "auto")].filter((p) => p.name);
}

/** Map Zenoti consumed-products → IV chart component rows (name + dose-from-units),
 *  so a charted note carries what was ACTUALLY given. "Essentiale PC - Standard
 *  (1unts)" ×22 → { name: "Essentiale PC - Standard", standardDose: "22 units" };
 *  "Glutathione 200MG/ML (1ml)" ×10 → { …, standardDose: "10 ml" }. */
export function consumablesToComponents(
  products: AppointmentProduct[],
): Array<{ name: string; standardDose: string }> {
  const cleanName = (n: string) => n.replace(/\s*\(\s*\d+(?:\.\d+)?\s*(?:ml|unts|units|cap|caps|mg)?\s*\)\s*$/i, "").trim();
  const unitLabel = (v: string) => (/^unt/i.test(v) ? "units" : v);
  return products.map((p) => ({
    name: cleanName(p.name),
    standardDose: p.unitsUsed ? `${p.unitsUsed}${p.volumeType ? ` ${unitLabel(p.volumeType)}` : ""}`.trim() : "",
  }));
}

// --- Guest profile (DOB + address + gender) --------------------------------
//
// The setDate appointment payload above only carries name/email/phone. The
// remaining identity points (DOB, gender, address) live on the guest profile,
// served by Zenoti's modern V1 REST API at apiamrs14.zenoti.com — a DIFFERENT
// host that authenticates with a Bearer token rather than the ASP.NET cookies.
//
// That token (`globalWebApiToken`) and its base URL (`globalWebApiUrl`) are
// minted into the ApptExtV2.aspx page HTML, which we already load with our
// stored cookies. So the headless flow is: scrape the page for the token, then
// call /v1/guests/{id}?expand=address_info with it. Captured & verified from
// the 20260521 HAR (see worker/captures/zenoti).

type WebApiCreds = { token: string; apiUrl: string };

// Cache the scraped creds per cookie source for the process lifetime — the
// token is valid as long as the session cookies are. A 401 from the V1 call
// clears this and re-scrapes once (handles a mid-process token rotation).
const credsCache = new Map<string, WebApiCreds>();

async function getWebApiCreds(
  storagePath: string,
  forceRefresh = false,
): Promise<WebApiCreds> {
  if (!forceRefresh) {
    const hit = credsCache.get(storagePath);
    if (hit) return hit;
  }
  const cookieHeader = await loadCookieHeader(storagePath);
  const res = await request(`${ZENOTI_BASE}/Appointment/ApptExtV2.aspx`, {
    method: "GET",
    headers: { cookie: cookieHeader, accept: "text/html" },
  });
  // undici doesn't follow redirects by default, so a stale session surfaces
  // here as a 302 to SSO login rather than a 200 without the token.
  if (res.statusCode !== 200) {
    await res.body.dump();
    throw new Error(
      `Zenoti ApptExtV2 page ${res.statusCode} (session expired? ` +
        `refresh storage.json / ZENOTI_SESSION_B64 via lab-portal-capture)`,
    );
  }
  const html = await res.body.text();
  const tokenMatch = html.match(/globalWebApiToken\s*=\s*'([^']+)'/);
  const urlMatch = html.match(/globalWebApiUrl\s*=\s*'([^']+)'/);
  if (!tokenMatch || !urlMatch) {
    throw new Error(
      "Zenoti ApptExtV2 page loaded but globalWebApiToken/Url not found " +
        "(login wall or page layout changed)",
    );
  }
  const creds: WebApiCreds = {
    token: tokenMatch[1],
    apiUrl: urlMatch[1].replace(/\/+$/, ""),
  };
  credsCache.set(storagePath, creds);
  return creds;
}

// Shapes returned by /v1/guests/{id} — only the fields we map. Everything is
// optional/defensive: Zenoti omits whole blocks for sparse guests.
type V1GuestResponse = {
  id?: string;
  personal_info?: {
    first_name?: string;
    last_name?: string;
    middle_name?: string;
    preferred_name?: string;
    email?: string;
    gender_name?: string;
    date_of_birth?: string;
    mobile_phone?: { number?: string } | null;
    home_phone?: { number?: string } | null;
    work_phone?: { number?: string } | null;
  };
  address_info?: {
    address_1?: string;
    address_2?: string;
    city?: string;
    state_name?: string | null;
    state_other?: string;
    zip_code?: string;
    country_id?: number;
  };
};

function phoneDigits(p: { number?: string } | null | undefined): string | null {
  const n = nonEmpty(p?.number);
  return n ? n.replace(/[^\d]/g, "") || null : null;
}

export type GuestProfileOpts = {
  storagePath: string;
  guestId: string;
};

/** Pull one Zenoti guest's full profile (DOB, gender, address + name/email/
 *  phone) via the V1 REST API. Headless: reuses the stored session cookies to
 *  scrape the page-embedded Bearer token, then calls the API. This is Step 1 of
 *  the "1 feeds the rest" enrichment — the returned record fills the tracker and
 *  then PB's sparse fields. */
export async function fetchZenotiGuestProfile(
  opts: GuestProfileOpts,
): Promise<ZenotiGuestProfile> {
  // Replicate the exact expand set from the proven 20260521 capture rather than
  // a trimmed one — personal_info (DOB/gender) comes back by default, but
  // matching the working request byte-for-byte removes any "is this expand
  // required?" guesswork. We only read personal_info + address_info.
  const EXPANDS =
    "expand=tags&expand=preferences&expand=address_info&expand=referral" +
    "&expand=primary_employee&expand=additional_details&expand=email_details" +
    "&expand=blocked_therapists";
  const fetchOnce = async (creds: WebApiCreds) =>
    request(
      `${creds.apiUrl}/v1/guests/${opts.guestId}?${EXPANDS}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${creds.token}`,
          accept: "application/json",
          "content-type": "application/json",
          "x-languagecode": "en-US",
          origin: "https://gpcloud.zenoti.com",
          referer: "https://gpcloud.zenoti.com/",
        },
      },
    );

  let creds = await getWebApiCreds(opts.storagePath);
  let res = await fetchOnce(creds);
  // Token rotated mid-process → re-scrape once and retry.
  if (res.statusCode === 401) {
    await res.body.dump();
    creds = await getWebApiCreds(opts.storagePath, true);
    res = await fetchOnce(creds);
  }
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error(
      `Zenoti v1/guests/${opts.guestId} ${res.statusCode}: ${text.slice(0, 200)}`,
    );
  }

  const g = (await res.body.json()) as V1GuestResponse;
  const pi = g.personal_info ?? {};
  const ai = g.address_info ?? {};

  const firstName = (pi.first_name ?? "").trim();
  const lastName = (pi.last_name ?? "").trim();
  const gender = nonEmpty(pi.gender_name);

  return {
    guestId: g.id ?? opts.guestId,
    firstName,
    lastName,
    middleName: nonEmpty(pi.middle_name),
    preferredName: nonEmpty(pi.preferred_name),
    fullName: [firstName, lastName].filter(Boolean).join(" "),
    email: nonEmpty(pi.email),
    mobilePhone:
      phoneDigits(pi.mobile_phone) ??
      phoneDigits(pi.home_phone) ??
      phoneDigits(pi.work_phone),
    homePhone: phoneDigits(pi.home_phone),
    workPhone: phoneDigits(pi.work_phone),
    // Zenoti returns "Unspecified" for unset gender — treat as null.
    gender: gender && gender.toLowerCase() !== "unspecified" ? gender : null,
    // date_of_birth is an ISO datetime ("1976-12-28T00:00:00"); keep the date.
    dateOfBirth: nonEmpty(pi.date_of_birth)?.slice(0, 10) ?? null,
    address: {
      line1: nonEmpty(ai.address_1),
      line2: nonEmpty(ai.address_2),
      city: nonEmpty(ai.city),
      state: nonEmpty(ai.state_name) ?? nonEmpty(ai.state_other),
      zip: nonEmpty(ai.zip_code),
      countryId: typeof ai.country_id === "number" ? ai.country_id : null,
    },
  };
}

/** Best-effort batch enrichment: pull the full profile for each unique guest ID.
 *  A failure on one guest (404, transient) is logged and skipped so one bad
 *  guest can't abort the day's enrichment. Returns guestId -> profile for the
 *  ones that resolved. Sequential by design — shares the cached page token and
 *  doesn't hammer the V1 API (clinic volume is a handful of appts/day). */
export async function enrichGuestProfiles(
  storagePath: string,
  guestIds: string[],
): Promise<Map<string, ZenotiGuestProfile>> {
  const out = new Map<string, ZenotiGuestProfile>();
  for (const guestId of [...new Set(guestIds.filter(Boolean))]) {
    try {
      out.set(guestId, await fetchZenotiGuestProfile({ storagePath, guestId }));
    } catch (err) {
      console.warn(
        `[zenoti] guest-profile enrich failed for ${guestId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return out;
}

/** Compose Zenoti's structured gender into the "M"/"F" convention used by
 *  lab_cases.patient_sex and the req-form sex checkbox. Null for anything else. */
export function zenotiGenderToSex(gender: string | null): string | null {
  if (!gender) return null;
  const g = gender.trim().toLowerCase();
  if (g === "male") return "M";
  if (g === "female") return "F";
  return null;
}

/** Flatten a guest's address into the single "street, city, ST zip" line that
 *  lab_cases.patient_address uses (so parseAddress() reuses it downstream).
 *  Null when there's no street on file. */
export function formatGuestAddress(addr: ZenotiGuestProfile["address"]): string | null {
  if (!addr.line1) return null;
  // Zenoti free-text address fields can contain embedded newlines (staff paste
  // multi-line addresses) — collapse all whitespace so the stored value is a
  // single clean line that parseAddress() can read.
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const present = (x: string | null): x is string => Boolean(x);
  const street = clean([addr.line1, addr.line2].filter(present).join(" "));
  const cityState = [addr.city, [addr.state, addr.zip].filter(present).join(" ").trim()]
    .filter(present)
    .map(clean)
    .join(", ");
  return clean([street, cityState].filter(Boolean).join(", ")) || null;
}
