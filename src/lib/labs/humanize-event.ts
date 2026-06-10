// Turn a raw LabEvent into a plain-English activity-log line, and decide
// whether it's a MAJOR event worth showing. The activity stream mixes
// `lab_events` (steps/edits/emails) with synthetic `audit_*` rows (PDF
// approval workflow) — both arrive as LabEvent via listLabEvents(). This is
// the single place that maps either into human text, so ActivityLog stays
// dumb. See docs/PLAYBOOK.md.

import type { LabEvent, StepNumber } from "@/lib/types";
import { stepLabel } from "@/lib/columns";

/**
 * DB column name → the words staff use for it. The `case_edited` event stores
 * its diff under meta.changes keyed by raw column names; we relabel them so
 * the log reads "Edited: tracking number, collection date" not the snake_case.
 */
const FIELD_LABEL: Record<string, string> = {
  patient_name: "patient name",
  patient_email: "email",
  patient_phone: "phone",
  patient_dob: "DOB",
  patient_address: "address",
  lab_name: "lab",
  lab_panel: "panel",
  tracking_number: "tracking number",
  tracking_carrier: "carrier",
  lab_external_ref: "accession #",
  pickup_confirmation: "pickup confirmation",
  collection_date: "collection date",
  partial_expected: "partial expected",
  auto_send_emails: "auto-send emails",
  notes: "notes",
  // step booleans can appear in a diff (e.g. tracking-added auto-advance);
  // collapse them to a readable phrase rather than "step1_sample_sent".
  step1_sample_sent: "Sample sent",
};

function fieldLabel(col: string): string {
  return FIELD_LABEL[col] ?? col.replace(/_/g, " ");
}

function getChangedFields(ev: LabEvent): string[] {
  const changes = (ev.meta as { changes?: Record<string, unknown> } | null)
    ?.changes;
  return changes ? Object.keys(changes) : [];
}

/** A humanized line + whether it's a MAJOR event (shown when filtering). */
export type HumanizedEvent = {
  text: string;
  /** MAJOR events survive the signal/noise filter; minor ones collapse. */
  major: boolean;
};

/**
 * Map a LabEvent to plain English. Pure — safe to call from a client
 * component. The `note` (already human, e.g. "Predicted: …") is appended by
 * ActivityLog itself, so we only build the lead phrase here.
 */
export function humanizeEvent(ev: LabEvent): HumanizedEvent {
  switch (ev.kind) {
    case "case_created":
      return { text: "Case created", major: true };
    case "case_bulk_imported":
      return { text: "Imported from CSV", major: true };
    case "case_edited": {
      const fields = getChangedFields(ev);
      if (fields.length) {
        return {
          text: `Edited: ${fields.map(fieldLabel).join(", ")}`,
          major: true,
        };
      }
      return { text: "Case edited", major: true };
    }
    case "case_archived":
      return { text: "Case archived", major: true };
    case "case_unarchived":
      return { text: "Case unarchived", major: true };
    case "case_deleted":
      return { text: "Case deleted", major: true };
    case "case_restored":
      return { text: "Case restored", major: true };
    case "step_toggled": {
      const step = ev.step as StepNumber | null;
      const name = step ? stepLabel(step) : `Step ${ev.step ?? "?"}`;
      // "Step 3 completed — Partial uploaded → Email 2" reads better than a
      // bare number; uncompleting is the rarer, noteworthy action.
      const verb = ev.completed ? "completed" : "uncompleted";
      return { text: `${name} ${verb}`, major: true };
    }
    case "expected_dates_set":
      // The predicted window lives in ev.note ("Predicted: … to …").
      return { text: "Expected result dates set", major: true };
    case "email_sent":
      return { text: "Email sent", major: true };
    case "email_resent":
      return { text: "Email re-sent", major: true };
    case "email_failed":
      return { text: "Email failed", major: true };
    case "email_skipped":
      // Skips are routine (already-sent / auto-send off) — low signal.
      return { text: "Email skipped", major: false };
    case "contact_attempted":
      return { text: "Contact attempted", major: false };
    case "contact_reached":
      return { text: "Patient reached", major: true };
    case "tracking_refreshed":
      // FedEx polls fire often (cron); only the status string in ev.note
      // carries meaning, and most ticks are no-change — keep them minor.
      return { text: "Tracking updated", major: false };
    // ── Synthetic audit_* kinds (PDF approval workflow) ──────────────────
    case "audit_approve":
      return { text: "PDF approved → PB upload queued", major: true };
    case "audit_disapprove_wrong_pdf":
      return {
        text: "PDF rejected (wrong patient / corrupt) — scraper will re-match",
        major: true,
      };
    case "audit_disapprove_upload_failed":
      return { text: "PB upload failed", major: true };
    case "audit_retry_upload":
      return { text: "Retry requested — PB upload re-queued", major: true };
    case "audit_manual_override":
      return { text: "Manual override", major: true };
    case "audit_accession_edited":
      return { text: "Accession # edited", major: true };
    default:
      // Unknown kind: show the raw string but treat as noise so a new event
      // type can't flood the major-only view before it's humanized here.
      return { text: ev.kind, major: false };
  }
}

/**
 * Filter an event stream to MAJOR events only, with one carve-out: a
 * `tracking_refreshed` row whose note reports a real status *change*
 * (delivered / exception / returned / out-for-delivery) is promoted to
 * major, since those are the deliveries staff care about. Routine
 * in-transit/no-change polls stay collapsed.
 */
export function isMajorEvent(ev: LabEvent): boolean {
  if (ev.kind === "tracking_refreshed") {
    const note = (ev.note ?? "").toLowerCase();
    return /delivered|exception|returned|out_for_delivery|out for delivery/.test(
      note,
    );
  }
  return humanizeEvent(ev).major;
}
