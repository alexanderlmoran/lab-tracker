import { Text } from "@react-email/components";
import * as React from "react";
import { Layout, styles } from "./Layout";

type Common = {
  patientName: string;
  practiceName: string;
  practiceAddress?: string | null;
};

const PRACTICE_PHONE = "305-602-5260";
const PB_PORTAL = "practicebetter.io";

// Generic data-driven patient template — used for all 4 patient email kinds
// when render.ts has resolved the (DB-overridable) subject/heading/paragraphs.
// The 4 named components below are kept as fallbacks but no longer the
// primary render path.
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

function firstName(full: string): string {
  const tok = full.trim().split(/\s+/)[0];
  return tok || full;
}

export function SampleSent(
  props: Common & {
    labName: string;
    labPanel: string | null;
    turnaroundText: string;
  },
) {
  const first = firstName(props.patientName);
  const labLabel = props.labPanel
    ? `${props.labName} ${props.labPanel}`
    : props.labName;
  return (
    <Layout
      preview="Sample Received"
      practiceName={props.practiceName}
      practiceAddress={props.practiceAddress}
    >
      <Text style={styles.body}>Dear {first},</Text>
      <Text style={styles.body}>
        Your sample has been sent to our partner laboratory for: {labLabel}.
      </Text>
      <Text style={styles.body}>
        Results are expected within {props.turnaroundText}.
      </Text>
      <Text style={styles.body}>
        Thank you and please call us at {PRACTICE_PHONE} if you have any
        questions.
      </Text>
      <Text style={styles.body}>You can also reply to this email.</Text>
    </Layout>
  );
}

export function PartialUploaded(
  props: Common & {
    labName: string;
    labPanel: string | null;
  },
) {
  const first = firstName(props.patientName);
  const labLabel = props.labPanel
    ? `${props.labName} ${props.labPanel}`
    : props.labName;
  return (
    <Layout
      preview="Partial Results Received"
      practiceName={props.practiceName}
      practiceAddress={props.practiceAddress}
    >
      <Text style={styles.body}>Dear {first},</Text>
      <Text style={styles.body}>
        We have received partial results for the following: {labLabel}.
      </Text>
      <Text style={styles.body}>
        These results have been uploaded to Practice Better.
      </Text>
      <Text style={styles.body}>
        We will notify you when the complete results become available.
      </Text>
      <Text style={styles.body}>
        To view the partial results, please look for a separate email from
        Practice Better, or log in to: {PB_PORTAL}
      </Text>
      <Text style={styles.body}>
        Thank you and please call us at {PRACTICE_PHONE} if you have any
        questions.
      </Text>
      <Text style={styles.body}>You can also reply to this email.</Text>
    </Layout>
  );
}

export function CompleteUploaded(
  props: Common & {
    labName: string;
    labPanel: string | null;
  },
) {
  const first = firstName(props.patientName);
  const labLabel = props.labPanel
    ? `${props.labName} ${props.labPanel}`
    : props.labName;
  return (
    <Layout
      preview="Complete Results Received"
      practiceName={props.practiceName}
      practiceAddress={props.practiceAddress}
    >
      <Text style={styles.body}>Dear {first},</Text>
      <Text style={styles.body}>
        We have received the complete results for the following: {labLabel}.
      </Text>
      <Text style={styles.body}>
        These results have been uploaded to Practice Better.
      </Text>
      <Text style={styles.body}>
        To view the complete results, please look for a separate email from
        Practice Better, or log in to: {PB_PORTAL}
      </Text>
      <Text style={styles.body}>
        If all of your labs have been received, you will receive a phone call
        from our patient coordinator Nadia who will assist in scheduling your
        virtual or in-person review of results with our practitioner.
      </Text>
      <Text style={styles.body}>
        Thank you and please call us at {PRACTICE_PHONE} if you have any
        questions.
      </Text>
      <Text style={styles.body}>You can also reply to this email.</Text>
    </Layout>
  );
}

export function NadiaAllReceived(
  props: {
    practiceName: string;
    practiceAddress?: string | null;
    patientName: string;
    labLabels: string[];
    confirmUrl: string;
  },
) {
  return (
    <Layout
      preview="All labs received — please confirm scheduling outreach"
      practiceName={props.practiceName}
      practiceAddress={props.practiceAddress}
    >
      <Text style={styles.body}>Hi Nadia,</Text>
      <Text style={styles.body}>
        All labs for <strong>{props.patientName}</strong> have been received
        and uploaded. Please reach out to schedule their review of results
        (virtual or in-person) with the practitioner.
      </Text>
      <Text style={styles.body}>Labs included:</Text>
      <Text style={styles.body}>
        {props.labLabels.map((l) => `• ${l}`).join("\n")}
      </Text>
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

export function RofFollowup(props: Common) {
  const first = firstName(props.patientName);
  return (
    <Layout
      preview="Thanks for your review — here's what's next"
      practiceName={props.practiceName}
      practiceAddress={props.practiceAddress}
    >
      <Text style={styles.heading}>
        Thanks for your review — here&apos;s what&apos;s next
      </Text>
      <Text style={styles.body}>Dear {first},</Text>
      <Text style={styles.body}>
        Great catching up. As discussed, we&apos;ll send your protocol shortly,
        and a member of the team will follow up about supplements and anything
        else that came out of the review.
      </Text>
      <Text style={styles.body}>If anything is unclear, reply here.</Text>
    </Layout>
  );
}
