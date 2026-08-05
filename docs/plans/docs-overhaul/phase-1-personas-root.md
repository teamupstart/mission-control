# Phase 1: consolidate personas under root `personas/`

## Outcome

Every persona document lives in one obvious root directory: the Foreman operator brief,
the Inspector operator brief, and the four builtin workflow personas. The app still finds
the Foreman seed in dev and in the packaged macOS build, the Inspector prefers
`personas/INSPECTOR.md` in any reviewed repo while still honoring a root `INSPECTOR.md`,
and every `builtin:<slug>` id survives unchanged.

## Entry criteria and dependencies

- No phase prerequisites; this is the first implementation phase.
- The planning PR (this plan and its phase files) has merged to the default branch.

## Scope

Move, keeping filenames byte-identical:

- `FOREMAN.md` → `personas/FOREMAN.md`
- `INSPECTOR.md` → `personas/INSPECTOR.md`
- `docs/personas/intent-conformance-judge.md` → `personas/intent-conformance-judge.md`
- `docs/personas/documentation-steward.md` → `personas/documentation-steward.md`
- `docs/personas/code-risk-reviewer.md` → `personas/code-risk-reviewer.md`
- `docs/personas/test-evidence-auditor.md` → `personas/test-evidence-auditor.md`

Add `personas/README.md`: a short page stating what lives here - two operator briefs read
as files at runtime, four workflow persona sources compiled in by `npm run personas` -
and that filenames are durable ids.

Non-goals: `docs/session-actions/` (phase 2), `docs/evidence/` (phase 3), README
restructuring beyond fixing the references this move breaks (phase 4). Do not touch
`skills/`, and do not add `personas/**` to the electron-builder `files:` allowlist beyond
the single `FOREMAN.md` entry - the workflow persona markdown is compiled in and must not
ship twice (see `scripts/builtin-markdown.ts` header).

## Repository findings

- `src/server/config.ts:64-66`: `foremanInstructionsPath()` resolves
  `new URL("../../FOREMAN.md", import.meta.url)`. The `../../` is load-bearing: it
  resolves to the repo root in dev and the app root in the packaged build because the
  module sits two levels down in both trees. The doc comment (`:52-63`) explains this;
  update it with the path.
- `electron-builder.yml:38` ships `- FOREMAN.md` in the `files:` allowlist with a comment
  at `:34-37`. This file is release infrastructure; this phase is the explicit scope for
  touching that one entry.
- `src/server/inspector/brief.ts`: `BRIEF_FILENAME = "INSPECTOR.md"` (`:11`);
  `readBrief()` does one `join(root, BRIEF_FILENAME)` (`:77`) through the
  symlink-escape-safe `readRepoDoc`. There is no env override and no test pinning the
  lookup. **Operator non-negotiable:** without a code change, moving this repo's copy
  silently downgrades Inspector reviews of this repo to `DEFAULT_BRIEF` with no failing
  test.
- `scripts/builtin-personas.ts`: `sourceDir` (`:22`) and `SPEC.sourceGlob` (`:27`). The
  glob string is baked into the generated module's header, so the module must be
  regenerated in the same commit or `test/builtin-personas.test.ts` fails its drift
  assertion.
- **The generator globs every `*.md` in the directory** via `builtinMarkdownSources`
  (`scripts/builtin-markdown.ts:34-42`). With the briefs and a README in `personas/`, the
  generator would mint `builtin:FOREMAN`, `builtin:INSPECTOR`, and `builtin:README`
  personas. It needs an explicit exclusion.
- `test/builtin-personas.test.ts:32` pins `join(root, "docs", "personas")` and
  `readdirSync`s it (`:60`); `test/seed-personas.test.ts:28` reads
  `../docs/personas/${file}` and hard-codes the four filenames.
- Filename slugs are durable ids: `src/server/workflows/builtin-personas.ts:33-35`
  derives `builtin:<slug>` from the filename, and published workflow versions reference
  those ids.

## Implementation steps

1. `git mv` the six files into `personas/` and write `personas/README.md`.
2. `src/server/config.ts`: point `foremanInstructionsPath()` at
   `../../personas/FOREMAN.md`; update the doc comment.
3. `electron-builder.yml`: change the allowlist entry to `personas/FOREMAN.md`; keep the
   explanatory comment accurate.
4. `src/server/inspector/brief.ts`: replace the single lookup with an ordered candidate
   list - `personas/INSPECTOR.md` first, root `INSPECTOR.md` second - first non-empty doc
   wins, both through `readRepoDoc` with the same byte cap. Update the module comments
   and the `DEFAULT_BRIEF` sentence ("No INSPECTOR.md was found...") to name both
   locations, plus the copy at `src/server/inspector/prompt.ts:104` and the review footer
   at `src/server/inspector/github.ts:870` if it names a location.
5. `src/web/components/InspectorSettingsPanel.tsx:237`: update the panel copy describing
   where the brief is read from. This is user-visible copy, so cover it with an e2e
   assertion (see verification).
6. `scripts/builtin-personas.ts`: `sourceDir` → `join(root, "personas")`, `sourceGlob` →
   `"personas/*.md"`, header comment, and the exclusion for `README.md`, `FOREMAN.md`,
   `INSPECTOR.md` (an explicit list that fails loudly beats a naming heuristic; put it
   where the drift test can share it). Run `npm run personas` and commit the regenerated
   `src/server/workflows/builtin-personas.generated.ts` - never hand-edit it.
7. Tests: update the two path-pinning tests (`test/builtin-personas.test.ts:32`,
   `test/seed-personas.test.ts:28`) and make the drift test's `readdirSync` respect the
   same exclusion list as the generator. Add unit tests for the brief lookup order:
   `personas/INSPECTOR.md` preferred, root fallback honored, default brief when neither
   exists, and the symlink-containment behavior preserved for the new path.
8. Prose: `README.md:2564` and `:5815` (persona source location and the `npm run
   personas` command line), `README.md:3674`/`:3707`/`:5706` (Foreman seed location and
   the `MISSION_FOREMAN_INSTRUCTIONS` row - keep the anchor it links to resolving),
   `README.md:5120`/`:5199`/`:5203` (Inspector brief location, including the
   `[INSPECTOR.md](INSPECTOR.md)` link), `docs/agent-guides/change-contracts.md:370`.
   Historical plans and `docs/backups/AGENTS.old` keep their old paths.

## Compatibility

- `MISSION_FOREMAN_INSTRUCTIONS` still overrides the seed path; no schema, migration, or
  API changes. `/api/personas/...` routes and `builtin:<slug>` ids are untouched.
- Repos that keep a root `INSPECTOR.md` continue to be reviewed against it (fallback).
  A repo with both files gets `personas/INSPECTOR.md`.

## Tests and verification

- `npm run typecheck`, `npm run lint`, `npm test` (includes the drift, seed, and new
  brief-order tests).
- `npm run build` and `npm run smoke` - the Foreman seed path and the packaged allowlist
  changed.
- `npm run test:e2e` with an assertion covering the Inspector settings panel copy change
  (extend the existing settings spec rather than adding a parallel one if it fits).
- `npm run personas` immediately after the commit is a no-op.

## Merge and exit criteria

- All checks above green; CI green on the PR.
- `personas/` contains exactly the six moved files plus `README.md`; `docs/personas/` and
  the root `FOREMAN.md`/`INSPECTOR.md` are gone.
- No change to any `builtin:` id or persona filename.

## Downstream handoff

Later phases may rely on: `personas/` as the only persona location, the generator
exclusion rule, and the brief candidate order. They must not rename persona files or add
non-persona markdown to `personas/` beyond `README.md`.

## Cross-phase audit record

- 2026-08-04: initial version. Exclusion-list requirement discovered during planning
  investigation (generators glob the whole directory) and recorded in
  `phased-plan.md` findings; Phase 2 mirrors it for `actions/`.
