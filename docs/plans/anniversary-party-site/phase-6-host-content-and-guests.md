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

Phase 1 merged, so `content_blocks` and `party` exist with seeds and `guests.merged_into` exists.
Phase 2 merged, so there are RSVPs to list and an invitation whose copy this phase edits.

Phases 3, 4 and 5 may still be in flight. This phase shares no file with any of them.

## Scope

- `app/host/content/page.tsx` - replaces the Phase 1 placeholder.
- `app/host/party/page.tsx` - replaces the Phase 1 placeholder.
- `app/host/rsvps/page.tsx` - replaces the Phase 1 placeholder.
- The guest merge tool and its route.
- CSV export.
- Playwright specs.

### Non-goals

The Posts, Album and Messages tabs, which phases 4, 3 and 5 own. Rich-text editing - the editor is a
textarea over markdown. Do not touch `lib/nav.ts` or `lib/host-tabs.ts`.

## Inherited contracts

From Phase 1: `requireHost()`, `lib/supabase.ts`, **`lib/markdown.ts`** for the preview, the theme
tokens, and the host tab shell. From Phase 2: one `rsvps` row per guest keyed by `guest_id`, and an
invitation that reads every string from `party` and `content_blocks` - so an edit here changes the
guest-facing page with nothing else to do.

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
4. **Guest merge.** Pick two guest rows, choose which survives, and move the loser's `rsvps`,
   `comments` and `messages` onto the survivor. Then set the loser's `merged_into` to the survivor's
   id and **keep the row** - do not delete it. Deleting would cascade exactly the rows just moved if
   anything went wrong mid-way, and keeping it makes a bad merge reversible.
   - Run the whole move in one transaction.
   - `rsvps` is keyed by `guest_id`, so two RSVPs cannot simply both move. Decide explicitly: keep
     the survivor's if it exists, otherwise adopt the loser's. Show the host which one will win
     before they confirm.
   - Exclude merged rows from the RSVP list, the counts and the guest count on the invitation.
5. **Confirm destructive actions.** Merging is the one irreversible-looking action in the console.
   Name both guests and the consequence in the confirmation.

## Data and compatibility

No schema change; `merged_into` arrived in Phase 1. Excluding merged rows is a query-level concern -
if a partial index helps, add a new migration file rather than editing Phase 1's.

Because phases 3, 4 and 5 may merge after this one, the merge routine must move `comments` and
`messages` rows **whether or not** those features' UIs exist yet. The tables are present from Phase
1, so write against the tables, not against the features.

## Tests and verification

Playwright:

1. Editing a content block changes what a guest reads on `/`, with no redeploy.
2. The Content tab preview and the guest page render the same markdown the same way.
3. Editing `parking_addr` changes the invitation's map `href`.
4. The RSVP totals match the seeded rows, and the CSV carries the same columns.
5. Merging two guests moves the RSVP, the comments and the messages onto the survivor, leaves the
   totals correct, and hides the merged row from the list.
6. The merged loser row still exists with `merged_into` set.
7. Every tab is unreachable without the host claim.

Commands: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npx playwright test`.

## Merge and exit criteria

CI green; a copy edit made in `/host` is visible to a guest on the Vercel preview without a deploy;
a merge moves every related row and leaves the head count right; no Phase 1 placeholder remains in
this phase's three routes.

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
  rather than left to the implementing agent to discover.
- Dependency on Phase 2 confirmed necessary: the RSVP tab and the merge tool both need real RSVP
  rows, which only Phase 2 can produce.
