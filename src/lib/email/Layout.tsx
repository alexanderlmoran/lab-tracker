import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

const main = {
  backgroundColor: "#f8fafc",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  color: "#0b1f3a",
  margin: 0,
  padding: 0,
} as const;

const container = {
  backgroundColor: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  margin: "24px auto",
  maxWidth: "560px",
  padding: "32px",
} as const;

const heading = {
  fontFamily: "Georgia, 'Times New Roman', serif",
  fontSize: "20px",
  fontWeight: 600,
  color: "#0b1f3a",
  margin: "0 0 16px 0",
  lineHeight: 1.3,
} as const;

const body = {
  fontSize: "15px",
  lineHeight: 1.6,
  color: "#0b1f3a",
  margin: "0 0 12px 0",
} as const;

const footer = {
  fontSize: "12px",
  lineHeight: 1.5,
  color: "#6b7a8c",
  margin: "0",
} as const;

const hr = {
  borderColor: "#e5e7eb",
  margin: "24px 0",
} as const;

export function Layout({
  preview,
  practiceName,
  practiceAddress,
  children,
}: {
  preview: string;
  practiceName: string;
  practiceAddress?: string | null;
  children: React.ReactNode;
}) {
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section>{children}</Section>
          <Hr style={hr} />
          <Text style={footer}>
            {practiceName}
            {practiceAddress ? <><br />{practiceAddress}</> : null}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export const styles = { heading, body };
