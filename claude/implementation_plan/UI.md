# UI spec — kanban + card detail + email confirmation

## Routes
- `/login` — single password field, submit, redirect to `/labs`.
- `/labs` — kanban board (default landing).
- `/labs/[id]` — full-detail page for one case (deep-linkable; the detail modal "open in full page" affordance navigates here).
- `/labs/archived` — archived cases as a table.

## `/labs` layout
```
┌────────────────────────────────────────────────────────────────┐
│ Lab Tracker        [Search…]  [Lab: All ▾]      [+ New case]  │
├────────┬────────┬───────────┬────────────┬──────────┬─────────┤
│ Sample │Partial │ Complete  │ ROF        │ ROF      │ Closed  │
│ Sent   │Results │ Results   │ Scheduled  │ Done     │ (n)  ▸  │
├────────┼────────┼───────────┼────────────┼──────────┼─────────┤
│ [card] │ [card] │ [card]    │ [card]     │ [card]   │         │
│        │        │           │            │          │         │
└────────┴────────┴───────────┴────────────┴──────────┴─────────┘
```
- Six columns. Closed collapsed by default with a count badge.
- Mobile (<768px): columns stack vertically; one column expanded at a time.

## Card (compact, on the kanban)
```
┌──────────────────────────────────────┐
│ Jane Patient              ⋮          │  ← kebab menu
│ Dutch Complete · TRK 1Z9X8...        │
│ ●●●○○○○○○   3 / 9                    │
│ Updated 2h ago                       │
└──────────────────────────────────────┘
```
- **Click anywhere on the card** → opens the **detail modal** (see below). Not an inline expand. The modal is the single canonical surface for everything beyond the card summary.
- **Kebab menu (⋮)**:
  - `Move to ▸` submenu listing all six columns.
  - `Open detail`
  - `Archive`
- **Drag-and-drop** to a different column triggers the column-jump confirmation. Implemented with `@dnd-kit/core` + `@dnd-kit/sortable`.
- **Both move methods** (drag, kebab > Move to) route through the **same column-jump confirmation** so we never silently send emails on a drag.

## Detail modal (also rendered as `/labs/[id]` page — same component, two surfaces)

```
┌─────────────────────────────────────────────────────────────┐
│  Jane Patient                                  [Edit] [×]   │
├─────────────────────────────────────────────────────────────┤
│  PATIENT                                                    │
│   Email      jane@example.com                               │
│   Phone      (305) 555-0142                                 │
│   DOB        1988-04-12  (age 38)                           │
│   Address    123 Brickell Ave, Miami FL                     │
│                                                             │
│  CASE                                                       │
│   Lab        Dutch  ·  Complete                             │
│   Tracking   1Z9X8...                                       │
│   Partial?   Yes (steps 2 and 3 active)                     │
│   Auto-send  On                                             │
│   Notes      "patient mentioned cycle irregularity"         │
├─────────────────────────────────────────────────────────────┤
│  PROCESS                                                    │
│  ┌──────┬──────┬───────┬──────┬──────┬──────┐               │
│  │ ✓ Snt│ ✓ Prt│ ◉ Cmp │ ☐ Sch│ ☐ Don│ ☐ Cls│  ← current col   │
│  └──────┴──────┴───────┴──────┴──────┴──────┘               │
│                                                             │
│  STEPS                                                      │
│   ☑ 1. Sample sent to lab                                   │
│       Email 1 sent · 2026-05-04 14:02 · msg_a1b2            │
│   ☐ 2. Partial results received           (skip)            │
│   ☐ 3. Partial uploaded → Email 2         [Send email →]    │
│   ☑ 4. Complete results received                            │
│   ☐ 5. Complete uploaded → Email 3        [Send email →]    │
│   ☐ 6. Patient scheduled in Zenoti        ➕ add note        │
│   ☐ 7. ROF confirmed → Email 4            [Send email →]    │
│   ☐ 8. Patient emailed protocol                             │
│   ☐ 9. Salesperson follow-up                                │
├─────────────────────────────────────────────────────────────┤
│  ACTIVITY  (chronological, newest first)                    │
│   2026-05-04 14:02  admin  Email 1 sent (msg_a1b2)          │
│   2026-05-04 14:02  admin  Step 1 marked complete           │
│   2026-05-04 14:01  admin  Tracking number added            │
│   2026-05-04 14:01  admin  Case created                     │
├─────────────────────────────────────────────────────────────┤
│  [Archive case]                       [Open in full page →] │
└─────────────────────────────────────────────────────────────┘
```

- Modal max-width = 3xl, scrolls internally.
- "Open in full page" navigates to `/labs/[id]`.
- `[Edit]` opens the create/edit form pre-filled.
- Each completed step renders timestamp + actor inline.
- Failed email sends show in red on the step row with `[Retry]`.

## Email confirmation — THE most important UX guarantee

**No patient email ever fires without an explicit per-send confirmation.**
"Auto-send" means "auto-prompt", not "auto-send".

### Trigger paths (all route through the same dialog)
1. User ticks step 1, 3, 5, or 7 in the detail modal.
2. User drags a card past a column boundary that crosses one of those steps.
3. User picks "Move to" from the kebab menu and the destination column requires crossing those steps.
4. User clicks `[Send email →]` on an already-complete step whose email hasn't been sent (case had auto-send off at the time, or a previous send failed).

### Single-email confirmation dialog
```
┌─────────────────────────────────────────────────────────┐
│  Send Email 1 to Jane Patient?                     [×] │
├─────────────────────────────────────────────────────────┤
│  To:          jane@example.com                          │
│  From:        Centner <alert@centner.com>               │
│  Reply-To:    alert@centner.com                         │
│  Subject:     Your sample is on its way to the lab      │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  [rendered email preview — sandboxed iframe]     │   │
│  │                                                  │   │
│  │  Hi Jane,                                        │   │
│  │  Your sample has been sent to Dutch.             │   │
│  │  Tracking: 1Z9X8...                              │   │
│  │  Most results return within 2 to 3 weeks…        │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│      [Cancel]  [Send and mark step complete]           │
│      Mark step complete without sending →               │
├─────────────────────────────────────────────────────────┤
│  ⚠ Once sent this email cannot be unsent.               │
│  Idempotency lock prevents accidental duplicates.       │
└─────────────────────────────────────────────────────────┘
```

- **`[Cancel]`** — checkbox / drag snaps back, no event recorded, no email sent.
- **`[Send and mark step complete]`** — calls `sendPatientEmail`. On success: records `step_toggled` + `email_sent` events. On failure: records `email_failed`, step stays unchecked, error visible on the step row.
- **"Mark step complete without sending"** (small inline link) — records `step_toggled` + `email_skipped`. Useful when the email was sent manually outside the system or the patient asked not to be emailed.
- **Preview = actual render.** The dialog calls a server endpoint that runs the *exact same template renderer* the send action will use. No drift between preview and sent content.

### Test-mode banner
When `EMAIL_TEST_REDIRECT` is set in the env, the dialog shows a yellow banner:
> **Test mode** — sending to `you@dev.com`. Subject will be prefixed with `[TEST → jane@example.com]`. Real patient will not receive anything.

## Column-jump confirmation (drag / Move to)

When a card move crosses one or more email-step boundaries:

```
┌──────────────────────────────────────────────────┐
│  Move Jane Patient to "ROF Done"?                │
│                                                  │
│  This will mark steps 5, 6, and 7 complete.     │
│   • Step 5 sends Email 3 (results ready).        │
│   • Step 7 sends Email 4 (post-ROF follow-up).   │
│                                                  │
│   [Cancel]                                       │
│   [Review and send 2 emails →]                   │
│   [Move without sending emails]                  │
└──────────────────────────────────────────────────┘
```

- `[Review and send 2 emails →]` walks through each per-email confirmation in order. Cancelling any one cancels the whole move (the card snaps back) — partial success is too dangerous.
- `[Move without sending emails]` advances the steps and logs `email_skipped` for each crossed email-step.
- `[Cancel]` aborts; card snaps back.

## Create / edit form (modal)

Fields:
- Patient name (required)
- Patient email (required, validated)
- Patient phone (optional, free format)
- Patient DOB (optional, date picker)
- Patient address (optional, single textarea)
- Lab name (autocomplete from existing distinct values; allow new)
- Lab panel (optional free text — e.g. "Complete", "Adrenal")
- Tracking number (optional)
- Partial results expected? (checkbox, default off)
- Auto-send patient emails? (checkbox, default on — but every send still confirms)
- Notes (textarea, optional)

## Visual notes
- Utilitarian. No animations beyond a 100ms fade.
- Tailwind defaults; shadcn/ui primitives where useful (Dialog, Button, Input, Checkbox).
- Email preview iframe is `sandbox=""` so the email's CSS can't bleed into the app shell.
- Inline `confirm()` for destructive actions (archive, retry-after-failure). No toast library in v1.
