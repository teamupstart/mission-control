# Jira through the Atlassian CLI (acli): implementation phases

Source plan: `docs/plans/acli-jira-query-method/plan.md` (GitHub issue #1270).

## Incorporated decisions

From the dashboard review of the source plan:

- Remote links are reported as unavailable on acli and the comment still posts. Verified: acli
  1.3.40 has no remote-link command.
- Resolve probes for a transition list first; if acli exposes none, it moves by status name and a
  refusal quotes acli's error with the issue's current status.
- No fallback: an acli source uses acli only.
- The operator logs in to acli on this machine; the Phase 1 agent captures read-only fixtures.
  acli 1.3.40-stable is installed at `/opt/homebrew/bin/acli`. The operator declined a live
  capture during planning, so capture is the first step of Phase 1.
- Create this phased plan.

## Repository findings that shape the phases

- `queryVia` already dispatches a second credential boundary (UpstartClaw) from `sweep`
  (`src/server/task-sources/jira.ts:1374`), `preflight` (`:1403`) and `writeTarget` (`:1912`).
  acli follows the same pattern, so no new task-source kind, capability flag or migration is needed.
- `TASK_SOURCE_KIND_INFO.jira` declares `canAnnotate: true` and `canResolve: true`
  (`src/shared/task-source.ts:587-608`) and `test/task-source-contract.test.ts` holds those flags
  to the implementation. The flags are per kind, not per method, so an acli source that cannot yet
  write must refuse with a sentence, exactly as an UpstartClaw source does today
  (`UPSTARTCLAW_READ_ONLY`, `jira.ts:1453`).
- `jiraBin()` (`src/server/config.ts:295`) is the single seam the browser suite redirects
  (`MISSION_JIRA_BIN` in `e2e/fixtures/daemon.ts`) at a recording fake
  (`e2e/fixtures/fake-agents.ts`, the `FAKE_JIRA` program). acli needs the same seam and fake from
  the first phase, because even a read-only phase spawns it in the browser suite.
- `EXECUTABLE_IDS` (`src/shared/executables.ts`) is append-only and pinned by
  `test/executable-contracts.test.ts`. `main` has appended an id since the scout's commit, so the
  new `"acli"` id goes at the end of whatever list `main` holds when Phase 1 starts.
- The sweeper aborts a sweep after 60 s (`src/server/task-sources/sweeper.ts:28`); one acli sweep
  must finish inside it.
- Every acli failure exits 1 with the reason on stderr (verified), so the fault classifier keys on
  stderr text.

## Sizing

Estimated non-test production lines added or materially changed: **550 to 700**.

| Area | Estimate |
| --- | --- |
| `src/server/task-sources/jira-acli.ts`, read path (argv, output reader, fault classifier, sweep, preflight, site identity) | 220 to 280 |
| `jira-acli.ts`, write path (site proof, comment, view, resolve, transition probe) | 170 to 230 |
| `jira.ts` dispatch and refusals | 30 to 50 |
| `src/shared/task-source.ts`, `src/shared/executables.ts`, `src/server/executables/catalog.ts`, `src/server/config.ts` | 25 to 35 |
| `src/web/components/TaskSourcesPanel.tsx` (option, login note, remote-link note) | 30 to 50 |

Assumptions: the captured search JSON is Jira's own issue shape (or an array of it) so
`issuesFrom` and `candidateFrom` are reused unchanged; if acli flattens the shape, add roughly 60
lines for an adapter. Tests, the fake `acli`, fixtures and docs are extra and substantial.

## Phase count

The estimate is above 200 lines, so the default would be one phase. Two phases are used because
the write path has a separate, higher-risk merge boundary:

- Phase 1 is read-only. It cannot change a ticket, it already removes the reported pain (a desktop
  install with no environment variables fills its backlog from Jira), and its live contract
  capture fixes the JSON shapes the write path needs (`view --json`, the site identity in
  `auth status`).
- Phase 2 mutates other people's tickets. Its safety gates (positive site proof before any write,
  `outcomeUnknown` never retried, the resolve refusal contract) deserve a review that is not
  diluted by the read path. Combining them would put ~650 production lines and two fake programs'
  worth of tests in one PR, and the write path would be built against shapes that were guessed
  rather than captured.

Between the phases, an acli source refuses write-back with one sentence naming the cause, the same
state UpstartClaw sources are permanently in. Nothing is broken or half-wired.

## Phases

| Phase | File | Outcome | Depends on |
| --- | --- | --- | --- |
| 1 | `phase-1-acli-read-path.md` | Select "Atlassian CLI (acli)" as a Jira source's query method; sweep, preflight and linked reads work through acli's OAuth login; write-back refuses with a sentence | planning PR merge |
| 2 | `phase-2-acli-write-back.md` | acli sources post the write-back comment, report the remote link as unavailable, and resolve issues, with positive site proof before every write | Phase 1 |

## Dependency graph

```mermaid
flowchart LR
  P[Planning PR merge] --> A[Phase 1: acli read path]
  A --> B[Phase 2: acli write-back]
```

No phases run concurrently: Phase 2 consumes Phase 1's seam, fake, captured fixtures, fault
classifier, site-identity helper and site gate.

## Merge order

1. The planning pull request (these Markdown files).
2. Phase 1.
3. Phase 2.

## Cross-phase contracts

Owned by Phase 1, relied on by Phase 2, and not to be renamed or reshaped by it:

- `queryVia` value `"acli"` and the panel option label "Atlassian CLI (acli)".
- `acliBin()` in `src/server/config.ts`, env suffix `ACLI_BIN`, executable id `"acli"`.
- Module `src/server/task-sources/jira-acli.ts`, with an exported fault classifier
  (`acliFault`, `acliFailure`) over a `run` result, an exported active-site reader
  (`acliActiveSite`) that returns the host acli is logged in to or `null` when it cannot be
  established, and an exported `acliSiteGate` that refuses unless that host positively equals the
  configured site. The gate runs before every acli read (Phase 1) and every acli write (Phase 2).
- Fixture directory `test/fixtures/acli/` holding captured outputs rewritten with synthetic
  hosts, keys and people (no operator data is committed), plus a short
  `README.md` there recording the acli version and the exact commands used.
- The fake `acli` program in `e2e/fixtures/fake-agents.ts`, wired through `MISSION_ACLI_BIN`,
  which records every invocation as a JSON file the way the fake `jira` does.
- Every acli subprocess passes an empty stdin.
- `ACLI_WRITE_PENDING` refusal sentence (Phase 1) is removed by Phase 2, not reworded.

## Final verification

After Phase 2 merges, on a daemon started from the desktop app with no Jira environment
variables and acli logged in to the configured site:

1. A Jira source on acli passes "Check it works" and its sweep files tasks.
2. A finished task on that source posts its comment and moves the issue (verified by the operator
   on a test issue of their choosing; agents never write to a real site).
3. Existing local and UpstartClaw sources sweep and write back exactly as before.
4. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke` and
   `npm run test:e2e` pass.
