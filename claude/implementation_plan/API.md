# API contract — server actions + route handlers

All mutations are Next.js **server actions** (co-located with the page).
Route handlers under `app/api/` exist for HTTP-only concerns: auth
callbacks, email preview rendering, future webhooks.

All actions:
- Validate input with Zod at the entry point.
- Reject if `proxy.ts` didn't already let the request through (defense in depth: every action calls `requireAdmin()` first, which reads the Supabase session via `createSupabaseServerClient()` and throws if absent).
- Return `{ ok: true, data?, error? }` discriminated unions. No throws bubble to client; UI handles `error`.

## Data layer

```ts
// src/utils/supabase/server.ts          → user-authed client (RLS applies)
// src/utils/supabase/admin.ts           → secret-key client, bypasses RLS
// src/utils/supabase/session.ts         → cookie-refresh helper for proxy.ts
// src/utils/supabase/client.ts          → browser client (rare; mostly for realtime if we add it)
```

Server actions write through the **admin client** (`getSupabaseAdmin()`).
The auth gate is enforced separately by `proxy.ts` + `requireAdmin()`. We
don't try to reuse the user's Supabase session for queries — bypassing RLS
keeps SQL simple and avoids policies for a single-tenant tool.

## Server actions

### `createLabCase(input)`
```ts
const Input = z.object({
  patientName:    z.string().min(1).max(200),
  patientEmail:   z.string().email(),
  patientPhone:   z.string().max(40).optional(),
  patientDob:     z.string().date().optional(),       // YYYY-MM-DD
  patientAddress: z.string().max(500).optional(),
  labName:        z.string().min(1).max(100),
  labPanel:       z.string().max(100).optional(),
  trackingNumber: z.string().max(100).optional(),
  partialExpected: z.boolean().default(false),
  autoSendEmails:  z.boolean().default(true),
  notes:          z.string().max(2000).optional(),
});
```
Side effects: inserts a row in `lab_cases`, then a `lab_events` row with
`kind = 'case_created'`. Does **not** auto-trigger Email 1 — Email 1 fires
only when step 1 is ticked (and only after the per-send confirmation).

### `updateLabCase(id, patch)`
Same shape as `createLabCase` input but all fields optional. Diffs against
current row; writes `lab_events` with `kind = 'case_edited'` and
`meta = { changes: { fieldName: { from, to }, ... } }`.

### `setStepCompleted(caseId, step, completed, note?)`
```ts
const Input = z.object({
  caseId:    z.string().uuid(),
  step:      z.number().int().min(1).max(9),
  completed: z.boolean(),
  note:      z.string().max(500).optional(),
});
```
Side effects:
1. Insert `lab_events` with `kind = 'step_toggled'`, `step`, `completed`, `note`.
2. Update the matching `stepN_*` boolean on `lab_cases`.
3. **Does NOT send an email itself.** The client opens the per-send confirmation dialog *before* calling this action when step ∈ {1,3,5,7} AND `completed === true`. The email send happens via `sendPatientEmail` from inside that confirmation flow. This keeps the data action and the network-side-effect cleanly separable.

Edge: unchecking step 1 after Email 1 sent does **not** un-send. The
`email_logs` row persists.

### `archiveLabCase(id)` / `unarchiveLabCase(id)`
Sets / clears `archived_at`. Writes `lab_events` with `kind = 'case_archived'` / `'case_unarchived'`.

### `sendPatientEmail(caseId, kind, opts?)`
Called by the confirmation dialog after the operator clicks "Send and mark step complete". Also called by `[Retry]` on a failed send and `[Send email →]` for manual sends.

```ts
const Input = z.object({
  caseId: z.string().uuid(),
  kind:   z.enum(['sample_sent','partial_uploaded','complete_uploaded','rof_followup']),
  opts:   z.object({ skipMarkComplete: z.boolean().default(false) }).optional(),
});
```

Algorithm:
```
1. Fetch lab_case. If missing → return { ok:false, error:'case_not_found' }.
2. INSERT into email_logs (case_id, kind, status='queued', to_address).
   On unique-key violation → email already sent / in flight →
     return { ok:true, alreadySent:true }.
3. Render template via lib/email/templates (the same renderer as the preview endpoint).
4. resend.emails.send({ from, to, replyTo, subject, html, text }).
5. On success:
     UPDATE email_logs SET status='sent', resend_message_id=...
     INSERT lab_events (kind='email_sent', meta={kind, messageId}).
     If !skipMarkComplete → also setStepCompleted internally for the mapped step.
6. On Resend error:
     UPDATE email_logs SET status='failed', error_message=...
     INSERT lab_events (kind='email_failed', meta={kind, error}).
     return { ok:false, error: 'send_failed' }.
```

### `skipPatientEmail(caseId, kind)`
Operator picked "Mark step complete without sending" in the confirmation
dialog.
- INSERT `email_logs` with `status = 'skipped'`. (Unique constraint blocks future sends.)
- INSERT `lab_events` with `kind = 'email_skipped'`.
- Mark the step complete via `setStepCompleted`.

### `retryPatientEmail(caseId, kind)`
- DELETE the `email_logs` row where `(case_id, kind, status='failed')`.
- Call `sendPatientEmail`.

## Route handlers

### `GET /api/email/preview?caseId=...&kind=...`
Server-renders the exact template `sendPatientEmail` would render, with the
case's real data. Returns HTML for the confirmation-dialog iframe. Auth-gated.

### `POST /auth/callback` (Supabase Auth)
The Supabase Auth helper redirects here after email/password sign-in to
exchange the auth code for a session. Standard Supabase pattern.

### Phase 6 webhooks (deferred)
- `POST /api/webhooks/practice-better` — TBD; depends on whether PB exposes upload events.
- `POST /api/webhooks/zenoti` — TBD; appointment-booked + completed.
- `POST /api/webhooks/resend` — bounce / complaint handler. Updates `email_logs.status`.

## Auth (Supabase Auth)
- `src/proxy.ts` calls `refreshSupabaseSession(request)` from `utils/supabase/session.ts` on every request, then redirects to `/login` if the user is null and the path is not in the allowlist (`/login`, `/auth/*`, `/_next/*`, static assets).
- `/login` page: email + password form, posts to a server action that calls `supabase.auth.signInWithPassword(...)` and redirects to `/labs`.
- Logout: server action calls `supabase.auth.signOut()`.
- **One user.** Created manually in Supabase Studio (Authentication → Users → Add user). No registration UI.
- Password reset: use Supabase Studio if needed; no in-app reset flow in v1.
