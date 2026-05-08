# Lab Tracker — Implementation Plan

Internal kanban for tracking patient lab cases through the 9-step lifecycle:
sample sent to lab → partial results → complete results → ROF scheduled
in Zenoti → ROF done → protocol sent → salesperson follow-up. Standalone
app, single super-admin user, Resend handles patient-facing emails.

## Files in this directory
- `TASK.md` — phased task list (working checklist)
- `SCHEMA.md` — data model rationale (canonical schema is `supabase/migrations/`)
- `API.md` — server actions + route handler contract
- `UI.md` — kanban page spec
- `EMAILS.md` — the four Resend templates and trigger rules

Env vars are documented in `.env.local.example` at the project root.

## The 9 steps (source of truth)
1. Sample sent to lab. Tracking number logged. **Email 1** to patient.
2. Partial results received (Access portal). *(optional — panel-dependent)*
3. Partial results uploaded to Practice Better. **Email 2** to patient.
4. Complete results received.
5. Complete results uploaded to Practice Better. **Email 3** to patient.
6. Patient scheduled in Zenoti for ROF (Review of Findings).
7. ROF confirmed completed. **Email 4** to patient (next steps).
8. Patient emailed protocol.
9. Salesperson follow-up for supplements / upsell.

## Kanban model
Steps are sequential but 9 columns is too many for a useful board. Cards
expose all 9 steps as a checklist; the card's column is **derived** from the
highest completed step:

| Column            | Triggered by completed step |
|-------------------|-----------------------------|
| Sample Sent       | Step 1                      |
| Partial Results   | Step 2 or 3                 |
| Complete Results  | Step 4 or 5                 |
| ROF Scheduled     | Step 6                      |
| ROF Done          | Step 7                      |
| Closed            | Step 8 and 9                |

Users can advance cards three ways — all routing through the same email-confirmation gate (see below):
1. Tick a step checkbox inside the detail modal.
2. Pick a column from the kebab "Move to ▸" submenu.
3. Drag the card to another column.

## Most important UX guarantee
**No patient email is ever sent without an explicit per-send confirmation
dialog.** "Auto-send" only controls whether the dialog *auto-opens* on a
step toggle; it never authorizes background sending. Drag, dropdown, and
checkbox all route through the same confirmation. See `UI.md` "Email
confirmation".

## Stack (locked — Phase 0 done)
- **Next.js 16** App Router (Turbopack default; `proxy.ts` for the auth gate, NOT `middleware.ts`)
- **Supabase JS SDK** (`@supabase/supabase-js` + `@supabase/ssr`) — Postgres queries via PostgREST. Project `oohgjlatfkdckopmbpcc`. **No Prisma.**
- **Supabase Auth** for the super-admin login (one user, email/password). Replaces the home-rolled JWT scheme.
- **Tailwind v4**
- **shadcn/ui** for primitives (Dialog, Button, Input, Checkbox) — added in Phase 2 as needed
- **`@dnd-kit/*`** for drag-and-drop (Phase 3.5)
- **`react-email` + `@react-email/components`** for templates (Phase 4)
- **Resend**, `from = Centner <alert@centner.com>` — verify domain before going live
- **Vercel** deploy. Single super-admin user, RLS deny-all (server uses the secret key to bypass).

## Out of scope (v1)
- Multi-user / role permissions.
- Patient self-service portal.
- SMS.
- Practice Better / Zenoti / Access API integrations — manual checkboxes only.
- Real-time multi-tab sync.

## Conventions (carry over from StockSafe)
- No emojis in code or comments.
- Default to no comments. Only write *why* when non-obvious.
- Zod validation at server-action / route boundaries.
- Terse commit messages, body explains *why*.
