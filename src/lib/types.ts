// Mirrors supabase/migrations/20260506_init.sql. Snake-case throughout to
// match Supabase JS responses — no mapping at the boundary.

export type EmailKind =
  | "sample_sent"
  | "partial_uploaded"
  | "complete_uploaded"
  | "rof_followup"
  | "nadia_all_received"
  | "rof_allison"
  | "stale_digest"
  | "rof_reminder";

export type EmailStatus = "queued" | "sent" | "failed" | "skipped";

export type LabEventKind =
  | "step_toggled"
  | "case_created"
  | "case_edited"
  | "case_archived"
  | "case_unarchived"
  | "case_deleted"
  | "case_restored"
  | "email_sent"
  | "email_resent"
  | "email_failed"
  | "email_skipped"
  | "case_bulk_imported"
  | "expected_dates_set"
  | "tracking_refreshed"
  | "contact_attempted"
  | "contact_reached"
  // Synthetic kinds — `lab_case_audit` rows are merged into the activity
  // stream via listLabEvents() and tagged `audit_<action>` so the
  // ActivityLog component can render them inline.
  | "audit_approve"
  | "audit_disapprove_wrong_pdf"
  | "audit_disapprove_upload_failed"
  | "audit_retry_upload"
  | "audit_manual_override"
  | "audit_accession_edited";

export type LabCase = {
  id: string;
  patient_name: string;
  patient_email: string;
  patient_phone: string | null;
  patient_dob: string | null;
  patient_address: string | null;
  lab_name: string;
  lab_panel: string | null;
  tracking_number: string | null;
  lab_external_ref: string | null;
  pickup_confirmation: string | null;
  collection_date: string | null;
  partial_expected: boolean;
  auto_send_emails: boolean;
  notes: string | null;
  step1_sample_sent: boolean;
  step2_partial_received: boolean;
  step3_partial_uploaded: boolean;
  step4_complete_received: boolean;
  step5_complete_uploaded: boolean;
  step6_rof_scheduled: boolean;
  step7_rof_completed: boolean;
  step8_protocol_emailed: boolean;
  step9_sales_followup: boolean;
  archived_at: string | null;
  deleted_at: string | null;
  expected_result_at_min: string | null;
  expected_result_at_max: string | null;
  bulk_import_id: string | null;
  tracking_carrier: string | null;
  tracking_status: TrackingStatus | null;
  tracking_status_detail: string | null;
  tracking_event_at: string | null;
  tracking_polled_at: string | null;
  tracking_delivered_at: string | null;
  tracking_location: string | null;
  nadia_confirm_token: string | null;
  nadia_confirm_sent_at: string | null;
  nadia_confirm_expires_at: string | null;
  nadia_confirmed_at: string | null;
  allison_rof_emailed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TrackingStatus =
  | "pre_transit"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exception"
  | "returned"
  | "unknown";


export type LabEvent = {
  id: string;
  case_id: string;
  kind: LabEventKind;
  step: number | null;
  completed: boolean | null;
  actor: string;
  note: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
};

export type DrawNote = {
  id: string;
  patient_key: string;
  collection_date: string;
  body: string;
  updated_at: string;
  updated_by: string | null;
};

export type EmailLog = {
  id: string;
  case_id: string;
  kind: EmailKind;
  status: EmailStatus;
  resend_message_id: string | null;
  to_address: string;
  error_message: string | null;
  created_at: string;
};

export type ActionResult<T = void> =
  | { ok: true; data?: T }
  | { ok: false; error: string };

export type InboundEmailSource = "gmail_poll" | "manual_upload";

export type InboundEmailStatus =
  | "pending"
  | "parsed"
  | "failed"
  | "applied"
  | "dismissed"
  | "needs_manual_pull";

export type InboundEmailMatchConfidence = "high" | "medium" | "low" | "none";

export type InboundEmailExtracted = {
  lab_name?: string;
  patient_name?: string;
  patient_email?: string;
  patient_dob?: string;
  test_panel?: string;
  result_kind?: "partial" | "complete" | "unknown";
  collected_date?: string;
  reported_date?: string;
  summary?: string;
};

export type InboundEmail = {
  id: string;
  source: InboundEmailSource;
  external_id: string | null;
  from_address: string | null;
  subject: string | null;
  received_at: string;
  body_text: string | null;
  parser_status: InboundEmailStatus;
  parser_extracted: InboundEmailExtracted | null;
  parser_error: string | null;
  matched_case_id: string | null;
  matched_confidence: InboundEmailMatchConfidence | null;
  applied_action: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
};

export type InboundAttachment = {
  id: string;
  inbound_email_id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  storage_path: string | null;
  extracted_text: string | null;
  created_at: string;
};

export const STEP_BOOLEAN_COLUMNS = [
  "step1_sample_sent",
  "step2_partial_received",
  "step3_partial_uploaded",
  "step4_complete_received",
  "step5_complete_uploaded",
  "step6_rof_scheduled",
  "step7_rof_completed",
  "step8_protocol_emailed",
  "step9_sales_followup",
] as const satisfies readonly (keyof LabCase)[];

export type StepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
