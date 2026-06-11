# Lab Automation Map — portal → scrape → stage → post

The targeted view of everything automated between "sample at the lab" and
"result on PracticeBetter." One section per stage, with WHERE it lives, the
INVARIANTS it must hold, and the risk points. Updated 2026-06-10 after the
system-wide audit + hardening pass (see "Hardening changelog" at the bottom).

```
Zenoti appt ──► lab_case ──► FedEx polling ──► [FEED] open-cases ──► [SCRAPE] worker
                                                                          │
            staff Approve ◄── Pending Upload ◄── [STAGE] result-ready ◄───┘
                  │  (or engine autoApprove ≥95)
                  ▼
            pb_upload_jobs ──► [POST] pbdrain worker ──► PracticeBetter
                                       │ (via Tailscale exit node — ThinkPad)
                                       ▼
                              pb-upload/result ──► step5 + sibling cascade
                                                  + Nadia / staff notices
```

## 1. The feed — which cases get scraped

`src/app/api/worker/open-cases/route.ts` (app, Vercel). Worker GETs per lab.

| Path | Gate |
|------|------|
| Main | accession set + not step5 + active, AND (step2/4 received OR in result window) |
| Result window | poll from delivery (or collection+2d) → predicted max + **60d grace** |
| Access partials | staged re-checks (day 2 / 4–7 / 14+) — `partialCompletionCheckDue` |
| Vibrant accession-less | 2nd bounded query: Vibrant name + **DOB set** + ≤120d, Vibrant feed only |

**Invariants:** probing a not-ready accession-matched case is a safe no-op.
`dismissed_refs` rides along so rejected accessions aren't re-offered.
**Risk point:** a case with no collection date falls out of the feed
`max+grace` after its anchor — widened to 60d grace (was 21d ⇒ silent
starvation ~56d in). If results can land later than ~95d, raise it again.

## 2. The scrape — matching a portal row to a case

Recipes (`worker/src/recipes/runner.ts`) drive access/cyrex/spectracell/
glycanage/doctorsdata; hand-written scrapers for vibrant (`scrapers/vibrant.ts`),
genova, doctorsdata-legacy (reconcile probes). Runners: `scrape-all.ts` (Fly
`scrape` loop), `/run/:lab` + `/probe/:lab` (server.ts), `reconcile.ts` (engine).

**The matching policy (uniform after 2026-06-10):**
1. **Accession on the case → exact accession match ONLY.** Never fall back to
   name (the patient's *other* order would be the wrong lab).
2. **No accession → name (+DOB when available) and UNAMBIGUOUS only**: exactly
   one compatible row/patient/order, else skip and wait for an accession or
   manual upload. Vibrant additionally REQUIRES a DOB on the case and treats a
   full 25-row search page as ambiguous.
3. Every found result carries **`portalPatientName`** (the name as the portal
   shows it) so the server can independently verify identity.

**Session health:** Genova aborts the whole run loudly on a mid-run session
death (non-PDF report body) instead of burying it as per-case "not ready".
The activities leg already threw loudly. DoctorsData/others: session failures
throw at auth time. *(Still open: surfacing "re-login needed" in the UI.)*

## 3. The stage — result-ready

`src/app/api/worker/result-ready/route.ts`. The single door every scraped or
probed PDF walks through. Order of gates:

1. **Patient-identity gate** — if `portalPatientName` is present and its last
   name ≠ the case's, **409 reject** + loud activity-log entry.
2. **Idempotency** — same case + accession + byte-size + partial-flag on a
   live row ⇒ return the existing pdfId (`deduped: true`). A retried post or
   pre-step5 re-scrape can no longer double-stage / double-queue PB.
3. Storage upload + `lab_case_pdfs` insert (`size_bytes` recorded).
4. **Guarded accession adoption** — the report's accession overwrites the
   case's only when the case had none or the portal name corroborated;
   an unverified mismatch keeps the staff-entered accession and flags it.
5. Step auto-flip (step 2 partial / step 4 complete, with prior-step cascade).
6. `autoApprove` (engine ≥ threshold) → audit row + `pb_upload_jobs` enqueue.

**Invariant:** result-ready NEVER posts to PB itself; it stages. Partial-prone
labs (vibrant, access) are force-staged partial by scrape-all.

## 4. The post — PB upload + completion fan-out

Queue: `pb_upload_jobs` (queued → claimed → succeeded/failed). Drain: Fly
`pbdrain` process → `worker/src/uploaders/practicebetter.ts` (pure HTTP,
egress via the ThinkPad Tailscale exit node — PB blocks datacenter IPs).

Outcome: `src/app/api/worker/pb-upload/result/route.ts`:
- **Terminal-job short-circuit** — a re-delivered outcome for an already
  succeeded/failed job is a no-op (no duplicate step flips/cascades/emails).
- success → step5 + same-accession **sibling cascade** (siblings' PDFs
  superseded, steps advanced, no re-upload) → Nadia gate → staff notice (#21,
  deduped per case; the one notice covers the physical order).

## 5. The group semantics — same-accession siblings

`src/lib/labs/siblings.ts` — `accessionSiblingIds` = same patient + same
trimmed accession **+ same lab (`sameLab`)**. The lab guard exists because
accession namespaces are per-vendor; without it a colliding ref string from a
different lab would be dragged through every cascade.

`setStepCompleted({cascadeSiblings})` (actions.ts): sibling replays run with
`_skipWorkflowEmails` and the Nadia/Allison trigger fires **once per click**
after the whole group has moved (Allison's stamp is copied to siblings so a
later direct toggle can't re-email her for the same order).

## 6. The internal emails — gates and races

`src/lib/workflow.ts` + `src/lib/email/internal.ts`:
- **Nadia "all received"** — fires only when every active lab for the patient
  is at step 5; **atomic claim** on the smallest sibling id (conditional
  update) so two concurrent step-5 flips can't both send.
- **Allison ROF** — per-case `allison_rof_emailed_at` dedup; when
  `ALLISON_EMAIL` is unset the email routes to the internal digest inbox with
  a `[ALLISON_EMAIL not set — review & forward]` subject instead of a guessed
  external address (it carries PHI).
- Patient-facing tracker emails remain **manual-send only** (backlog #11).

## 7. Dates — one clock

The clinic runs Eastern; Vercel/Fly run UTC. Every "what day is it" goes
through **`easternDateIso()`** (`src/lib/format.ts`): `predictResultDates`,
`daysFromTodayIso`/`expectedCountdown`, `isProbablyReady` (now shared from
`src/lib/columns.ts` — don't re-copy it into components). Symptoms of breaking
this rule: hydration mismatches every evening, expected windows a day late.

## 8. Loops and deploys

| Process | Where | Deploys via |
|---------|-------|-------------|
| `scrape` (scrape-all --loop) | Fly | `fly deploy` |
| `pbdrain`, `tracking`, `zenoti` | Fly | `fly deploy` (+ `fly machine start` for zenoti!) |
| open-cases / result-ready / pb-upload routes, all UI | Vercel | push to main |

Worker code changes do NOTHING in prod until `fly deploy` — and the deploy
stops the always-on zenoti machine (restart it).

## Hardening changelog (2026-06-10 audit sweep)

| Fix | Class |
|-----|-------|
| Unambiguous-only name matching in recipes/genova/doctorsdata; Vibrant requires case DOB; no name-fallback when an accession exists | wrong-patient |
| `portalPatientName` threading + result-ready 409 identity gate | wrong-patient |
| Guarded accession adoption (no blind overwrite) | wrong-patient |
| result-ready stage dedup; pb-upload terminal short-circuit | duplicate posts |
| Nadia atomic claim; cascade fires group emails once; Allison sibling stamp | duplicate emails |
| Allison fallback to internal inbox when env unset | PHI routing |
| FedEx pickup dedup (skip already-booked, skip the API call entirely) | double billing |
| open-cases grace 21→60d | silent starvation |
| Genova session death aborts run loudly | masked failures |
| `easternDateIso()` everywhere a calendar day is compared | timezone drift |

**Known-open:** portal session-health surfacing in the UI; Genova MFA re-auth
is manual; Kennedy Krieger is email-only (manual upload); `auto_send_emails`
remains vestigial pending a product decision (#11).
