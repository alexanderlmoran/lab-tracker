import { Text } from "@react-email/components";
import * as React from "react";
import { Layout, styles } from "./Layout";

type Common = {
  patientName: string;
  practiceName: string;
  practiceAddress?: string | null;
};

function firstName(full: string): string {
  const tok = full.trim().split(/\s+/)[0];
  return tok || full;
}

const PRACTICE_PHONE = "305-602-5260";
const PB_PORTAL = "practicebetter.io";

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
        Thank you and please call us at {PRACTICE_PHONE} if you have any
        questions.
      </Text>
      <Text style={styles.body}>You can also reply to this email.</Text>
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
