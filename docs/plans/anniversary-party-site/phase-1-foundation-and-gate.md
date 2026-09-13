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
- Theme tokens from direction A, and the ridge SVG components.
- App shell: root layout, guest navigation, host tab shell.
- Complete schema migration plus seed data.
- `lib/supabase.ts`, `lib/session.ts`, `lib/markdown.ts`, `lib/theme.css`, `lib/nav.ts`,
  `lib/host-tabs.ts`.
- Edge middleware, `/gate`, the name-capture step, `/host` authentication.
- Gate rate limiting on `gate_attempts`.
- Surprise-protection metadata, headers and `robots.txt`.
- `GET /api/keepalive` and the Vercel Cron declaration.
- GitHub Actions workflow, Vercel project link, environment variables.
- Playwright harness and the phase's specs.

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
3. **`lib/theme.css`.** The direction-A tokens from `plan.md`: paper `#faf6ee`, page `#efe9dd`, ink
   `#26323b`, muted `#6d7a80`, accent `#b0653c`, ridges `#33566b` / `#55798c` / `#7a9aa8` /
   `#9db7c0`, sky `#f3d9b8`, sun `#f0b070`. Serif display and body. Wire into Tailwind so no
   component writes a colour literal.
4. **Ridge components.** `components/Ridge.tsx` (full, 96 units tall, with the sun) and a slim
   variant (30 units, two layers, no sky). Copy the path geometry from
   `mockups/a-blue-ridge-dawn.html` rather than redrawing it - the curves there are the approved
   ones.
5. **Migration.** One file under `supabase/migrations/`, matching the SQL in `plan.md` exactly:
   `guests`, `rsvps`, `posts`, `comments`, `messages`, `party`, `content_blocks`, `photos`,
   `gate_attempts`, their indexes, and `alter table ... enable row level security` on every one with
   **no policies**. Then seed: the single `party` row (14 November 2026, The Capital Club, parking
   `6 Sears Alley, Asheville, NC`, note `Covered and included`) and every `content_blocks` key with
   its label and a sensible default body.
6. **`lib/supabase.ts`.** A server-only module exporting one service-role client. Add the
   `server-only` package import so a client-component import fails at build time rather than at
   runtime.
7. **`lib/session.ts`.** `jose` HS256 over `SESSION_SECRET`, with a `kid` claim so rotation
   invalidates every session. Mint and verify `party_session` (with an optional `admin` claim) and
   `party_guest`. Export `requireGuest()` and `requireHost()`. Cookies are `HttpOnly`, `Secure`,
   `SameSite=Lax`, long-lived.
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
16. **`GET /api/keepalive`.** Runs `select 1`. Declare a daily Vercel Cron for it in `vercel.json`.
    This is load-bearing, not belt-and-braces: nine quiet weeks stand between now and the party and
    the Free pause window is one.
17. **CI and deploy.** A GitHub Actions workflow running install, typecheck, lint, build and
    Playwright on pull requests. Create the Vercel project on the `mancej's projects` team linked to
    the repository, production tracking `main`. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
    `SESSION_SECRET`, `PARTY_PASSWORD_HASH`, `HOST_PASSWORD_HASH` - none prefixed `NEXT_PUBLIC_`.
    Confirm the Supabase GitHub integration applied the migration on merge.

## Data and compatibility

The whole schema lands here, including tables nothing in this phase reads. That is deliberate: one
reviewable migration that matches the plan, and no ordering hazard between the four concurrent
phases that follow. Later phases add indexes and rows, never columns to these tables.

## Tests and verification

Playwright, against the built app:

1. An un-gated request to any guest route redirects to `/gate`.
2. A wrong password is rejected; after 10 attempts the limiter responds differently.
3. The correct password, then a name, creates a guest and lands on the shell.
4. The gate page contains no date, no venue and no personal name.
5. The home document has no `og:image` and no occasion-naming metadata, and carries
   `noindex, nofollow`.
6. `/host` is unreachable without the host password, and reachable with it.

Unit tests (`node:test` or the repository's chosen runner) for `lib/session.ts` (a forged cookie is
rejected; a `kid` bump invalidates), `lib/password.ts` (a correct password verifies, a wrong one
does not), and `lib/markdown.ts` (`<script>` and `<img onerror>` in input produce no raw HTML in
output).

Commands: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `npx playwright test`.

## Merge and exit criteria

- CI green on the pull request.
- The Vercel production deployment is live and gated.
- The migration has been applied to the Free-org project and every table reports RLS enabled.
- `GET /api/keepalive` returns 200 and the Cron is registered.
- `AGENTS.md` exists and states the contracts below.
- Every route in both registries resolves, as a real page or an honest placeholder.

## Downstream handoff

Phases 2 to 6 may rely on, and must not change:

- The schema and its seeds. Add indexes and rows, never columns to these tables.
- `lib/supabase.ts` as the only Supabase client, server-only, no `NEXT_PUBLIC_` variables.
- `lib/session.ts` as the only cookie reader and writer. Use `requireGuest()` and `requireHost()`.
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
- The unread badge moved here from Phase 5 for the same reason. `plan.md` puts an unread badge in
  the guest nav; the nav is a Phase 1 file that later phases must not edit, so Phase 1 wires the
  badge against a table that exists but is empty. Phase 5 then lights it up by inserting rows rather
  than by changing navigation.
