# Phase 6 - Host console: content, party and guests

Part of [`phased-plan.md`](phased-plan.md). Source plan: [`plan.md`](plan.md).
Implemented in **`mancej/rsvp`**. Depends on **Phase 1** and **Phase 2**.

## Outcome

Every word on the site becomes editable, and the RSVP list becomes usable. The host changes the
invitation copy, the date, the venue and the parking address from a form; sees who is coming, with
totals and a CSV export; and joins two guest rows when someone clears their browser and comes back
as a stranger.

After this merges, nothing a guest reads is hardcoded in the repository, and no change to what the
site says needs a developer or a deploy.

## Entry criteria

Phase 1 merged, so `content_blocks` and `party` exist with seeds, `guests.merged_into` exists, the
`merge_guests()` function is deployed, and `requireGuest()` already resolves merged identities.
Phase 2 merged, so there are RSVPs to list and an invitation whose copy this phase edits.

Phases 3, 4 and 5 may still be in flight. This phase shares no file with any of them.

## Scope

- `app/host/content/page.tsx` - replaces the Phase 1 placeholder.
- `app/host/party/page.tsx` - replaces the Phase 1 placeholder.
- `app/host/rsvps/page.tsx` - replaces the Phase 1 placeholder.
- The guest merge tool and its route, over Phase 1's `merge_guests()` RPC.
- CSV export.
- Playwright specs.

### Non-goals

The Posts, Album and Messages tabs, which phases 4, 3 and 5 own. Rich-text editing - the editor is a
textarea over markdown. Do not touch `lib/nav.ts` or `lib/host-tabs.ts`.

## Inherited contracts

From Phase 1: `requireHost()`, `lib/supabase.ts`, **`lib/markdown.ts`** for the preview, the theme
tokens, the host tab shell, **`merge_guests(p_survivor, p_loser)`**, and a `requireGuest()` that
already follows `merged_into`. Those last two matter more than they look: this phase builds the
tool, not the transaction and not the cookie handling, and it must not re-implement either.

From Phase 2: one `rsvps` row per guest keyed by `guest_id`, and an invitation that reads every
string from `party` and `content_blocks` - so an edit here changes the guest-facing page with
nothing else to do.

## Implementation steps

1. **Content tab.** List every `content_blocks` row by its human `label`, not its `key`, so the tab
   reads as a list of places on the site. Each is a textarea over `body_md` with a live preview
   rendered through `lib/markdown.ts` - the same renderer the guest page uses, so the preview cannot
   lie. Save per block and stamp `updated_at`.
2. **Party tab.** Date and time, venue name and address, parking address and note, and the
   `show_guest_list` toggle. Changing `parking_addr` must change the invitation's map link, because
   Phase 2 derives the href at render time - assert that rather than trusting it.
3. **RSVPs tab.** Every guest with their answer, party size and note. Totals for attending, not
   attending and not yet answered, plus a head count that sums `party_size`. A CSV export carrying
   the same columns.
4. **Guest merge.** Pick two guest rows, choose which survives, confirm, and **call
   `supabase.rpc('merge_guests', { p_survivor, p_loser })`**. That is the whole write. Do not move
   `rsvps`, `comments` or `messages` from TypeScript.

   The function ships with Phase 1's migration and is quoted in full in `plan.md`. It exists because
   a merge is four related writes plus the `merged_into` stamp, and the Supabase REST client gives
   you five independent HTTP calls, not one transaction - so a failure partway through splits one
   person across two identities, which is the exact condition the tool was built to fix. A plpgsql
   body is one transaction, and it locks both rows so two hosts merging at once serialise.

   What this phase owns is everything around that call:
   - **Show the collision before it happens.** `rsvps` is keyed by `guest_id`, so two answers cannot
     both move; the function keeps the survivor's and drops the loser's. The host sees which answer
     wins, and which is discarded, in the confirmation - the rule is decided in the database, and
     disclosed in the UI.
   - **Surface the function's refusals.** It raises on a self-merge and on an already-merged guest.
     Turn those into a readable message rather than a stack trace.
   - **The loser's row is kept**, with `merged_into` set - do not add a delete. Deleting would
     cascade exactly the rows the merge just moved, and keeping it makes a bad merge reversible.
   - **Exclude merged rows** from the RSVP list, the counts and the guest count on the invitation.

   Nothing here has to invalidate the losing browser's cookie, and nothing here can: that cookie is
   `HttpOnly` on someone else's machine. Phase 1's `requireGuest()` resolves `merged_into` on every
   request and re-mints, so the merged guest's next comment lands on the survivor on its own. Verify
   that rather than assuming it.
5. **Confirm destructive actions.** Merging is the one irreversible-looking action in the console.
   Name both guests and the consequence in the confirmation.

## Data and compatibility

No schema change: `merged_into`, the `guests_no_self_merge` check and `merge_guests()` all arrived
in Phase 1. That is why this phase can declare no migration and still get a transaction - the
transaction is schema, and it was shipped with the schema. Excluding merged rows is a query-level
concern; if a partial index helps, add a new migration file rather than editing Phase 1's.

Because phases 3, 4 and 5 may merge after this one, `merge_guests()` moves `comments` and
`messages` rows **whether or not** those features' UIs exist yet. It is written against the tables,
which have existed since Phase 1, rather than against the features - so this phase's merge tool is
correct before, during and after those three land, and needs no revisit when they do.

## Tests and verification

Playwright:

1. Editing a content block changes what a guest reads on `/`, with no redeploy.
2. The Content tab preview and the guest page render the same markdown the same way.
3. Editing `parking_addr` changes the invitation's map `href`.
4. The RSVP totals match the seeded rows, and the CSV carries the same columns.
5. Merging two guests moves the RSVP, the comments and the messages onto the survivor, leaves the
   totals correct, and hides the merged row from the list.
6. The merged loser row still exists with `merged_into` set.
7. **The merged browser keeps working, on the survivor.** Drive two browser contexts to two guest
   identities, merge them, then have the losing context post a comment and edit its RSVP. Both land
   on the survivor, the head count does not move, and the hidden row stays hidden. This is the
   regression that the cookie makes easy to miss, because the losing context never sees an error.
8. A merge that collides on `rsvps` keeps the survivor's answer, and the confirmation named that
   answer before the host clicked.
9. Self-merge and already-merged are both refused with a readable message rather than a stack
   trace.
10. Every tab is unreachable without the host claim.

Commands: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npx playwright test`.

## Merge and exit criteria

CI green; a copy edit made in `/host` is visible to a guest on the Vercel preview without a deploy;
a merge moves every related row in one call and leaves the head count right; the losing browser's
next write lands on the survivor; no Phase 1 placeholder remains in this phase's three routes.

## Downstream handoff

Last phase. After it merges the site matches `plan.md` and no cleanup phase is required, because
each of phases 2 to 6 replaced the placeholder it inherited.

## Cross-phase audit record

- Checked against Phase 1: consumes `requireHost()`, `lib/markdown.ts` and `merged_into`; replaces
  only its own three page files; edits neither registry.
- Checked against Phase 2: relies on the derived map href and on one RSVP row per guest. Confirmed
  Phase 2's handoff states both.
- Checked against phases 4 and 5: both were amended to avoid caching a guest's display name
  alongside a comment or message, because this phase reassigns `guest_id`.
- The `rsvps` primary-key collision on merge was found while writing this file. It is not addressed
  anywhere else, so it is resolved here with an explicit rule and a visible choice for the host,
  rather than left to the implementing agent to discover. After review the rule moved **into**
  `merge_guests()`, so the database enforces it and this phase only discloses it.
- Two contradictions were found in this phase after review and both were resolved by moving work
  into Phase 1, not by patching around them here:
  - it required "one transaction" while inheriting only a REST client and declaring no schema
    change, which is not a combination that can produce one. `merge_guests()` now ships with the
    Phase 1 migration and this phase calls it.
  - it hid the merged row from its own lists but left the losing browser holding a valid cookie
    naming that row, so the next comment from that browser would revive it. Resolution now happens
    in `requireGuest()`, which is the only code that reads the cookie and the only place that fixes
    it for phases 3, 4 and 5 as well.
- Dependency on Phase 2 confirmed necessary: the RSVP tab and the merge tool both need real RSVP
  rows, which only Phase 2 can produce.
