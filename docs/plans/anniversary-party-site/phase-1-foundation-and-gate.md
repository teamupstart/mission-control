# Phase 1 - Foundation and the gate

Part of [`phased-plan.md`](phased-plan.md). Source plan: [`plan.md`](plan.md).
Implemented in **`mancej/rsvp`**.

## Outcome

A deployed, password-gated site at a Vercel URL. A person with the link enters the party password,
gives a first name, and lands on a themed shell with working navigation. Nothing in a link preview
names the occasion. The database holds the complete schema with seeded copy, and every shared
contract phases 2 to 6 depend on exists and is tested.

This phase is large on purpose: the schema, the session, the identity, the theme, the shell and the
deploy pipeline are mutually dependent, and any subset merged alone is a repository that does not
run.

## Entry criteria

No phase dependencies. Four **human** prerequisites, which the agent must confirm before starting
rather than work around:

1. A **new Supabase organization on the Free plan** exists, with one project in it. The Supabase MCP
   has no `create_organization`, so this is a dashboard action.
2. The project URL and **service role** key are available to the agent.
3. The **Supabase GitHub integration** is enabled for `mancej/rsvp` in that project's dashboard.
4. The party password and the host password are chosen.

If any is missing, stop and ask. Do not fall back to the existing `Claim Your Court` organization -
it is on Pro and a project there costs roughly $10/month, which the plan explicitly rejected.

## Scope

- `create-next-app` scaffold: TypeScript, App Router, Tailwind, ESLint.
- `AGENTS.md` stating the cross-phase contracts (see the handoff below).
- Theme tokens from direction B, and the ridge SVG components.
- App shell: root layout, guest navigation, host tab shell.
- Complete schema migration plus seed data.
- `lib/supabase.ts`, `lib/session.ts`, `lib/markdown.ts`, `lib/theme.css`, `lib/nav.ts`,
  `lib/host-tabs.ts`.
- Edge middleware, `/gate`, the name-capture step, `/host` authentication.
- Gate rate limiting on `gate_attempts`, with bounded retention.
- Surprise-protection metadata, headers and `robots.txt`.
- `GET /api/keepalive` and the Vercel Cron declaration.
- GitHub Actions workflow, Vercel project link, environment variables.
- Playwright harness **against a local Supabase stack**, its localhost guard, and the phase's specs.

### Non-goals

The RSVP form, the album, updates, comments, messages, and the host Content/Party/RSVP editors.
Phase 1 creates placeholder pages for those routes and nothing more. Do not build ahead.

## Repository findings

`mancej/rsvp` was created during planning and contains `README.md` and nothing else - no
`package.json`, no framework, no CI, no `AGENTS.md`. There is no existing code to reconcile against,
so every convention in this phase is being established rather than followed. That is why the
`AGENTS.md` deliverable is not documentation housekeeping: phases 2 to 6 arrive as separate agents,
only the primary repository's instructions load automatically, and without that file each of them
re-derives the server-only-key rule and the token file differently.

## Implementation steps

1. **Scaffold.** `create-next-app` with TypeScript, App Router, Tailwind, ESLint. Add
   `@supabase/supabase-js`, `jose`, `zod`, `@playwright/test`. Pin whatever the scaffold pins; do
   not chase versions.
2. **`AGENTS.md`.** Write the contracts from the handoff section below, in this repository's own
   voice. Keep it short enough that it is read.
3. **`lib/theme.css`.** The direction-B tokens from `plan.md`: page `#0a121a`, panel `#111d27`,
   card `#16242f`, input ground `#0d1922`, ink `#e7eef2`, muted `#8ba1ae`, edge `#24384a`, accent
   `#e0a862` with `#12202b` on top of it, ridges front to back `#172835` / `#203546` / `#2a4259` /
   `#36536e`, sky `#1b3247`, moon `#f0d7a4`. Serif display at weight 300, sans body and controls.
   Wire into Tailwind so no component writes a colour literal.

   **Dark only.** Do not add a `prefers-color-scheme` light variant - Blue hour is the design, not a
   night mode for a light theme that does not exist. Set `color-scheme: dark` so form controls and
   scrollbars match rather than rendering as light chrome on a dark page.

   Keep the ridge layers at roughly even value steps. They sit close together at dusk and compress
   into a single dark mass if tightened; the tokens above are the corrected set.
4. **Ridge components.** `components/Ridge.tsx` (full, 96 units tall, with the sun) and a slim
   variant (30 units, two layers, no sky). Copy the path geometry from
   `mockups/b-blue-hour.html` rather than redrawing it - the curves there are the approved ones,
   and that mockup carries a moon rather than a sun.
5. **Migration.** One file under `supabase/migrations/`, matching the SQL in `plan.md` exactly:
   `guests`, `rsvps`, `posts`, `comments`, `messages`, `party`, `content_blocks`, `photos`,
   `gate_attempts`, their indexes, the `guests_no_self_merge` check, the **`merge_guests()`
   function**, and `alter table ... enable row level security` on every table with **no policies**.
   Then seed: the single `party` row (14 November 2026, The Capital Club, parking
   `6 Sears Alley, Asheville, NC`, note `Covered and included`) and every `content_blocks` key with
   its label and a sensible default body.

   `merge_guests()` ships here even though nothing in this phase calls it. Phase 6 owns the tool;
   the transaction is schema. Splitting them would leave Phase 6 writing a four-call merge against
   a REST client that cannot make those four calls atomic, which is the one failure that tears a
   person's RSVP away from their messages. Put the seed in `supabase/seed.sql` as well as in the
   migration, so the local stack the tests use comes up with the same rows.
6. **`lib/supabase.ts`.** A server-only module exporting one service-role client. Add the
   `server-only` package import so a client-component import fails at build time rather than at
   runtime.
7. **`lib/session.ts`.** `jose` HS256 over `SESSION_SECRET`, with a `kid` claim so rotation
   invalidates every session. Mint and verify `party_session` (with an optional `admin` claim) and
   `party_guest`. Export `requireGuest()` and `requireHost()`. Cookies are `HttpOnly`, `Secure`,
   `SameSite=Lax`, long-lived.

   **`requireGuest()` follows `merged_into`.** It reads the id from the cookie, resolves the chain
   to the row that is not merged, and re-mints `party_guest` at the survivor when the two differ.
   Cap the walk (four hops is generous - `merge_guests()` compresses chains to one) and treat
   exhaustion as a corrupt cookie: clear it and send the visitor back to the name step rather than
   looping. A row whose `merged_into` points at a deleted guest resolves to itself, because the
   foreign key is `on delete set null`.

   This lives here rather than in Phase 6 because phases 3, 4 and 5 each write a `guest_id` and
   none of them will have heard of the merge tool. Without it, the browser that lost a merge keeps
   a valid cookie naming the hidden row and revives it with its next comment.
8. **`lib/password.ts`.** `node:crypto` scrypt hashing and a constant-time compare. Node runtime
   only - Edge has no `timingSafeEqual`. Include a small script that prints a hash for a given
   password, so the human can generate `PARTY_PASSWORD_HASH` and `HOST_PASSWORD_HASH` without
   pasting plaintext anywhere.
9. **`lib/markdown.ts`.** Bold, italic, links, line breaks, lists. **No raw HTML passthrough.**
   Phase 1 has no surface that renders prose, and owns this anyway: phases 2, 4 and 6 all need it,
   and three independent renderers is the alternative.
10. **Middleware.** Verify `party_session` on every route except `/gate`, its POST route,
    `/api/keepalive`, and static assets. Redirect to `/gate` otherwise. Runs on Edge.
11. **`/gate`.** One password field, the full ridge, the words "You're invited", and nothing else -
    no date, no names, no photo. Its POST route runs in the Node runtime, checks
    `PARTY_PASSWORD_HASH`, and enforces 10 attempts per IP per 15 minutes against `gate_attempts`.
    **Delete rows older than the window before counting**, in the same handler. This endpoint is
    the only one reachable without a cookie, so an unbounded insert here is an open invitation to
    fill a 500 MB database with rows nothing will read again.
12. **Name capture.** After the gate, a visitor with no `party_guest` cookie is asked for a first
    name, which inserts a `guests` row and sets the cookie. One field, no email, no password.
13. **`/host`.** The host password form and the `admin` claim upgrade. The tab shell reads
    `lib/host-tabs.ts`. Phase 1 ships the shell and placeholders; each later phase fills its tab.
14. **Navigation and placeholders.** `lib/nav.ts` declares Invitation, Album, Updates, Messages.
    `lib/host-tabs.ts` declares RSVPs, Messages, Posts, Album, Content, Party. Create every route
    they point at as a short placeholder page. **Later phases replace their own page file and edit
    neither registry** - this is what keeps phases 2 to 6 conflict-free.

    Phase 1 also wires the unread badge on the guest Messages nav entry and the unread counts on the
    host Messages tab, reading `messages` directly. The table exists from this phase's migration and
    is simply empty until Phase 5, so the badge is correct from the first deploy and Phase 5 never
    has to touch the registry to light it up.
15. **Surprise protection.** A bland `<title>`, no `og:image`, no `og:description` naming the
    occasion or either person. `noindex, nofollow` metadata, an `X-Robots-Tag` response header, a
    `robots.txt` disallowing everything, and `Referrer-Policy: no-referrer`.
16. **`GET /api/keepalive`.** Runs `select 1`, then deletes `gate_attempts` rows older than a day -
    which catches a burst from an IP that never came back, since the gate only prunes when someone
    knocks. Declare a daily Vercel Cron for it in `vercel.json`. This is load-bearing, not
    belt-and-braces: nine quiet weeks stand between now and the party and the Free pause window is
    one.
17. **The test harness, and the guard that makes it safe.** CI runs `supabase start` on the
    GitHub-hosted runner, applies `supabase/migrations` and `supabase/seed.sql` into that throwaway
    Postgres, builds the app, and serves it locally; Playwright drives that. A `globalSetup` throws
    unless `SUPABASE_URL`'s host is `127.0.0.1` or `localhost`, so the suite cannot be pointed at a
    hosted project by a mis-set variable.

    That guard is the deliverable, not the convenience. The Free plan has no database branching, so
    previews share the production database, and the specs phases 2 to 6 will add delete
    photographs, rewrite the invitation copy and merge guest identities. One run against the wrong
    URL and the party is planned from a corrupted table. **No phase points a spec at a preview or
    production URL** - a preview is for a person to look at.
18. **CI and deploy.** A GitHub Actions workflow running install, typecheck, lint, build and the
    Playwright job above, on pull requests. Create the Vercel project on the `mancej's projects`
    team linked to the repository, production tracking `main`. Set `SUPABASE_URL`,
    `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `PARTY_PASSWORD_HASH`, `HOST_PASSWORD_HASH` -
    none prefixed `NEXT_PUBLIC_`. Confirm the Supabase GitHub integration applied the migration on
    merge.

## Data and compatibility

The whole schema lands here, including tables nothing in this phase reads and one function nothing
in this phase calls. That is deliberate: one reviewable migration that matches the plan, and no
ordering hazard between the four concurrent phases that follow. Later phases add indexes and rows,
never columns to these tables.

`merge_guests()` is `security invoker` with a pinned `search_path`, which keeps Supabase's advisor
quiet about mutable search paths. Only the service-role client can reach it, because RLS is on with
no policies and nothing else holds a key.

## Tests and verification

Playwright, against the built app:

1. An un-gated request to any guest route redirects to `/gate`.
2. A wrong password is rejected; after 10 attempts the limiter responds differently.
3. The correct password, then a name, creates a guest and lands on the shell.
4. The gate page contains no date, no venue and no personal name.
5. The home document has no `og:image` and no occasion-naming metadata, and carries
   `noindex, nofollow`.
6. `/host` is unreachable without the host password, and reachable with it.
7. A `gate_attempts` row older than the window is gone after the next attempt, and the limiter
   counts only in-window rows.

Unit tests (`node:test` or the repository's chosen runner) for `lib/session.ts` (a forged cookie is
rejected; a `kid` bump invalidates; **a cookie naming a merged row resolves to the survivor and the
response re-mints `party_guest`**; a cookie naming a chain longer than the cap is cleared rather
than followed forever), `lib/password.ts` (a correct password verifies, a wrong one does not), and
`lib/markdown.ts` (`<script>` and `<img onerror>` in input produce no raw HTML in output).

Database tests against the local stack for `merge_guests()`: both guests' comments and messages
land on the survivor; the survivor's RSVP wins a collision and the loser's is dropped; the loser
keeps its row with `merged_into` set; a guest already pointing at the loser is repointed at the
survivor; merging a guest into itself raises; merging an already-merged guest raises.

**The harness itself is a test.** Assert that `globalSetup` throws when `SUPABASE_URL` names a
host that is not loopback. A guard nothing exercises is a guard that stops working silently.

Commands: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npx playwright test`.

## Merge and exit criteria

- CI green on the pull request.
- The Vercel production deployment is live and gated.
- The migration has been applied to the Free-org project and every table reports RLS enabled.
- `GET /api/keepalive` returns 200 and the Cron is registered.
- The Playwright job runs against `supabase start`, and the localhost guard is proven to fail
  closed.
- `AGENTS.md` exists and states the contracts below.
- Every route in both registries resolves, as a real page or an honest placeholder.

## Downstream handoff

Phases 2 to 6 may rely on, and must not change:

- The schema and its seeds. Add indexes and rows, never columns to these tables.
- `lib/supabase.ts` as the only Supabase client, server-only, no `NEXT_PUBLIC_` variables.
- `lib/session.ts` as the only cookie reader and writer. Use `requireGuest()` and `requireHost()`.
  `requireGuest()` already resolves `merged_into`, so the id it returns is always a surviving guest.
  Never read the `party_guest` cookie yourself to get around that.
- `merge_guests(p_survivor, p_loser)`, called through `supabase.rpc`. Phase 6 owns the tool around
  it; nobody re-implements the move as separate statements.
- The Playwright harness and its localhost guard. Add specs to it; do not point one at a deployed
  URL.
- `lib/markdown.ts` as the only renderer of host-authored prose.
- `lib/theme.css` tokens. No colour literals in components.
- `lib/nav.ts` and `lib/host-tabs.ts`, including the messages unread badge, which already reads the
  `messages` table. **Replace your own page file; do not edit these registries.**
- The middleware gate. A new guest route inherits it rather than re-implementing one.
- The surprise-protection metadata defaults.

## Cross-phase audit record

- Written first; owns every contract. No earlier phase to reconcile against.
- `lib/markdown.ts` was pulled forward into this phase after noticing phases 2, 4 and 6 each need to
  render host-authored prose. Leaving it to Phase 2 would have made phases 4 and 6 depend on Phase 2
  for a utility, serialising three independent features behind one.
- The registry-plus-placeholder contract was introduced after checking whether phases 2 to 5 could
  truly merge in any order. Without it all four edit the same navigation array and every pair
  conflicts.
- Merged-identity resolution moved here from Phase 6 after review: Phase 6 could hide a merged row
  from its own lists, but it could not stop phases 3, 4 and 5 writing new rows under the losing
  cookie, because that cookie stays valid and only `lib/session.ts` ever reads it.
- `merge_guests()` moved here from Phase 6 for the same class of reason. Phase 6 declared "no schema
  change" and inherited only the REST client, which cannot make four related writes one transaction.
  The transaction boundary is schema, so it belongs in the phase that owns the schema.
- The Playwright harness was re-specified after review. It originally drove "a real Supabase
  project", which - with no branching on the Free plan and previews sharing production - meant
  every pull request's suite deleting photographs and rewriting the invitation on the live site.
- The unread badge moved here from Phase 5 for the same reason. `plan.md` puts an unread badge in
  the guest nav; the nav is a Phase 1 file that later phases must not edit, so Phase 1 wires the
  badge against a table that exists but is empty. Phase 5 then lights it up by inserting rows rather
  than by changing navigation.
