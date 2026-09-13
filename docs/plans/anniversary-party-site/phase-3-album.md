# Phase 3 - The wedding album

Part of [`phased-plan.md`](phased-plan.md). Source plan: [`plan.md`](plan.md).
Implemented in **`mancej/rsvp`**. Depends on **Phase 1**.

## Outcome

Guests can look at the wedding photographs, and the host can add them without a deploy. The images
live in a private Supabase Storage bucket and reach the browser only through short-lived signed URLs
minted on the server, so the album is genuinely behind the party password rather than behind an
unguessable path.

## Entry criteria

Phase 1 merged. The `photos` table exists and is empty.

## Scope

- A migration creating the private `album` bucket.
- `app/album/page.tsx` - replaces the Phase 1 placeholder.
- `app/host/album/page.tsx` - replaces the Phase 1 placeholder.
- Server-side signed-URL minting.
- Upload, caption, reorder and delete for the host.
- An orphaned-object sweep in the host tab.
- Playwright specs.

### Non-goals

Guest uploads. Image editing or cropping. Do not touch `lib/nav.ts` or `lib/host-tabs.ts`.

## Inherited contracts

From Phase 1: `lib/supabase.ts` as the only Supabase client, `requireGuest()` and `requireHost()`,
the theme tokens, the slim ridge component, and the middleware gate covering `/album`.

## Implementation steps

1. **Create the bucket in a migration**, not by hand in the dashboard, so it ships through the same
   Supabase GitHub integration as everything else and a fresh project can be rebuilt from the
   repository. It is private; no public policy.
2. **Signed URLs are minted server-side** in the page's server component or a route handler, with a
   short expiry - an hour is ample and keeps a copied URL from outliving the session that produced
   it. The browser never receives a Supabase key, per the Phase 1 contract.
3. **`/album`.** The responsive grid from the mockup, ordered by `photos.sort_order`. Tap to open
   full size. Captions render beneath when present. Use Next's image component against the signed
   URLs; configure the remote pattern for the Supabase host.
4. **Host Album tab.** Upload one or many files, each writing to the bucket and inserting a `photos`
   row. Edit a caption. Reorder by changing `sort_order`. Delete, which must remove both the row and
   the object.

   **Storage and Postgres cannot share a transaction, so pick the order deliberately.** Either step
   can fail on its own, and the two failure shapes are not equally bad: an object with no row is
   invisible to every page and costs a few megabytes, while a row with no object is a broken image
   in the middle of the wedding album. So the rule is **the `photos` row is the album, and the
   object is only its payload**:

   - **Upload:** object first, row second. If the insert fails, delete the object you just wrote.
     If that compensating delete also fails, stop and log - you are left with an orphan, which is
     the tolerable end of the failure space, not a broken album.
   - **Delete:** row first, object second. If the object delete fails, the tile is already gone from
     the album and an orphan remains.
   - Never the other order in either direction. It is the only way to produce the one outcome
     neither of these can.
5. **Sweep the orphans.** A host-only action lists objects in the `album` bucket with no matching
   `photos.storage_path` and deletes them, showing the count first. This is the compensation path's
   backstop, and it is bounded work - around forty photographs, not a paginated crawl.
6. **Guard the upload** with a size and MIME allowlist. The 1 GB free bucket is generous for around
   forty resized photographs, and it is not generous for a phone's original camera roll. Reject
   oversized files with a message that says what to do.
7. **Empty state.** Before any photograph exists, `/album` says so in the theme's voice rather than
   rendering an empty grid.

## Data and compatibility

No change to `photos`. The bucket migration is additive and safe to re-run.

The consistency rule above is a code contract rather than a schema one - there is nothing Postgres
can enforce about an object it cannot see. `photos.storage_path` is already `unique`, so a retried
upload cannot produce two rows pointing at one object.

## Tests and verification

Playwright:

1. With photographs seeded, `/album` renders one tile per row in `sort_order`, and each `src` is a
   signed URL rather than a public object path.
2. Opening a tile shows it full size.
3. The host uploads a file and it appears for a guest.
4. The host deletes a photograph and both the row and the object are gone.
5. **Failure injection, both directions.** Stub the Supabase client so the second half of each
   operation throws after the first half succeeded, then assert the album is still coherent: an
   upload whose insert fails leaves no tile and no object (the compensating delete ran); a delete
   whose object removal fails leaves no tile either, and the sweep then finds and removes the
   orphan. A test that only exercises the happy path cannot see the bug this ordering exists to
   prevent.
6. `/album` redirects to `/gate` without `party_session`; the host tab is unreachable without the
   host claim.
7. An oversized upload is rejected with a message.

These run against the local Supabase stack Phase 1's harness starts, which brings up Storage as
well as Postgres. No spec points at the hosted bucket.

Commands: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npx playwright test`.

## Merge and exit criteria

CI green; a photograph uploaded through `/host` is visible on `/album` on the Vercel preview; the
bucket is private and no object is reachable without a signature; neither failure-injection spec
leaves a broken tile.

## Downstream handoff

No later phase depends on this one. It owns the `album` bucket and every `photos` row.

## Cross-phase audit record

- Checked against Phase 1: uses its Supabase client and session helpers; replaces only its own two
  page files; edits neither registry.
- The bucket is created by migration rather than by a dashboard click so that the repository remains
  the single description of the project's state, consistent with Phase 1 putting the whole schema in
  `supabase/migrations/`.
- The storage/database ordering rule was added after review. The phase originally said a delete
  must remove "both" the row and the object without saying in which order, and said nothing about a
  half-completed upload - which leaves the implementing agent to pick, and half the picks render a
  broken album.
- Confirmed no file overlap with phases 2, 4 or 5.
