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
   row. Edit a caption. Reorder by changing `sort_order`. Delete, which must remove **both** the row
   and the object - a row without an object renders a broken tile and an object without a row is
   invisible and still bills storage.
5. **Guard the upload** with a size and MIME allowlist. The 1 GB free bucket is generous for around
   forty resized photographs, and it is not generous for a phone's original camera roll. Reject
   oversized files with a message that says what to do.
6. **Empty state.** Before any photograph exists, `/album` says so in the theme's voice rather than
   rendering an empty grid.

## Data and compatibility

No change to `photos`. The bucket migration is additive and safe to re-run.

## Tests and verification

Playwright:

1. With photographs seeded, `/album` renders one tile per row in `sort_order`, and each `src` is a
   signed URL rather than a public object path.
2. Opening a tile shows it full size.
3. The host uploads a file and it appears for a guest.
4. The host deletes a photograph and both the row and the object are gone.
5. `/album` redirects to `/gate` without `party_session`; the host tab is unreachable without the
   host claim.
6. An oversized upload is rejected with a message.

Commands: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npx playwright test`.

## Merge and exit criteria

CI green; a photograph uploaded through `/host` is visible on `/album` on the Vercel preview; the
bucket is private and no object is reachable without a signature.

## Downstream handoff

No later phase depends on this one. It owns the `album` bucket and every `photos` row.

## Cross-phase audit record

- Checked against Phase 1: uses its Supabase client and session helpers; replaces only its own two
  page files; edits neither registry.
- The bucket is created by migration rather than by a dashboard click so that the repository remains
  the single description of the project's state, consistent with Phase 1 putting the whole schema in
  `supabase/migrations/`.
- Confirmed no file overlap with phases 2, 4 or 5.
