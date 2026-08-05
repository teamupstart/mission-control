# Phase 6: CONTRIBUTING, setup docs, and core repo docs

## Outcome

A new contributor can go from clone to green tests by following one document, and the
repository has the standard entry points people look for: `CONTRIBUTING.md`, a setup
guide, and PR/issue templates that match how this repo actually reviews work.

## Entry criteria and dependencies

- Direct prerequisite: phase 4 (the docs index with the reserved "Contributing and
  setup" section, and the interim README this phase must not edit).
- May run concurrently with phases 5 and 7 under the index-section contract.

## Scope

- `CONTRIBUTING.md` at the root: prerequisites (Node.js 24+, `npx playwright install
  chromium` once per machine), the command table (`npm run dev`, `build`, `typecheck`,
  `lint`, `test`, `test:electron`, `test:e2e`, `smoke`, `package`, plus the `make`
  entry points), the four test layers and when each applies (unit/contract in `test/`,
  `renderToStaticMarkup` markup shape, Electron geometry, Playwright `e2e/`), the
  e2e-spec-for-every-UI-change rule with its two standing constraints (never spend model
  tokens - fake agents; never `data-testid` - select by role/label), the working rules
  (git hygiene, module ownership, docs-in-the-same-change), and the PR bar (what must be
  green before opening, what the description contains per the pull-request skill).
- `docs/setup.md`: first-run walkthrough - `make init` / `make setup`, what the daemon
  is, where state lives, hook installation, the desktop app, and the demo mode for
  poking around without real agents.
- Harden `scripts/init.mjs` (or the `make init` path) to verify its own prerequisites -
  Node major version, presence of the Playwright Chromium browser when e2e is requested -
  and fail with the fix as the message instead of failing downstream. Small, focused
  change; keep the script's existing structure.
- `.github/PULL_REQUEST_TEMPLATE.md` with the Goal / Design decisions / Proof of work
  headings the pull-request skill already mandates, and a minimal
  `.github/ISSUE_TEMPLATE/` pair (bug, feature) matching how this repo describes
  behavior (repro through the UI, expected vs observed).
- No LICENSE file (adopted decision) - `CONTRIBUTING.md` and the README state the
  repository is internal.
- Add the entries under the index's **Contributing and setup** section.

Non-goals: editing `README.md` (phase 8), editing `.github/workflows/` (release
infrastructure, out of scope), restating `AGENTS.md` - CONTRIBUTING is for humans and
links to `AGENTS.md` for the agent-facing rules rather than duplicating them.

## Repository findings

- `AGENTS.md` already contains most of the raw material (commands, test layers, working
  rules, definition of done) but is written as agent instructions; CONTRIBUTING re-frames
  it for a person and links back rather than forking it.
- The Makefile has `init` ("First-run bootstrap: deps, build, hooks, and treehouse") and
  `setup`; `scripts/init.mjs` exists. `npm install` does not fetch the Playwright
  browser - the one prerequisite that reliably bites new machines
  (per `AGENTS.md` commands section).
- macOS specifics: `npm test` includes real Electron geometry tests; `CODEX_SANDBOX`
  note in `AGENTS.md` - carry these into CONTRIBUTING verbatim in spirit.
- `.github/` currently holds only `workflows/ci.yml`; CI runs typecheck, tests, build,
  smoke on Node 24/26, e2e on Node 24, and lint is local-only - CONTRIBUTING should say
  exactly that so nobody trusts CI to catch lint.

## Implementation steps

1. Write `CONTRIBUTING.md`; link `AGENTS.md`, `docs/setup.md`, `e2e/README.md`, and the
   docs index.
2. Write `docs/setup.md`.
3. Harden `scripts/init.mjs` prerequisite checks; update `Makefile` help text if the
   behavior description changes.
4. Add the PR template and issue templates.
5. Add index entries.

## Compatibility

`scripts/init.mjs` changes are behavioral: keep every existing invocation working
(`make init`, `npm run init`), only adding earlier and clearer failures.

## Tests and verification

- `npm run typecheck`, `npm run lint`, `npm test`.
- Run `node scripts/init.mjs` on the current machine; exercise the failure path by
  simulating a missing prerequisite (e.g. temporarily pointing PATH at an older Node) or
  by unit-testing the check function if it is extracted - proportionate to the size of
  the change.
- Link sweep over the new documents.
- No UI surface changes; no e2e spec required.

## Merge and exit criteria

- CI green; templates render correctly on GitHub (check in the PR).
- CONTRIBUTING answers clone-to-green without reference to any other document except
  where it links.

## Downstream handoff

Phase 8's README links `CONTRIBUTING.md`. The init prerequisite checks become the
supported first-run path; later phases must not add setup steps outside them without
updating `docs/setup.md`.

## Cross-phase audit record

- 2026-08-04: initial version. LICENSE decision (none; internal) recorded here and in
  the source plan's adopted decisions; the README statement itself lands with phase 8's
  rewrite (the interim README from phase 4 already notes it).
