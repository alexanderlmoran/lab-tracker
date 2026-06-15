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

/** The five identity points pulled from a Zenoti guest profile
 * (`GET apiamrs14.zenoti.com/v1/guests/{id}?expand=address_info`). The daily
 * setDate appointment payload only carries name/email/phone — DOB, gender, and
 * address live on the guest profile, which this fills in. This is the "source of
 * truth" record in the Zenoti → tracker → PB enrichment ("1 feeds the rest"):
 * a well-made Zenoti guest has all five, PB is usually sparse. */
export type ZenotiGuestProfile = {
  /** Zenoti guest UUID (matches LabAppointment.zenotiGuestId). */
  guestId: string;

  firstName: string;
  lastName: string;
  middleName: string | null;
  preferredName: string | null;
  /** "First Last" composed from the parts above. */
  fullName: string;

  email: string | null;
  /** Digits only, mobile preferred (then home, then work). */
  mobilePhone: string | null;
  homePhone: string | null;
  workPhone: string | null;

  /** Zenoti gender_name ("Male"/"Female"/...); null when unset/"Unspecified". */
  gender: string | null;
  /** YYYY-MM-DD; null when Zenoti has no DOB on file. */
  dateOfBirth: string | null;

  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    /** state_name, falling back to state_other free-text. */
    state: string | null;
    zip: string | null;
    countryId: number | null;
  };
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

  /** Consumed products logged on this appointment in Zenoti (the ACTUAL products
   *  + amounts given), mapped to chart component rows. Populated only on the
   *  throttled consumables pass — undefined on plain 3-min syncs. */
  consumables?: Array<{ name: string; standardDose: string }>;
};
