# Phase 2 - Invitation, RSVP and getting there

Part of [`phased-plan.md`](phased-plan.md). Source plan: [`plan.md`](plan.md).
Implemented in **`mancej/rsvp`**. Depends on **Phase 1**.

## Outcome

The invitation works. A guest who is through the gate sees the date, the Capital Club, a
**Getting there** block that takes them to the Sears Alley garage in their maps app, and a form that
records whether they are coming and how many they are bringing. Re-opening the page shows their
answer and lets them change it.

This is the only phase with a calendar deadline behind it: once it merges, invitations can go out.

## Entry criteria

Phase 1 merged. Its contracts are in `AGENTS.md`. The seeded `party` row and `content_blocks` rows
already hold real copy, so this phase reads them rather than waiting for Phase 6's editors.

**One input this phase cannot ship without: the real party start time.** The mockups show 6pm as a
placeholder. If it is still unknown, ask before building the invitation rather than shipping a guess
a guest will act on.

## Scope

- `app/page.tsx` - replaces the Phase 1 placeholder.
- The Getting there block and its map link.
- `app/api/rsvp/route.ts` - create and update, keyed by guest.
- The running count of who is coming, honouring `party.show_guest_list`.
- Playwright specs for the above.

### Non-goals

Editing any of this from `/host` - that is Phase 6, which depends on this phase. The album, updates
and messages. Do not touch `lib/nav.ts` or `lib/host-tabs.ts`.

## Inherited contracts

From Phase 1: `lib/session.ts` (`requireGuest()`), `lib/supabase.ts`, `lib/markdown.ts` for any
`content_blocks` body, `lib/theme.css` tokens, `components/Ridge.tsx`, and the middleware gate that
already covers `/`.

## Implementation steps

1. **Read the invitation's content** from the seeded `party` row and the `home.*` `content_blocks`
   keys. Render prose through `lib/markdown.ts`. Nothing on this page is a string literal in the
   repository - that is the whole point of the content model.
2. **Lay the page out as the mockup does**: full ridge, eyebrow with the date, the display heading,
   the lede, the Getting there block, a rule, the running count, then the form. Match
   `mockups/b-blue-hour.html` panel 2.
3. **Getting there.** Lead with the parking address, because that is where a guest drives; name the
   Capital Club beneath it as where they walk to. Render `party.parking_addr` as selectable text
   *and* as the link target. Build the href as the Google Maps universal URL,
   `https://www.google.com/maps/search/?api=1&query=<url-encoded party.parking_addr>` - **derived,
   never stored**, so it cannot drift from the address printed above it. It is the only outbound
   link on the site: give it `rel="noopener noreferrer"`, and confirm Phase 1's
   `Referrer-Policy: no-referrer` covers it.
4. **The RSVP form.** Name (pre-filled from the guest row), attending yes/no, party size, and a free
   note. Validate with Zod on the route. Upsert into `rsvps` keyed by `guest_id` so a second
   submission updates rather than duplicates.
5. **The running count.** Sum `party_size` across attending RSVPs. Show it only when
   `party.show_guest_list` is true. Do not list names in this phase - the plan allows first names,
   but a count is what the mockup shows and it is the smaller surface.
6. **Return visits.** A guest who already answered sees their answer in the form, with the submit
   control reading as an update rather than a first send.

## Data and compatibility

No schema change. `rsvps` and `party` already exist with seeds. If an index turns out to be missing
for the count query, add it as a new migration file - never edit Phase 1's.

## Tests and verification

Playwright:

1. A gated guest reaches `/` and sees the date, the venue and the parking address.
2. Submitting the form creates exactly one `rsvps` row; submitting again updates it rather than
   creating a second.
3. The map link's `href` contains the url-encoded `party.parking_addr` currently in the database,
   and the anchor carries `rel="noopener noreferrer"`.
4. The count reflects the sum of party sizes, and disappears when `show_guest_list` is false.
5. `/` still redirects to `/gate` without `party_session`.
6. The document still ships no `og:image` and no occasion-naming metadata.

Commands: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npx playwright test`.

## Merge and exit criteria

CI green; the invitation renders the seeded copy on the Vercel preview; an RSVP round-trips; the map
link opens the Sears Alley garage on a phone.

## Downstream handoff

Phase 6 edits the rows this phase reads and adds the host RSVP table over the rows it writes. It may
rely on: one `rsvps` row per guest keyed by `guest_id`; the invitation reading every string from
`party` and `content_blocks`; and the map href being derived from `parking_addr` at render time, so
changing that column in the host editor changes the link with no other work.

## Cross-phase audit record

- Checked against Phase 1: consumes `requireGuest()`, `lib/supabase.ts`, `lib/markdown.ts` and the
  theme tokens; replaces only `app/page.tsx`; edits neither registry. No contract altered.
- The guest-list display was reduced from "first names" to a count, matching the approved mockup.
  Phase 6 can widen it later from the `show_guest_list` toggle without a schema change.
- Confirmed no file overlap with phases 3, 4 or 5, so all four merge in any order.
