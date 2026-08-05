# Phase 8: new README with screenshots

## Outcome

The repository's front page advertises the product: what Mission Control is, who it is
for, and what it looks like - a screenshot-led feature tour under 300 lines that links
into `docs/` for everything deep. Screenshots are reproducible by a script, not
hand-taken.

## Entry criteria and dependencies

- Direct prerequisites: phases 5, 6, and 7. The README is the hub; it links the
  architecture overview, CONTRIBUTING, and the support docs, so they must exist first.

## Scope

- `scripts/docs-screenshots.mjs`: drives the BUILT dashboard in demo mode with
  Playwright and writes a curated set of screenshots to `docs/images/`. Demo mode is
  faked data (`scripts/demo/launch.mjs`, `scripts/demo/scenarios/`), so captures spend no
  model tokens and are deterministic enough to re-run when the UI changes. Fixed
  viewport, named scenario per shot, stable output filenames. Add an npm script
  (`docs:screenshots`) and document the regeneration flow in `CONTRIBUTING.md` or
  `docs/setup.md` (one line each, linking here).
- `docs/images/`: the committed screenshots. These are documentation imagery, explicitly
  allowed by the AGENTS.md evidence boundary from phase 3 (which names `docs/images/`).
- New `README.md`, replacing phase 4's interim page: what it is (a local control plane
  for Claude Code, Codex, and Pi sessions), the feature tour with screenshots (the
  board/fleet view, dispatch, workflows and personas, Foreman, Inspector, the Line,
  ensembles - pick the shots that sell the product, roughly 6-10), quick start
  (`make init`, `make dev` or the packaged app), a documentation section linking
  `docs/README.md`, `docs/architecture.md`, `CONTRIBUTING.md`, `SECURITY.md`, and a
  plain statement that the repository is internal (adopted decision: no LICENSE file).

Non-goals: restating any content that lives in `docs/` - the README links, it does not
duplicate; changing the dashboard to look better in screenshots (if something looks off
in demo mode, that is a real UI bug - fix it or file it, per the repo's own standard);
capturing screenshots from live agent sessions.

## Repository findings

- `npm run demo` → `scripts/demo/launch.mjs` with `scripts/demo/scenarios/` and fake
  agents (`fake-claude.mjs`, `fake-codex.mjs`, `fake-pi.mjs`) - the deterministic,
  token-free substrate the capture script needs already exists.
- `e2e/` already drives the built dashboard with Playwright against fake agents;
  the capture script can reuse those launch patterns (read `e2e/README.md` and
  `e2e/fixtures/` first) without living inside the e2e suite - it is a docs tool, not a
  test.
- The current README has zero images; `assets/` holds only mockups.
- Playwright Chromium is a machine prerequisite (`npx playwright install chromium`),
  already documented by phase 6.

## Implementation steps

1. Write the capture script; choose scenarios and views; capture at a fixed viewport
   (e.g. 1440x900, 2x) into `docs/images/` with stable names.
2. Curate: every shot in the README must earn its scroll - lead with the view that
   explains the product fastest.
3. Write the README; verify under 300 lines; verify every link resolves; verify images
   render on GitHub (check the PR's rich diff).
4. Wire `docs:screenshots` into `package.json`; document regeneration.

## Compatibility

No runtime code changes. The capture script must not modify app state outside its own
demo-mode daemon instance, and must be safe to run while a real daemon is running
(separate port or explicit failure - follow whatever `scripts/demo/launch.mjs` already
does).

## Tests and verification

- `npm run typecheck`, `npm run lint` (the new script is linted - `scripts` is in the
  lint set), `npm test`.
- `npm run build && node scripts/docs-screenshots.mjs` runs clean twice; second run
  produces the same set of files.
- The README is not a UI surface and the script is not a UI change, so no e2e spec is
  required; the script's own clean run is its verification.

## Merge and exit criteria

- CI green; README under 300 lines with rendering screenshots; the phased plan's final
  verification (in `phased-plan.md`) passes end to end.

## Downstream handoff

`docs/images/` and `scripts/docs-screenshots.mjs` are the only sanctioned committed
imagery and its only producer. UI changes that invalidate a shot re-run the script in the
same PR - the shot is documentation, and documentation matches the implementation in the
same change.

## Cross-phase audit record

- 2026-08-04: initial version. `docs/images/` allowance was written into the AGENTS.md
  boundary by phase 3 in anticipation of this phase; if phase 3 landed different wording,
  align with what merged.
