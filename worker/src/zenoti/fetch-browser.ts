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
import type { LabAppointment } from "./types.js";

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
type ZenotiApptRow = {
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

export async function fetchZenotiLabAppointments(
  opts: FetchOpts,
): Promise<LabAppointment[]> {
  const cookieHeader = await loadCookieHeader(opts.storagePath);
  const body = {
    strAppDate: `${opts.date} 00:00:00`,
    orgId: ORG_ID,
    strCenterId: CENTER_ID,
    strShowAllTherapist: "False",
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
  const rows: ZenotiApptRow[] = apptsBlock?.appointments ?? [];

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
