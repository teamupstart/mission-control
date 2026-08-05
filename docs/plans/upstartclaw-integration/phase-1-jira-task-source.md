# Phase 1: Jira task source

Implements Track B of [plan.md](plan.md). Read [phased-plan.md](phased-plan.md) for how this
phase relates to the others. This phase is independent of Phases 2 and 3 and may merge in any
order relative to them.

## 1. Outcome

An operator adds a **Jira** source in Settings -> Task sources, points it at a JQL filter, and
the sweeper files matching issues into the backlog as tasks - exactly as the GitHub issues
source does, with the same safety contract (files backlog rows and nothing else; never
dispatches, never types). A missing or misconfigured Jira credential surfaces as a preflight
sentence naming the fix, never a silent empty sweep.

## 2. Entry criteria and dependencies

- Direct prerequisite: the planning session's PR (this document reachable on the default
  branch). No other phase is a prerequisite.

## 3. Scope and non-goals

In scope: the `jira` task-source kind end to end - shared schema, server implementation, panel
field group, unit tests, one Playwright spec, README.

Non-goals:

- No credential storage in MC settings or the database (decision 9 in plan.md: declined).
- No incremental cursors or new persistence; dedup stays `task_source_seen` (the sweeper
  deliberately has no cursor state - `src/server/task-sources/sweeper.ts:37-48`).
- No write-back to Jira, no re-sync of changed issues (matches the documented GitHub
  non-goals, README "A task you delete stays deleted").
- No changes to routes, `db.ts`, or `protocol.ts` (verified unnecessary).

## 4. Repository findings (verified 2026-08-05)

The extension contract is a pair of `Record<TaskSourceKind, ...>` maps enforced by the
compiler; appending the kind fails typecheck until both carry an entry:

| Touchpoint | Location |
|---|---|
| `TASK_SOURCE_KINDS` append-only tuple | `src/shared/task-source.ts:33` |
| `TASK_SOURCE_KIND_INFO` (kind/label/blurb/configSchema) | `src/shared/task-source.ts:186-194` |
| `TASK_SOURCES` registry | `src/server/task-sources/index.ts:72-74` |
| The only UI kind switch | `src/web/components/TaskSourcesPanel.tsx:437-442` |
| GitHub-specific preflight success sentence | `src/web/components/TaskSourcesPanel.tsx:556-562` |

Contract facts the implementation must honor:

- `TaskSourceImpl<C>` (`src/shared/task-source.ts:125-134`): `preflight(config, ctx)` returns
  a sentence naming the fix or null; `sweep(config, ctx)` returns `{items, error}`. A non-zero
  exit, unparseable output, or `ctx.signal.aborted` must become `{items: [], error}` and never
  an empty success (`SweepResult` doc, `task-source.ts:72-81`).
- The config schema is `z.ZodType<C, z.ZodTypeDef, unknown>` and **must accept `{}`** - a
  freshly added source stores `config: {}` (`TaskSourcesPanel.tsx:781-814`), and
  `test/task-source-contract.test.ts:51-56` pins it for every kind.
- `externalId` must be stable and unique within the source and taken from the item's own
  identity (`task-source.ts:37-48`); for Jira the issue key (`PROJ-1234`) is exactly that.
- Candidates omit `priority` (not `null`) when no opinion, so the source default applies
  (`ingest.ts` uses `!== undefined`; see `github-issues.ts:128-161` for the spread idiom).
- Subprocesses go through `run()` from `src/server/util/exec.ts:68-93` (never a shell string);
  it accepts `env` for passing `JIRA_API_TOKEN`/`JIRA_EMAIL` through and never throws on a
  missing binary. GitHub's timeout is `GH_TIMEOUT_MS = 20_000` (`github-issues.ts:24`).
- Preflight must distinguish "CLI not installed" (exit 127 / stderr "not found") from "not
  authenticated" from "cannot query", each with the fix named - the GitHub model is
  `github-issues.ts:214-232`.
- `shared/task-source.ts` is browser-imported (`TaskSourcesPanel.tsx:8`) - **no `node:`
  imports** there (`AGENTS.md` controlled paths).
- The kind id is a **persisted append-only identifier** (`docs/agent-guides/change-contracts.md:40-44`):
  append `"jira"` at the end of the tuple, never reorder.
- No DB change: configured instances live in the `app_config` JSON blob (zod defaults applied
  on every read, `src/server/task-sources/config.ts:6-16`), and `task_source_seen` is
  kind-agnostic (`db.ts:752-758`).

## 5. Implementation steps

1. **`src/shared/task-source.ts`**
   - Append `"jira"` to `TASK_SOURCE_KINDS`.
   - Add `JiraConfigSchema` / `type JiraConfig`. Recommended fields, all defaulted and
     bounded like `GithubIssuesConfigSchema` (`task-source.ts:145-177`):
     - `site: z.string().max(200).default("upstartnetwork.atlassian.net")` - the Jira site
       host (the Upstart default per plan decision 9; a bare default keeps the schema
       `{}`-parseable while staying generic).
     - `jql: z.string().max(1000).default("")` - the filter. An empty JQL is a valid stored
       config but an unusable sweep: `sweep` must return
       `{items: [], error: "set a JQL query in the source settings"}` and `preflight` must
       report it, because a source that silently sweeps nothing is the failure mode decision
       9 forbids.
     - `bodyLimit`-style truncation is not config; mirror GitHub's fixed `BODY_LIMIT = 4000`.
     - Optionally `priorityFromJira: z.boolean().default(true)` mapping Jira's priority field
       onto `TASK_PRIORITIES` (map by name, case-insensitive, unmapped -> omit). Keep the
       mapping pure and exported for tests.
   - Add the `"jira"` entry to `TASK_SOURCE_KIND_INFO` (label "Jira", blurb naming what it
     sweeps and that it files backlog rows only).
2. **New `src/server/task-sources/jira.ts`**, mirroring `github-issues.ts`'s structure:
   - Auth model (plan decision 9): default to the `jira` CLI (`ankitpokhrel/jira-cli`) when
     on PATH, authenticated via its standard `JIRA_API_TOKEN` convention; fall back to direct
     Jira REST (`https://<site>/rest/api/3/search` with `jql`) using
     `JIRA_API_TOKEN` + `JIRA_EMAIL` basic auth when the CLI is absent. Both paths read the
     env from the daemon's own process env; nothing is stored.
   - Export the pure seams for tests (the `github-issues-map.test.ts` pattern): the argv
     builder, the REST URL/query builder, `externalIdFor` (issue key), the candidate mapper
     (intent = `Jira issue PROJ-123: <summary>` + browse URL + blank line + description,
     truncated at 4000 chars with a truncation marker), and the result reader that converts
     CLI/REST output into `SweepResult`.
   - `preflight`: report, in order - empty JQL; CLI missing AND env-var fallback unconfigured
     (name both fixes: `brew install ankitpokhrel/jira-cli/jira-cli` or set
     `JIRA_API_TOKEN` + `JIRA_EMAIL`); authentication failure; then a probe query (the real
     JQL bounded to 1 result) to prove the site answers.
   - `sweep`: bounded by `ctx.signal` and a 20s timeout; every failure becomes
     `{items: [], error}` with the first line of stderr/body as the why.
   - Export `export const jira: TaskSourceImpl<JiraConfig> = { ...TASK_SOURCE_KIND_INFO["jira"], configSchema: JiraConfigSchema, preflight, sweep }`.
   - If the REST call needs TLS trust behind the Palo Alto VPN, that is the operator's
     `NODE_EXTRA_CA_CERTS` (documented by Phase 2's README section); do not disable TLS
     verification.
3. **`src/server/task-sources/index.ts`**: import and add `"jira": erase(jira)`.
4. **`src/web/components/TaskSourcesPanel.tsx`**:
   - Add `JiraFields` (site, JQL, the priority toggle) and a `jiraConfigOf` mirroring
     `githubConfigOf` (`:42-48`), plus the second arm beside `:437`.
   - Make the preflight success sentence kind-aware (`:556-562`) - the current text hardcodes
     "gh is reachable and this repo lists issues".
   - Reuse the existing `.ts-*` field classes; no new CSS expected.
5. **Tests** (`node:test` + `node:assert/strict`, flat in `test/`):
   - `test/jira-map.test.ts` in the shape of `test/github-issues-map.test.ts`: pure tests
     over the exported seams, no subprocess. Cover: argv/URL construction, empty-JQL refusal,
     externalId stability, intent content and truncation, priority mapping (mapped, unmapped
     -> omitted, disabled), result reading for non-zero exit / non-JSON / abort / clean-empty.
   - `test/task-source-contract.test.ts` picks the kind up automatically via its
     `for (const kind of TASK_SOURCE_KINDS)` loops - run it and satisfy it, do not modify it
     except where it enumerates expectations per kind.
   - Extend `test/task-sources-panel.test.ts`'s `KINDS` with the jira entry and pin the new
     field group markup.
   - A preflight-behavior test with a fake `jira` binary on PATH (the
     `test/task-source-sweeper.test.ts` / `test/settings-status.test.ts` PATH-prepend
     pattern) asserting the not-installed vs not-authenticated vs cannot-query distinction.
6. **Playwright spec** (`e2e/`, UI change, no exemptions - `AGENTS.md`): a
   `settings-task-sources` spec that opens Settings -> Task sources, adds a Jira source
   through the add control (asserting the kind appears with its blurb), fills the Jira fields,
   saves, and asserts the saved card renders the Jira field group and health chips. Do not
   invoke a real sweep or preflight against a network; if preflight display is asserted,
   intercept the route (`page.route`) the way `line-drawers.spec.ts:329-366` fulfills
   `/api/task-sources/config`. Follow `e2e/README.md` (no `data-testid`, role/label selectors,
   Escape after the repo combobox).
7. **README** (same change): add `### Jira` beside `### GitHub issues` (line ~1873)
   documenting the JQL filter, the CLI-then-REST auth ladder, the env vars, and the same
   broken-credential-never-reads-as-empty guarantee; fix "The first (and so far only) kind"
   (~1875) and the GitHub-specific "Check it works" row (~1864).

## 6. Data / API / migration

None. No migration, no new routes, no `protocol.ts` change. The kind id is append-only once
merged.

## 7. Verification

```sh
npm run typecheck
npm run lint
node --test --test-concurrency=2 --import tsx test/jira-map.test.ts
node --test --test-concurrency=2 --import tsx test/task-source-contract.test.ts
npm test
npm run build && npm run smoke
npm run test:e2e
```

## 8. Merge and exit criteria

- All commands above green; the contract test passes with the new kind unmodified.
- The panel offers Jira in the add control with no hand-kept UI list (server-derived kinds).
- Preflight distinguishes not-installed / not-authenticated / cannot-query / empty-JQL, each
  naming the fix.
- README documents the kind in the same change.

## 9. Downstream handoff

Later phases may rely on: the `jira` kind id (append-only, never renamed), the
`JiraConfigSchema` field names (persisted in operator config blobs; additive changes only),
and the env-var convention (`JIRA_API_TOKEN`, `JIRA_EMAIL`, site default
`upstartnetwork.atlassian.net`). Phase 2's README section links to the Task sources section
generally and does not depend on this phase's text.

## 10. Cross-phase audit record

- 2026-08-05: Initial version. No contracts consumed from other phases; README edits are in
  the Task sources region (~1832-1908), disjoint from Phase 2's regions (~1350-1408,
  ~5459-5697) and Phase 3's region (~2522+), so concurrent merges conflict at worst
  trivially.
