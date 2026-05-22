# End-to-end pipeline test runbook

Walks the full lifecycle: Zenoti appointment → tracker case → simulated FedEx delivery → simulated PDF attach → human Approve → PracticeBetter upload. Designed so Alex can run it solo to validate every wire we shipped 2026-05-21 and 2026-05-22.

The trigger rule (verified in this test): **any** Zenoti service whose name starts with `Labs -` registers a case, regardless of which guest account books it. So booking the appointment under your own Zenoti account works the same as booking it under Leila's — the sync doesn't care whose name is on it.

---

## Happy path (after 2026-05-22 evening — single-command demo)

**One terminal, one command:**

```bash
cd /Users/alexandermoran/Desktop/Everything/Coding_Projects/lab-tracker
npm run dev
```

That spawns four colour-prefixed processes in unified output:

| Prefix | Job |
|---|---|
| `[next]` (cyan) | Next.js dev server on :3000 |
| `[pb]` (magenta) | PB upload drain loop (5s cadence) |
| `[zenoti]` (yellow) | Zenoti sync loop (60s cadence, includes cancellations) |
| `[attach]` (green) | Auto-attach test PDF watcher (5s cadence, test-mode only) |

Single Ctrl+C kills all four. `dev:next-only` is the escape hatch if you ever want just the web server.

### Your demo flow (only these clicks)

1. **Book a lab appointment in Zenoti.** Any service starting `Labs - …` triggers; pick `Labs - Access Custom` if you want the simplest demo since that's the lab with a real scraper today.
2. **Within 60 seconds**, the `[zenoti]` line logs `pushed N • +1 new`. Refresh `/labs` → case in **New** column.
3. **Click the card** → enter Tracking # + Accession # → Save.
4. **Click step 1** (Sample sent). Card moves to Sample Sent.
5. **Wait ~5 seconds.** The `[attach]` line logs `attached → case=… patient=…`. The PDF arrives, **step 4 auto-flips** (no click), the card lands in **Pending Upload** with the amber "PDF awaiting review" banner.
6. **Click the amber banner → Review PDF.** Side-by-side modal opens: "Tracker says" left, PDF right. Verify Patient / DOB / Lab / Accession / Collection date match the PDF.
7. **Click Approve & upload.** Card stays in Pending Upload while the queue is drained.
8. **Within ~5 seconds**, the `[pb]` line logs `uploaded → pb_labrequest=… pb_patient=…`. Card moves to **Complete Uploaded**. Switch to PB tab → patient's chart has the new labrequest titled `<lab> — Acc# <accession>`.

**Total human actions: 4 clicks** (Save, step 1, Review PDF, Approve). Cancelling the Zenoti appointment soft-deletes the case automatically on the next sync tick.

### Verifying the new automation pieces

After running the demo above:

- **Auto step 4:** Activity log on the card shows `Step 4 completed` with actor `scraper:access (test-mode auto-attach)` — confirms the scraper, not a human, advanced it.
- **Cancellation flow:** Cancel the Zenoti appointment. Within 60 seconds, the `[zenoti]` line logs `cancellations: 1 reported / 1 deleted`. The card disappears from the active board (sits in deleted view).
- **Settings → Scrapers tab:** `/labs/settings?tab=scrapers`. Lists 11 portals. Access shows green "Configured · N attaches"; the rest show grey "Not configured". Each row expands to show the bash command for capturing it.
- **Daily health badge:** After the cron runs at 5 AM UTC (or you hit `/api/cron/portal-health` manually with the `CRON_SECRET` Bearer), green ● Reachable badges appear next to each portal name.

---

## Prereqs (do once)

1. **Apply migrations** in Supabase Studio → SQL Editor (the ones not yet run):
   - `supabase/migrations/20260522_pb_upload_jobs.sql`
2. **Create the Supabase Storage bucket** `lab-pdfs` (Studio → Storage → New bucket → name `lab-pdfs` → Public toggle OFF).
3. **Refresh Zenoti cookies** if `worker/captures/zenoti/20260521-202910/storage.json` is older than ~24 h:
   ```bash
   bash ~/.claude/skills/lab-portal-capture/capture.sh zenoti 'https://centnerwellness.zenoti.com/'
   ```
   Then update `STORAGE_PATH` in `worker/scripts/zenoti-sync.ts` to the new dir.
4. **Env vars** (put in a shell you'll reuse — `.envrc`, `direnv allow`, or just `export` them):
   ```bash
   export TRACKER_BASE_URL=http://localhost:3000
   export WORKER_SHARED_SECRET=<same value as in tracker .env.local>
   export PB_USERNAME=info@centnerhb.com
   export PB_PASSWORD='<from password manager>'
   export PB_CONSULTANT_ID=67200c656578f95a89af7534
   ```
5. **Start the dev server** in one terminal:
   ```bash
   npm run dev
   ```

---

## Step 1 — Book a lab appointment in Zenoti

In the Zenoti UI at `https://centnerwellness.zenoti.com/`:
- Create an appointment for **yourself** (or any guest — point is to prove the matcher doesn't care).
- Pick **any service whose name starts with `Labs -`** (e.g. `Labs - Access Custom`).
- Use today's date.

Note the time you scheduled — you'll grep for it in the sync output.

---

## Step 2 — Pull the appointment into the tracker

```bash
cd worker
npx tsx scripts/zenoti-sync.ts
```

Expected output (truncated):
```
[2026-05-22T13:42:01.001Z] fetching Zenoti lab appts for 2026-05-22
[…]   N lab appointment(s) found
[…]   • Alexander Moran • Access • Labs - Access Custom • zenoti=<uuid>
[…] POST → http://localhost:3000/api/worker/cases (N appts)
[…] tracker: received=N created=1 existing=N-1 errors=0
[…]   +NEW  case=<case-uuid>  zenoti=<zenoti-uuid>
```

**Copy the `case=<case-uuid>` value** — you'll use it in Step 4.

Open the tracker in the browser → the case should appear in the **New** column with your name, the lab name mapped from the service, and a note like `zenoti: Labs - Access Custom • therapist: …`.

Open the case detail / activity panel → there should be a `case_created` event with `actor = worker:zenoti-sync` and a `meta` blob containing `zenoti_appointment_id`. **This is the audit trail entry that confirms the sync ran.**

---

## Step 3 — Advance through "sample sent" and FedEx delivery

On the case card:
1. Enter any tracking number (`FEDEX-TEST-001` is fine — we're not exercising real FedEx polling here).
2. Click step 1 ("Sample sent"). Card moves out of New.
3. **Simulate FedEx delivery**: in the activity panel, click step 4 ("Complete received") directly. In production this auto-flips when the FedEx cron sees `delivered`; we're shortcutting it because we're not waiting for a real shipment.

Card should now be ready for the scraper to drop a PDF.

---

## Step 4 — Simulate the scraper attaching Leila's PDF

You already have a working Access PDF on disk from 2026-05-21:

```bash
cd worker
CASE_ID=<the case uuid from Step 2> \
PDF_PATH=~/Desktop/leila/access_007138032.pdf \
ACCESSION=007138032 \
SOURCE=scraper:access \
  npx tsx scripts/simulate-scraper-attach.ts
```

This POSTs to `/api/worker/result-ready` exactly the way the production Access scraper will. After it succeeds:
- Refresh the tracker → the card has moved to the **Pending Upload** column.
- Click the card → the **PDF review modal** opens with Leila's lab embedded.
- The activity log shows a `case_edited` event from `scraper:access` and the lab_external_ref is now `007138032`.

---

## Step 5 — Approve in the modal

Click **Approve** in the modal.

Side effects that should be visible immediately:
- Card leaves the Pending Upload column.
- An `approve` row appears in `lab_case_audit` (visible in the activity panel as "approved by gear15alex@gmail.com").
- A `pb_upload_jobs` row gets inserted with `status = 'queued'`. You can verify in Supabase Studio:
  ```sql
  select id, case_id, pdf_id, status, attempts, created_at
  from pb_upload_jobs
  order by created_at desc
  limit 5;
  ```

**Nothing has been uploaded to PracticeBetter yet.** The Approve action just enqueues — the worker is what drains the queue.

> ⚠️  Don't approve this for real on a real patient. We're using Leila's PDF on a test case (yourself). The PB upload in Step 6 will create a `labrequest` against **Leila** in PB (the patient name on the PDF), not against you — PB matches on the patient name passed to the uploader, which comes from `lab_cases.patient_name`. Since your test case has *your* name, PB will fail to find a patient match unless your name also exists in PB. **If you want the PB upload to succeed end-to-end, edit the test case's `patient_name` to `Leila Centner` and `patient_dob` to `1976-12-28` before approving** — that mirrors what Leila's real case would look like.

---

## Step 6 — Run the PB upload worker

In a separate terminal:

```bash
cd worker
npx tsx scripts/pb-upload-worker.ts --once
```

Expected output:
```
[…] pb-upload-worker starting (interval 30000ms, --once mode)
[…] claimed job <uuid> • case=<case-uuid> • patient=Leila Centner
[…] uploaded → pb_labrequest=<id> pb_patient=<id>
[…] processed 1 job, exiting
```

Verify in Supabase Studio:
```sql
select id, status, attempts, last_error, finished_at
from pb_upload_jobs
where id = '<job uuid from worker output>';
```
- `status = succeeded`
- `attempts = 1`
- `finished_at` set
- `last_error = null`

Verify on the tracker:
- `step5_complete_uploaded` is now `true` on the case.
- Activity log shows a `step_toggled` event with `actor = worker:pb-upload` and `meta.pb_lab_request_id`.

Verify in PracticeBetter:
- Log in as `info@centnerhb.com`
- Find Leila Centner → Labs tab
- The test labrequest is attached. **Delete it from PB** once you've confirmed it lives on the chart, so the test doesn't pollute her real record.

---

## What this proves

| Step | Wire it exercises |
|------|---|
| 1 → 2 | Zenoti adapter + lab-mapping (any `Labs -` service triggers) + `POST /api/worker/cases` (idempotent UPSERT by `zenoti_appointment_id`) |
| 3 | Existing step-toggle UI + audit (no new wires) |
| 4 | `POST /api/worker/result-ready` + Supabase Storage upload + `lab_case_pdfs` insert |
| 5 | `approvePdf()` server action enqueueing `pb_upload_jobs` (the only piece that moves PB-bound work off the request thread) |
| 6 | `POST /api/worker/pb-upload/next` (atomic claim) → uploader → `POST /api/worker/pb-upload/result` → `step5_complete_uploaded` flip |

If every step passes, every wire shipped between 2026-05-21 and 2026-05-22 is verified live with real data.

---

## Failure modes to expect

- **Zenoti returns 401 / 302** — cookies expired. Re-run the capture skill (see Prereqs §3).
- **`patient_email` constraint** — Zenoti returned `null` email. The sync substitutes `<guest_id>@unknown.zenoti.local`. Not an error, just an FYI when you see one in the data.
- **PB returns "patient not found"** — your test case's patient_name doesn't match any PB patient. Edit the case to Leila Centner / 1976-12-28 before approving (see Step 5 warning).
- **Worker hangs on PDF download** — the signed URL TTL is 10 minutes. If you waited longer between Approve and running the worker, re-Approve (it upserts the job back to queued and re-issues a fresh signed URL on next claim).
- **`pb_upload_jobs` table missing** — migration `20260522_pb_upload_jobs.sql` hasn't been applied. See Prereqs §1.

---

## Cleanup

```sql
-- Remove the test case + cascades (lab_events, lab_case_pdfs, lab_case_audit,
-- pb_upload_jobs). Replace with the case uuid from Step 2.
delete from lab_cases where id = '<test-case-uuid>';
```

And in PB → delete the test labrequest off Leila's chart.
