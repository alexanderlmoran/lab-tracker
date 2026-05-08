import { Text } from "@react-email/components";
import * as React from "react";
import { Layout, styles } from "./Layout";

type Common = {
  patientName: string;
  practiceName: string;
  practiceAddress?: string | null;
  patientPortalUrl?: string | null;
};

export function SampleSent(
  props: Common & {
    labName: string;
    trackingNumber?: string | null;
  },
) {
  return (
    <Layout
      preview={`Your ${props.labName} sample is on its way`}
      practiceName={props.practiceName}
      practiceAddress={props.practiceAddress}
    >
      <Text style={styles.heading}>
        Your sample is on its way to {props.labName}
      </Text>
      <Text style={styles.body}>Hi {props.patientName},</Text>
      <Text style={styles.body}>
        Your sample has been sent to {props.labName}.
        {props.trackingNumber
          ? ` Tracking: ${props.trackingNumber}.`
          : ""}{" "}
        Most results return within a few weeks; we'll reach out as soon as
        anything is ready in your portal.
      </Text>
      <Text style={styles.body}>
        If anything looks off in the meantime, just reply to this email.
      </Text>
    </Layout>
  );
}

export function PartialUploaded(
  props: Common & {
    labName: string;
  },
) {
  return (
    <Layout
      preview={`Partial ${props.labName} results are ready in your portal`}
      practiceName={props.practiceName}
      practiceAddress={props.practiceAddress}
    >
      <Text style={styles.heading}>
        Partial {props.labName} results are ready
      </Text>
      <Text style={styles.body}>Hi {props.patientName},</Text>
      <Text style={styles.body}>
        Some of your {props.labName} results are now uploaded to your patient
        portal. Have a look when you get a chance — the rest will follow.
      </Text>
      {props.patientPortalUrl ? (
        <Text style={styles.body}>
          View in portal:{" "}
          <a href={props.patientPortalUrl} style={{ color: "#0f8b7e" }}>
            {props.patientPortalUrl}
          </a>
        </Text>
      ) : null}
    </Layout>
  );
}

export function CompleteUploaded(
  props: Common & {
    labName: string;
  },
) {
  return (
    <Layout
      preview={`Your full ${props.labName} results are ready`}
      practiceName={props.practiceName}
      practiceAddress={props.practiceAddress}
    >
      <Text style={styles.heading}>Your full results are ready</Text>
      <Text style={styles.body}>Hi {props.patientName},</Text>
      <Text style={styles.body}>
        All of your {props.labName} results are now in your patient portal.
        The next step is your Review of Findings — we'll send a separate note
        with scheduling.
      </Text>
      {props.patientPortalUrl ? (
        <Text style={styles.body}>
          View in portal:{" "}
          <a href={props.patientPortalUrl} style={{ color: "#0f8b7e" }}>
            {props.patientPortalUrl}
          </a>
        </Text>
      ) : null}
    </Layout>
  );
}

export function RofFollowup(props: Common) {
  return (
    <Layout
      preview="Thanks for your review — here's what's next"
      practiceName={props.practiceName}
      practiceAddress={props.practiceAddress}
    >
      <Text style={styles.heading}>
        Thanks for your review — here's what's next
      </Text>
      <Text style={styles.body}>Hi {props.patientName},</Text>
      <Text style={styles.body}>
        Great catching up. As discussed, we'll send your protocol shortly, and
        a member of the team will follow up about supplements and anything
        else that came out of the review.
      </Text>
      <Text style={styles.body}>If anything is unclear, reply here.</Text>
    </Layout>
  );
}
