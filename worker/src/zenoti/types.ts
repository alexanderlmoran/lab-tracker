// Output shape of any Zenoti transport adapter (browser-session today,
// official API once it lands). The sync handler consumes this — neither it
// nor the tracker cares which transport produced the rows.

export type LabAppointment = {
  /** Zenoti appointment UUID. Idempotency key for lab_case dedup. */
  zenotiAppointmentId: string;
  /** Zenoti guest UUID (patient identity). Stable across appointments. */
  zenotiGuestId: string;

  patientFirstName: string;
  patientLastName: string;
  /** Often "First Last" or "Last, First" — taken verbatim from Zenoti. */
  patientFullName: string;
  patientEmail: string | null;
  patientPhone: string | null;

  /** Raw Zenoti service name, e.g. "Labs - Access Custom". */
  serviceName: string;
  serviceId: string;
  /** Mapped to a tracker lab_name value (e.g. "Access"). Null means the
   * service didn't match any known lab — caller should skip the row. */
  labName: string;

  /** ISO timestamp of appointment start; null if Zenoti's format was
   * unparseable (shouldn't happen but defensive). */
  startAt: string | null;
  /** YYYY-MM-DD derived from startAt — used as lab_cases.collection_date. */
  collectionDate: string | null;

  /** Free-text note from the Zenoti appt (e.g. "access - $62.00\ntest"). */
  note: string | null;
  therapistName: string | null;

  /** True when Zenoti reports cancelOrNoShowStatus != 0 (cancellation or
   * no-show). Only populated when fetch was called with includeCancelled.
   * Sync uses this to soft-delete previously-synced tracker cases whose
   * appointment was cancelled after the fact. */
  cancelled: boolean;
};

/** A Zenoti "IV -" appointment, classified for charting. Shares the patient +
 * scheduling fields of LabAppointment but carries the IV classification
 * (see classifyIvService in iv-mapping.ts) instead of a labName. Consumed by
 * the IV Charting tab and, later, the PB session-note poster. */
export type IvAppointment = {
  zenotiAppointmentId: string;
  zenotiGuestId: string;

  patientFirstName: string;
  patientLastName: string;
  patientFullName: string;
  patientEmail: string | null;
  patientPhone: string | null;

  /** Raw Zenoti service name, e.g. "IV - Glutathione Push (Add-on)". */
  serviceName: string;
  serviceId: string;

  /** standard | addon | pc | custom | ebo — drives charting behavior. */
  kind: import("./iv-mapping.js").IvKind;
  /** Add-ons append to the visit's base IV note rather than a standalone note. */
  isAddOn: boolean;
  /** Note carries a Weber laser section. */
  weber: boolean;
  /** Canonical string to fuzzy-match against the live PB template catalog. */
  templateHint: string;

  startAt: string | null;
  collectionDate: string | null;

  note: string | null;
  therapistName: string | null;

  cancelled: boolean;
};
