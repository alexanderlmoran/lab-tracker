# Patient emails — Resend

Four patient-facing emails. **No email is ever sent without an explicit
per-send confirmation dialog** — see `UI.md` "Email confirmation". The
`autoSendEmails` flag on `LabCase` only controls whether the dialog
auto-opens when a step is toggled (on) vs. surfaces a manual `[Send email →]`
button (off). It does **not** authorize background sending.

**Sending domain (decided):** `from = Centner <alert@centner.com>`.
Verify the `centner.com` domain in Resend before any production send.

## Trigger map

| Email kind         | Fires when             | Source step | Subject                                          |
|--------------------|------------------------|-------------|--------------------------------------------------|
| `sample_sent`      | step 1 → completed     | 1           | Your sample is on its way to the lab             |
| `partial_uploaded` | step 3 → completed     | 3           | Partial lab results are ready in your portal     |
| `complete_uploaded`| step 5 → completed     | 5           | Your full lab results are ready                  |
| `rof_followup`     | step 7 → completed     | 7           | Thanks for your review — here's what's next      |

## Idempotency
`EmailLog` has `@@unique([caseId, kind])`. The send flow inserts the log row
*first*; if the insert fails on the unique key, the email has already been
sent (or is in flight in another request) and the action short-circuits with
`{ ok: true, alreadySent: true }`. Failed sends update the row to `failed`;
the UI exposes a retry that **deletes** the failed row before re-attempting.

## Variables available to every template
- `patientName`
- `practiceName` (from env: `PRACTICE_NAME`, displayed in greeting + signoff)
- `patientPortalUrl` (from env: `PATIENT_PORTAL_URL`, e.g. Practice Better link)
- `replyToEmail` (from env: `REPLY_TO_EMAIL`)

## Per-template variables

### Email 1 — `sample_sent`
- `labName` (e.g. "Dutch")
- `trackingNumber` (optional — omit the line if absent)
- `expectedTurnaround` (optional, free text — e.g. "2 to 3 weeks")

Body sketch:
> Hi {patientName},
>
> Your sample has been sent to {labName}. {trackingNumber ? "Tracking: {trackingNumber}." : ""}
> Most results return within {expectedTurnaround ?? "a few weeks"}; we'll
> reach out as soon as anything is ready in your portal.
>
> If anything looks off in the meantime, just reply to this email.

### Email 2 — `partial_uploaded`
- `labName`
Body:
> Hi {patientName},
>
> Some of your {labName} results are now uploaded to your Practice Better
> portal. Have a look when you get a chance — full results will follow.
>
> [View in portal] → {patientPortalUrl}

### Email 3 — `complete_uploaded`
- `labName`
Body:
> Hi {patientName},
>
> All of your {labName} results are now in your Practice Better portal.
> The next step is your Review of Findings — we'll send a separate note
> with scheduling.
>
> [View in portal] → {patientPortalUrl}

### Email 4 — `rof_followup`
- `protocolEtaText` (optional — e.g. "by Friday")
Body:
> Hi {patientName},
>
> Great catching up. As discussed, we'll send your protocol over
> {protocolEtaText ?? "shortly"}, and a member of the team will follow
> up about supplements and anything else that came out of the review.
>
> If anything is unclear, reply here.

## Brand shell
One reusable HTML wrapper (`lib/email/layout.ts`):
- Light-mode locked (`color-scheme: light only` meta) — Apple Mail and Gmail
  mobile invert otherwise; same trick StockSafe uses.
- Inline CSS only. Email clients drop `<style>` inconsistently.
- Plain-text fallback rendered from the same data.
- `from`: `{PRACTICE_NAME} <{ALERT_FROM_EMAIL}>` — verified Resend domain required before going live.
- `reply_to`: `{REPLY_TO_EMAIL}`.
- Footer: practice address (env `PRACTICE_MAILING_ADDRESS`) — needed for CAN-SPAM compliance.

## Testing in dev
- Set `RESEND_API_KEY` to your real key.
- Set `EMAIL_TEST_REDIRECT` to your own email — when defined, the send helper
  rewrites `to` to this address and prepends `[TEST → originalAddress]` to
  the subject. Don't ship without unsetting (or set to empty in prod env).
- Resend dashboard → Logs shows delivery status; cross-check `EmailLog.status`.
