import { Text } from "@react-email/components";
import * as React from "react";
import { Layout, styles } from "./Layout";

// Generic data-driven patient template — the only React template render.ts
// uses for the 4 patient emails. Subject / heading / paragraphs come from
// template-data.ts (defaults merged with DB overrides at request time).
export function PatientEmail(props: {
  practiceName: string;
  practiceAddress?: string | null;
  preview: string;
  heading: string | null;
  paragraphs: string[];
}) {
  return (
    <Layout
      preview={props.preview}
      practiceName={props.practiceName}
      practiceAddress={props.practiceAddress}
    >
      {props.heading ? <Text style={styles.heading}>{props.heading}</Text> : null}
      {props.paragraphs.map((p, i) => (
        <Text key={i} style={styles.body}>
          {p}
        </Text>
      ))}
    </Layout>
  );
}

// Internal staff emails — kept hardcoded since their content is workflow
// signaling (token links, case URLs), not editable patient copy. Dispatched
// from src/lib/email/internal.ts.

export function NadiaAllReceived(
  props: {
    practiceName: string;
    practiceAddress?: string | null;
    patientName: string;
    labLabels: string[];
    /** Labs in the patient's group that are NOT yet at step 5 (still
     * outstanding). Empty when the whole batch is complete. Surfaced so
     * Nadia sees the group's remaining work, not just the confirm link. */
    outstandingLabels: string[];
    confirmUrl: string;
  },
) {
  const allDone = props.outstandingLabels.length === 0;
  return (
    <Layout
      preview={
        allDone
          ? "All labs received — please confirm scheduling outreach"
          : "Labs received — outstanding labs still pending for this patient"
      }
      practiceName={props.practiceName}
      practiceAddress={props.practiceAddress}
    >
      <Text style={styles.body}>Hi Nadia,</Text>
      <Text style={styles.body}>
        {allDone ? (
          <>
            All labs for <strong>{props.patientName}</strong> have been
            received and uploaded. Please reach out to schedule their review of
            results (virtual or in-person) with the practitioner.
          </>
        ) : (
          <>
            Labs for <strong>{props.patientName}</strong> have been received and
            uploaded. A few labs in their group are still outstanding — please
            reach out to schedule their review once the remaining results land.
          </>
        )}
      </Text>
      <Text style={styles.body}>Labs received &amp; uploaded:</Text>
      <Text style={styles.body}>
        {props.labLabels.map((l) => `• ${l}`).join("\n")}
      </Text>
      {!allDone ? (
        <>
          <Text style={styles.body}>Still outstanding for this patient:</Text>
          <Text style={styles.body}>
            {props.outstandingLabels.map((l) => `• ${l}`).join("\n")}
          </Text>
        </>
      ) : null}
      <Text style={styles.body}>
        Once outreach has started, click below to confirm so the case moves
        forward:
      </Text>
      <Text style={styles.body}>
        <a href={props.confirmUrl}>{props.confirmUrl}</a>
      </Text>
    </Layout>
  );
}

export function AllisonRofReview(
  props: {
    practiceName: string;
    practiceAddress?: string | null;
    patientName: string;
    patientEmail: string;
    labLabels: string[];
    caseUrls: string[];
  },
) {
  return (
    <Layout
      preview="ROF booked — please proofread"
      practiceName={props.practiceName}
      practiceAddress={props.practiceAddress}
    >
      <Text style={styles.body}>Hi Allison,</Text>
      <Text style={styles.body}>
        The ROF (review of findings) has been booked for{" "}
        <strong>{props.patientName}</strong> ({props.patientEmail}). Please
        review/proofread their results ahead of the appointment.
      </Text>
      <Text style={styles.body}>Labs to review:</Text>
      <Text style={styles.body}>
        {props.labLabels.map((l) => `• ${l}`).join("\n")}
      </Text>
      {props.caseUrls.length > 0 ? (
        <>
          <Text style={styles.body}>Case links:</Text>
          {props.caseUrls.map((u) => (
            <Text key={u} style={styles.body}>
              <a href={u}>{u}</a>
            </Text>
          ))}
        </>
      ) : null}
    </Layout>
  );
}
