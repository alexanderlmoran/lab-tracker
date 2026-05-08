# Tasks — phased

Mark items `[x]` as completed. Each phase ends in a working, demoable state
on local dev. Deploy to Vercel happens after Phase 4.

---

## Phase 0 — Bootstrap  (DONE)
- [x] Stack: Next.js 16 + Supabase JS SDK + Supabase Auth + Tailwind v4 + Resend (**pivoted off Prisma — see notes**)
- [x] `create-next-app` (App Router, TS, Tailwind, ESLint, Turbopack, src/, alias `@/*`)
- [x] Supabase MCP server configured at project scope (`.mcp.json`) — **needs `claude /mcp` auth in user's terminal**
- [x] Schema written as SQL migration: `supabase/migrations/20260506_init.sql`
- [x] `.env.local` populated with `NEXT_PUBLIC_SUPABASE_URL` + publishable key; `SUPABASE_SECRET_KEY` and `RESEND_API_KEY` left blank for user
- [x] `.env.local.example` written
- [x] `src/utils/supabase/{server,client,admin,session}.ts` created
- [x] `src/lib/resend.ts` (lazy init)
- [x] `npm run dev` renders `/` (redirects → `/labs`) and `/labs` placeholder. `npm run build` clean.
- [ ] User runs SQL migration in Supabase Studio → SQL Editor (paste `supabase/migrations/20260506_init.sql`)
- [ ] User creates the super-admin user in Supabase Studio → Authentication → Users → Add user
- [ ] User pastes `SUPABASE_SECRET_KEY` and `RESEND_API_KEY` into `.env.local`
- [ ] First commit + push — **deferred, needs user auth for remote**

### Phase 0 notes — gotchas to carry forward
- **Next.js 16 renames `middleware.ts` → `proxy.ts`** (nodejs runtime only; no edge). `skipMiddlewareUrlNormalize` → `skipProxyUrlNormalize`. The `AGENTS.md` at project root has the warning. Always check `node_modules/next/dist/docs/` before assuming Next.js APIs.
- **`cookies()`, `headers()`, `params`, `searchParams` are async** in Next 16 — must `await`.
- **Pivoted off Prisma** in Phase 0 because the user couldn't locate the Postgres pooler URL in the Supabase dashboard. Switched to Supabase JS SDK + Supabase Auth using the publishable + secret keys. Side benefits: dropped the home-rolled JWT scheme, RLS deny-all gives defense-in-depth, Supabase Studio is a free admin UI.
- **`@react-email/components`** + **`react-email`** installed but no templates wired yet (Phase 4).

## Phase 1 — Database + Supabase Auth gate  (DONE pending user-created admin)
- [x] SQL migration ran in Supabase Studio — three tables visible: `lab_cases`, `lab_events`, `email_logs`
- [ ] **Admin user created in Supabase Studio → Authentication → Users → Add user (still pending — user action)**
- [x] `SUPABASE_SECRET_KEY` set (typo fixed)
- [x] `src/proxy.ts` — calls `refreshSupabaseSession`, redirects unauthenticated requests to `/login?next=...`, redirects authenticated users away from `/login`
- [x] `src/app/login/page.tsx` + `LoginForm.tsx` (client) + `actions.ts` server action calling `signInWithPassword`
- [x] `src/app/auth/callback/route.ts` — code-exchange handler (boilerplate; not used by password flow but in place for magic-link later)
- [x] `logoutAction` server action — `supabase.auth.signOut()` + redirect to `/login`
- [x] `src/lib/auth-guard.ts` — `requireAdmin()` helper used at top of every page and server action
- [x] Verified: unauth `/labs` → 307 to `/login?next=/labs`; bare `/` → ends at `/login?next=/`; Supabase Auth endpoint reachable end-to-end (invalid creds returned `invalid_credentials` not a network/config error)

## Phase 2 — Case CRUD + list  (DONE pending UI smoke)
- [x] `src/lib/types.ts` — manual TS types mirroring the SQL schema (snake_case throughout)
- [x] `src/app/labs/actions.ts` — `createLabCase`, `updateLabCase`, `archiveLabCase`, `unarchiveLabCase`, `listLabCases`. Each mutating action writes to `lab_events` (`kind = case_created | case_edited | case_archived | case_unarchived`, `actor = user.email`, edits capture `meta.changes`).
- [x] `/labs` rebuilt: header (email, archived link, sign-out), case-count badge, "+ New case" dialog, table view with progress badge (X / 9) and per-row Edit / Archive actions
- [x] `/labs/archived` route — same table component, unarchive button instead of archive
- [x] Native `<dialog>` component (`CaseDialog.tsx`) with shared `CaseFormFields.tsx` for create + edit
- [x] Untyped admin client (`SupabaseClient`) — manual types in `src/lib/types.ts` are the contract; revisit if drift becomes painful
- [x] **Verified live against Supabase**: round-trip insert → select → delete + `lab_events` insert all 200/201
- [ ] Manual UI smoke (you, in the browser): create 3 cases (one archived), edit one, verify in Supabase Studio Table Editor that `lab_events` shows `case_created` / `case_edited` / `case_archived` rows

### Phase 2 gotchas
- **Invisible Unicode in `.env.local`** — the `SUPABASE_SECRET_KEY` value originally had a U+2028 LINE SEPARATOR at index 41 (from copy-pasting the dashboard). It silently 401'd every request with `TypeError: Cannot convert argument to a ByteString`. Stripped in place. Lesson: scrub non-ASCII from secrets when copy-pasting.
- **New `sb_secret_*` keys aren't JWTs** — raw REST calls to PostgREST that worked with the old `service_role` JWT now reject the new short tokens with "Invalid API key". The Supabase JS SDK handles auth differently and works fine. **Don't bother with raw REST for admin operations; always go through the SDK.**

## Phase 3 — Kanban view + step transitions  (DONE pending UI smoke)
- [x] `src/lib/columns.ts` — `getColumnFor`, `COLUMN_ORDER`, `stepIsComplete`, `completedStepCount`, `isEmailStep`, step labels
- [x] **7-column** layout (added a leftmost "New" column for cases with no steps yet — without it, fresh cases would have no home)
- [x] `setStepCompleted` server action: updates the matching `stepN_*` boolean + writes `step_toggled` to `lab_events`. No email yet.
- [x] `getLabCase` and `listLabEvents` server actions
- [x] `/labs` page rebuilt as kanban grid (`Kanban.tsx`)
- [x] `CaseCard.tsx` — compact card, kebab menu (Open detail / Open in full page / Archive), click anywhere opens the detail dialog, optimistic step toggling
- [x] `CaseDetail.tsx` — patient panel + case panel + 7-column progress strip + 9-step checklist + activity log. Reused inside the modal AND on `/labs/[id]`
- [x] `StepChecklist.tsx` — checkbox row per step, optimistic update with rollback on error, email-marked steps show an "email" tag and an explanatory note that Phase 4 wires sends
- [x] `ActivityLog.tsx` — lazy-loads events on mount, renders chronological list with timestamp + actor + describe-by-kind
- [x] Steps 2 + 3 visually disabled (greyed, "(skip)") when `partial_expected = false`
- [x] `/labs/[id]/page.tsx` — full-page deep-link detail
- [x] **Verified live**: created a case, ticked all 9 steps via SDK, confirmed all booleans flipped + 9 `step_toggled` events recorded
- [ ] Manual UI smoke (you, in the browser): create a case, tick steps 1 → 9 in the modal, watch the card move through the columns, verify activity log entries, deep-link to `/labs/[id]`

## Phase 3.5 — Drag + dropdown column move  (DONE pending UI smoke)
- [x] Installed `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`
- [x] `src/lib/column-jump.ts` — `planColumnJump(row, target)` computes the steps that need to flip; each column has a "defining step" (`COLUMN_DEFINING_STEPS`)
- [x] `KanbanBoard.tsx` — wraps the grid in a `DndContext` with `PointerSensor` (6px activation distance so click-to-open still works), droppable columns highlight on hover
- [x] `CaseCard.tsx` accepts `emailDialogRef` + `columnJumpRef` and adds a "Move to ▸" submenu in the kebab; dropping = same handler as the submenu
- [x] `ColumnJumpDialog.tsx` — confirmation dialog: lists affected steps, marks email steps with the "email confirm" tag, three buttons: Cancel / Review and send N emails / Move without sending emails. Sequential email confirms; cancel any one rolls back the whole move.

## Phase 4 — Resend emails + confirmation dialog  (DONE pending UI smoke)
- [x] `src/lib/email/Layout.tsx` — light-mode-locked shared shell (table-based, plain-text fallback via `render({ plainText })`)
- [x] `src/lib/email/templates.tsx` — four templates (`SampleSent`, `PartialUploaded`, `CompleteUploaded`, `RofFollowup`)
- [x] `src/lib/email/render.ts` — pure `renderEmail(row, kind) → { to, bcc, from, replyTo, subject, html, text, isTestRedirect }`. Honors `EMAIL_TEST_REDIRECT`. `from` header = `${PRACTICE_NAME} <${ALERT_FROM_EMAIL}>`. `bcc` from `EMAIL_BCC` (silent audit trail to alex@centnerhb.com).
- [x] `src/lib/email/step-map.ts` — `emailKindForStep(step) → EmailKind | null` (1→sample_sent, 3→partial_uploaded, 5→complete_uploaded, 7→rof_followup)
- [x] `GET /api/email/preview?caseId=…&kind=…` — server-renders the exact template the send action uses; returns HTML for the dialog's sandboxed iframe
- [x] `sendPatientEmail` server action — idempotency-first: insert `email_logs{queued}` → on unique-violation `(case_id, kind)` return `{alreadySent}` → call Resend → flip to `sent` (with `resend_message_id`) or `failed` (with `error_message`) → write `email_sent` / `email_failed` to `lab_events`. Optionally flips the step boolean and writes a `step_toggled` event on success.
- [x] `skipPatientEmail` — inserts `email_logs{skipped}` + `lab_events{email_skipped}` + `lab_events{step_toggled}`, locks future sends via the unique constraint
- [x] `retryPatientEmail` — deletes the failed `email_logs` row first, then calls `sendPatientEmail` (without re-toggling step)
- [x] `getEmailMeta` server action — returns To/From/Reply-To/BCC/Subject for the dialog without rendering HTML twice
- [x] `EmailConfirmDialog.tsx` — imperative ref API (`open({caseId, kind}) → Promise<{sent | skipped | cancelled}>`). Shows To/From/Reply-To/BCC/Subject + sandboxed iframe preview + Cancel / Send / Skip. Test-mode banner when `EMAIL_TEST_REDIRECT` is set.
- [x] Wired into `StepChecklist`: ticking step 1/3/5/7 awaits the dialog; cancel reverts; send/skip advances the step server-side via the email actions.
- [x] Wired into `ColumnJumpDialog`: cross-column moves walk per-email confirmations sequentially.
- [x] **Verified live**: Resend send through the actual env config returned message ID `b9205b8c-ad98-429a-8158-44b62899a3bc` — TO + BCC both delivered to alex@centnerhb.com.
- [ ] **User: verify `centner.com` in Resend dashboard** (https://resend.com/domains) so production sends from `alert@centner.com` work. Currently `ALERT_FROM_EMAIL=onboarding@resend.dev` in the env (sandbox sender — fine for dev; will not deliver to non-Resend recipients in production).
- [ ] Manual UI smoke: tick step 1 → confirmation dialog appears → review preview → click Send → check `alex@centnerhb.com` for both TO and BCC copies; verify `email_logs` row with `status=sent` and `resend_message_id` populated.

## Phase 5 — UX polish (target: ~1 hr)
- [ ] Search by patient name / email / phone / tracking number.
- [ ] Filter by lab name (distinct values).
- [ ] Activity log filter chips (toggle visibility per `LabEventKind`).
- [ ] "Closed" column collapsed by default with case count badge.
- [ ] Mobile responsive: stacked columns under 768px.
- [ ] Vercel deploy + domain decision.

## Phase 6 — Integrations (stretch, separate session)
- [ ] Practice Better — webhook on file upload? confirm API exists
- [ ] Zenoti — webhook on appointment booked + completed
- [ ] Access lab portal — likely no API, leave manual
- [ ] Document in `INTEGRATIONS.md` (to be created)

---

## Definition of done (per phase)
1. Run `npm run build` — passes with no warnings.
2. Walk the new functionality in the browser. Test golden path + one edge case.
3. State results literally in the session ("created case, advanced to step 5, email sent, message ID xyz"). No assumed success.
