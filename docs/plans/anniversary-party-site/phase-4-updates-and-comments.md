# Phase 4 - Updates and comments

Part of [`phased-plan.md`](phased-plan.md). Source plan: [`plan.md`](plan.md).
Implemented in **`mancej/rsvp`**. Depends on **Phase 1**.

## Outcome

The host can post updates - parking, timing, who is bringing what, how to stay hidden - and guests
can read them and talk underneath. Pinned posts stay on top. Drafts stay invisible until published.

## Entry criteria

Phase 1 merged. `posts` and `comments` exist and are empty. `lib/markdown.ts` is available and
tested.

## Scope

- `app/updates/page.tsx` - replaces the Phase 1 placeholder.
- `app/host/posts/page.tsx` - replaces the Phase 1 placeholder.
- Comment creation with one level of replies, and host moderation.
- Light polling so a comment appears without a manual refresh.
- Playwright specs.

### Non-goals

Guest-authored posts. Reactions. Editing another guest's comment. Do not touch `lib/nav.ts` or
`lib/host-tabs.ts`.

## Inherited contracts

From Phase 1: `requireGuest()` and `requireHost()`, `lib/supabase.ts`, **`lib/markdown.ts` as the
only renderer of host-authored prose**, the theme tokens, and the middleware gate covering
`/updates`.

## Implementation steps

1. **`/updates`.** Published posts, pinned first then newest first. `posts.body_md` renders through
   `lib/markdown.ts` - do not add a second renderer or reach for a markdown library here. A draft
   (`published_at is null`) never reaches a guest.
2. **Comments.** Beneath each post, ordered oldest first, authored as the current guest. One level
   of replies via `comments.parent_id`; a reply to a reply attaches to the same parent rather than
   nesting further. A comment with `guest_id is null` renders as the host and is styled as the
   mockup shows.
3. **Soft delete.** Host moderation sets `deleted_at` and the row renders as removed rather than
   vanishing, so a thread keeps its shape. Guests cannot delete anything, including their own - keep
   the surface small.
4. **Host Posts tab.** Compose, edit, pin, save as draft, publish, delete. Deleting a post cascades
   its comments, which the Phase 1 schema already declares.
5. **Polling.** Refresh the comment list roughly every 10 seconds while the tab is visible, and stop
   when it is not. Phase 1's server-only key rules out Supabase Realtime in the browser, and this is
   the substitute the plan chose.
6. **Empty state.** Before any post exists, `/updates` says so rather than rendering nothing.

## Data and compatibility

No schema change. If the comment query wants an index beyond Phase 1's
`comments (post_id, created_at)`, add a new migration file rather than editing Phase 1's.

## Tests and verification

Playwright:

1. A published post appears on `/updates`; a draft does not.
2. A pinned post sorts above a newer unpinned one.
3. A guest comments and a second guest sees it.
4. A reply attaches under its parent, and a reply to a reply attaches to the same parent.
5. A host-deleted comment renders as removed and its replies survive.
6. Deleting a post removes its comments.
7. `/updates` redirects to `/gate` without `party_session`; the host tab needs the host claim.

Unit: markdown input containing raw HTML renders escaped - re-assert here because this is the phase
that first puts host-authored prose in front of a guest.

Commands: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npx playwright test`.

## Merge and exit criteria

CI green; a post written in `/host` is readable and commentable on the Vercel preview; a draft stays
invisible.

## Downstream handoff

No later phase depends on this one. It owns every `posts` and `comments` row. Phase 6's guest merge
reassigns `comments.guest_id`, which this phase must not assume is immutable.

## Cross-phase audit record

- Checked against Phase 1: consumes `lib/markdown.ts` rather than introducing a renderer, which is
  why that module was pulled into Phase 1.
- Checked against Phase 6: `comments.guest_id` can be reassigned by the merge tool, so nothing here
  caches a guest's display name alongside a comment - it is read through the relation.
- Confirmed no file overlap with phases 2, 3 or 5.
