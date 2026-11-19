# Headless mode (FR-05): phased plan

Source plan: `docs/plans/headless-mode-fr05/plan.md` (revision 2). Spec: Commonroom `d2cdf331-4f03-4c77-957d-246cfde0017c` v3.

## Incorporated decisions

D-A stack mode between prerequisites; D-B WP0 spikes as a chat task; D-C Claude with launch-time defaults; everything behind the `headless-mode` flag.

## Investigated findings (code on `main`)

- `FEATURE_FLAGS` in `src/shared/feature-flag-registry.ts` is empty, so WP1 adds the first real flag. The WP1 browser check from `docs/feature-flags.md` applies if the Settings panel exists.
- `CURRENT_DATABASE_SCHEMA_VERSION` is 34, matching the spec's schema 35 plan.
- `src/cli/`, `agents/`, `src/server/home-dispatch/` and `src/mcp/home-dispatch/` do not exist yet. `package.json` `bin` has only `mission-control`. WP1 creates the CLI skeleton, the `mctl` bin entry and build outputs.
- `composeTurnOne` is a local closure in `src/server/dispatcher.ts` (around line 720), not an exported function. WP8 may need to extract it; that extraction is part of WP8's ownership and must keep flag-off prompts byte-identical.
- `hooks/harness-hook.mjs`, `hooks/harness-statusline.mjs`, `scripts/install-service.mjs` and `src/server/skills/reconcile.ts` exist as the spec assumes.
- The spec says to trust `main` over itself when they differ; each pull request reports any such difference.

## Sizing

Estimated non-test implementation: roughly 9,000 to 14,000 lines across all packages (spec 8.1 targets under 1,500 changed lines per pull request), well above the single-phase threshold. The spec already fixes one package per pull request with one owner per file, so the phase boundaries are the spec's work packages. Merging any pair would break the one-owner-per-file rule or exceed the size target; splitting further would create dead surfaces.

## Phases

| Phase | WP | File | Direct prerequisites (stack) |
|---|---|---|---|
| 1 | WP1 | `phase-1-wp1-contracts-flag-stubs.md` | planning session |
| 2 | WP2a | `phase-2-wp2a-sessions-turns-launcher.md` | 1 |
| 3 | WP2b | `phase-3-wp2b-inbox-answers-approval.md` | 1 |
| 4 | WP3 | `phase-4-wp3-options-drafts-checkins.md` | 1 |
| 5 | WP8 | `phase-5-wp8-repo-task-skills.md` | 1 |
| 6 | WP4 | `phase-6-wp4-hook-statusline.md` | 2, 3 |
| 7 | WP5a | `phase-7-wp5a-mcp-tools-forms.md` | 2, 3, 4 |
| 8 | WP6a | `phase-8-wp6a-mctl-core.md` | 3 |
| 9 | WP5b | `phase-9-wp5b-skills-command.md` | 7 |
| 10 | WP6b | `phase-10-wp6b-mctl-run-claude.md` | 8, 4 |
| 11 | WP7 | `phase-11-wp7-setup-doctor-services.md` | 6, 9, 8 |
| 12 | WP10 | `phase-12-wp10-follow-drop-in.md` | 2, 10, 11, 5 |
| 13 | WP11 | `phase-13-wp11-subagents.md` | 9, 12 |
| 14 | WP9 | `phase-14-wp9-docs.md` | 11, 13 |
| 15 | WP12 | `phase-15-wp12-full-loop.md` | 14 |

WP0 (spikes) is a separate chat task with no prerequisites. Its recorded answers gate the merge of WP4 (S6), WP5a (S1, S2, S7), WP5b (S3, S8), WP6b (S3), WP7 (S5) and WP11 (S4); if an answer is no, the task follows the spec's 11.2 fallback.

## Concurrency and merge order

Phases 2, 3, 4 and 5 run concurrently once phase 1 exists. Phases 6, 7 and 8 run concurrently next. Phases 9 and 10 follow. Merge order follows the spec's waves: 1; 2 to 5; 6 to 8; 9, 10; 11; 12 then 13; 14 then 15. Stacked phases rebase onto `main` as their prerequisites merge.

## Cross-phase contracts

All shared schemas, route stubs, tool stubs, the `mctl` command registry and the fakes land in phase 1. Later phases replace stubs and never change a stub's shape; additions are optional fields or new schemas in a separate `contract:` commit. Only phase 1 adds schema 35. Flag gating contract: the gates in spec 7.1.

## Final verification

Phase 15 runs the full loop against a real daemon with fake agents, the flag-off sweep, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`, `npm run test:e2e` (existing dashboard specs unchanged), and the owner does the live walkthrough in spec section 6.
