# Phase 5 - Private messages

Part of [`phased-plan.md`](phased-plan.md). Source plan: [`plan.md`](plan.md).
Implemented in **`mancej/rsvp`**. Depends on **Phase 1**.

## Outcome

A guest can write to the host privately, and the host can answer. One thread per guest, visible to
nobody else. The unread badge Phase 1 already wired starts showing real numbers.

## Entry criteria

Phase 1 merged. `messages` exists and is empty, and the guest nav badge and host tab counts already
read it.

## Scope

- `app/messages/page.tsx` - replaces the Phase 1 placeholder.
- `app/host/messages/page.tsx` - replaces the Phase 1 placeholder.
- Send, read-state, and polling.
- Playwright specs.

### Non-goals

Guest-to-guest messaging. Attachments. Email or push notification of any kind - the plan explicitly
rejected an email provider. Do not touch `lib/nav.ts` or `lib/host-tabs.ts`; the badge is already
wired.

## Inherited contracts

From Phase 1: `requireGuest()` and `requireHost()`, `lib/supabase.ts`, the theme tokens, the
middleware gate covering `/messages`, and the unread badge already reading the `messages` table.

## Implementation steps

1. **`/messages`.** The current guest's thread, oldest first, as the mockup's bubbles: the host on
   the left, the guest on the right. Sending inserts a row with `from_host = false`. Reading the
   page stamps `read_by_guest_at` on the host's unread rows.
2. **Scoping is the whole feature.** Every query filters by the `guest_id` from `requireGuest()`,
   never by a parameter the browser supplies. A guest must not be able to name another guest's
   thread. Test this directly rather than assuming it.
3. **Host Messages tab.** Every thread, ordered by most recent activity, each showing the guest's
   name and an unread count. Opening one shows it and stamps `read_by_host_at`. Replying inserts a
   row with `from_host = true`.
4. **Polling.** Refresh roughly every 10 seconds while the tab is visible, and stop when it is not.
   Realtime is unavailable by the Phase 1 contract.
5. **Empty state.** A guest with no messages sees an invitation to write the first one, in the
   theme's voice.

## Data and compatibility

No schema change. The read stamps and `from_host` already exist from Phase 1.

## Tests and verification

Playwright:

1. A guest sends a message; the host sees it in `/host` with an unread count.
2. The host replies; the guest sees it, and the guest's unread badge clears once read.
3. **A second guest's thread is not visible to the first**, including by manipulating any request
   the browser can make.
4. Read stamps are set on view, for both sides.
5. `/messages` redirects to `/gate` without `party_session`; the host tab needs the host claim.

Commands: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npx playwright test`.

## Merge and exit criteria

CI green; a message round-trips between a guest session and a host session on the Vercel preview;
cross-guest isolation is proven by a test rather than by inspection.

## Downstream handoff

No later phase depends on this one. It owns every `messages` row. Phase 6's guest merge reassigns
`messages.guest_id`, so nothing here may assume that column is immutable or cache a display name
alongside a message.

## Cross-phase audit record

- Checked against Phase 1: the unread badge lives in Phase 1's navigation registry, which this phase
  must not edit. Confirmed the badge works by counting rows, so inserting rows here lights it up
  with no registry change.
- Checked against Phase 6: `messages.guest_id` is reassignable by the merge tool; this phase reads
  guest names through the relation rather than copying them.
- Confirmed no file overlap with phases 2, 3 or 4.
