# Phase 1: acli read path

Source plan: `docs/plans/acli-jira-query-method/plan.md`. Index:
`docs/plans/acli-jira-query-method/phased-plan.md`.

## 1. Outcome

An operator can set a Jira task source's **Query via** to **Atlassian CLI (acli)**. With acli
logged in (`acli jira auth login --web`) and no Jira environment variables anywhere, "Check it
works" passes, sweeps file backlog tasks identical to the local method's, and linked reads work.
Every failure is a sentence that names its fix. Write-back on an acli source refuses with one
sentence until Phase 2.

This is the half of issue #1270 that desktop users feel first: the backlog fills from Jira.

## 2. Entry criteria and dependencies

- The planning pull request that adds `docs/plans/acli-jira-query-method/` has merged.
- No earlier implementation phase.
- **Operator prerequisite for step 1:** acli is installed on the machine running this task
  (`acli version 1.3.40-stable`, installed with Homebrew, when this was planned) and logged in
  to the Jira site the operator uses. If `acli jira auth status` exits non-zero when you start,
  ask the operator to run `acli jira auth login --web` (Mission Control `request_input`) and wait;
  do not invent fixtures in place of a capture.

## 3. Scope and non-goals

In scope: the `"acli"` query method value, the binary seam and catalog entry, contract capture,
the acli read module (sweep, preflight, linked reads through sweep), the write-back refusal for
acli sources, the settings option and note, the fake `acli`, tests, and documentation.

Not in scope: posting comments, transitions, or any other write (Phase 2); pushing tasks to Jira;
changing the local or UpstartClaw methods; capturing login-shell environment variables; managing
acli's login from Mission Control.

## 4. Repository findings and inherited contracts

- Dispatch points: `sweep` (`src/server/task-sources/jira.ts:1374`), `preflight` (`:1403`) and
  `writeTarget` (`:1912`) already branch on `cfg.queryVia === "upstartclaw"`. Add the acli branch
  beside it.
- Reusable exported helpers in `jira.ts`: `issuesFrom` (accepts `{issues:[...]}` or a bare array,
  drops non-object rows), `sweepResultFromWalk` (maps through `candidateFrom`), `externalIdFor`,
  `browseUrlFor` (prefers the issue's own `self` host), `siteHost`, `siteProblem`, and the
  `JiraWalk` / `JiraPage` types. `MAX_SWEEP_ISSUES` and `tooBroad` are module-private today;
  export them rather than duplicating them.
- `readLinked` (`jira.ts:2147`) calls `sweep` with a `key in (...)` JQL, so it gains acli support
  without its own change. Its `linkedJiraRefError` compares the ref URL host with the configured
  site; keep that.
- `jiraBin()` (`src/server/config.ts:295`) is the model for `acliBin()`: read per call through
  `envVar`, empty counts as unset, a doc comment explaining that the seam is what tests redirect.
- `EXECUTABLE_IDS` (`src/shared/executables.ts`) is append-only. Append `"acli"` at the end of the
  list as it stands on `main` when you start.
- The fake `jira` (`FAKE_JIRA` in `e2e/fixtures/fake-agents.ts`) is wired as `MISSION_JIRA_BIN`
  in `e2e/fixtures/daemon.ts` and records each call under `MC_E2E_RECORD_DIR`. Mirror both.
- `run` (`src/server/util/exec.ts:103`) never throws, reports `outcomeUnknown` for a killed child,
  and takes `input` for stdin.
- Verified acli failure behaviour (exit 1, empty stdout, stderr):
  `✗ Error: unauthorized: use 'acli jira auth login' to authenticate` (auth status),
  `✗ Error: unauthorized: use 'acli [product] auth login' to authenticate` (search),
  `✗ Error: unknown flag: --bogus`.

## 5. Implementation steps, in order

1. **Capture the contract (read-only, on the operator's logged-in acli).** Run and save sanitized
   stdout, stderr and exit code for:
   - `acli --version`, `acli jira auth status`, `acli auth status`;
   - `acli jira workitem search --jql "<a small real filter>" --fields key,summary,description,priority --json --limit 1`;
   - the same with `--limit 3`, and with `--limit 3 --paginate` against a filter matching more
     than 3 issues (does `--limit` cap the total under `--paginate`, or the page size?);
   - a JQL that matches nothing, and a JQL Jira rejects (for example `project = NOPE_404`);
   - `acli jira workitem view <KEY> --fields status --json` and `--fields "*all" --json` (record
     whether anything resembling transitions appears; Phase 2 needs to know);
   - a search with `--fields self` or the default fields, to learn whether `self` is present.
   Before anything is saved, rewrite every operator value as synthetic data: emails, display
   names, account ids, avatar URLs and token-like values become placeholders; the real site host
   becomes `example.atlassian.net` everywhere it appears (including inside `self` URLs); project
   keys and issue keys become synthetic ones such as `MC-1`, `MC-2`, mapped consistently so a key
   that appears twice still matches itself; summaries and descriptions become neutral text of the
   same shape (a plain string stays a string, an ADF tree stays a tree). Preserve the JSON
   structure, field names, value types and the relationships the tests rely on. The raw captures
   stay in a gitignored scratch location and are never committed; only the rewritten files go
   under `test/fixtures/acli/`, and a final `grep` for the real host and the real project key
   before committing must return nothing. The JQL used for the capture is operator data too:
   fixtures and their README record it rewritten with the synthetic project key, and neither
   contains a local filesystem path, a home directory or a username. Never run `comment`, `transition`, `edit`,
   `create`, `delete`, `assign`, `link create`, or anything without `--help`/`view`/`search`/
   `status` in it. Save the outputs under `test/fixtures/acli/` with a `README.md` naming the acli
   version and each command in its rewritten form. Record in the pull request what the captures established.
2. **Schema.** `queryVia: z.enum(["local", "upstartclaw", "acli"]).default("local")` in
   `src/shared/task-source.ts`. Update the `JiraConfigSchema` doc comment and the kind's `blurb`
   so they name acli.
3. **Seam and catalog.** `acliBin()` in `src/server/config.ts`; `"acli"` appended to
   `EXECUTABLE_IDS`; `acli: spec("acli", "Atlassian CLI", "acli", "ACLI_BIN")` in
   `src/server/executables/catalog.ts`.
4. **Module `src/server/task-sources/jira-acli.ts`.**
   - `acliSearchArgs(cfg, limit)`: `workitem search --jql <jql> --fields key,summary,description,priority --json --limit <n>` plus
     `--paginate` if step 1 shows that is what reaches past one page within the bound. Ask for one
     more than the bound so a tail is detected exactly, as `jiraIssueListArgs` does with
     `limit + 1`.
   - `acliFault(res)` / `acliFailure(res)`: classify from stderr. At least: `no-answer`
     (`outcomeUnknown`), `not-installed` (code 127 or ENOENT), `unauthenticated`
     (`unauthorized`, `auth login`), `unsupported-flag` (`unknown flag`), `refused` (everything
     else, quoting acli's first line with the `✗ Error:` prefix stripped). Each sentence names the
     fix: `brew tap atlassian/homebrew-acli && brew install acli`, `acli jira auth login --web`,
     `brew upgrade acli`.
   - The no-results case: whatever step 1 shows (empty array, empty envelope, or a non-zero exit
     with a "no results" message) must read as an empty, healthy page, never as an error.
   - An output reader that hands the captured shape to `issuesFrom`. If acli flattens Jira's shape,
     adapt it to `{key, self?, fields:{summary, description, priority:{name}}}` here, in one place.
   - `acliActiveSite(res)`: the host acli is logged in to, read from `acli jira auth status`
     output as captured, or `null` when it cannot be established. Exported for Phase 2.
   - `acliSiteGate(cfg, ctx)`: run `acli jira auth status` and return `null` only when
     `acliActiveSite` positively equals `siteHost(cfg.site)`. Otherwise return a sentence: the
     `acliFailure` sentence when the status run fails, "cannot confirm which Jira site acli is
     logged in to" when the site is `null`, and a mismatch sentence naming both hosts and
     `acli jira auth switch` when they differ. acli's active profile can change at any time
     (`acli jira auth switch`, a fresh login), so this gate runs on every acli operation, not once
     at preflight. Exported for Phase 2.
   - `readAcli(cfg, ctx, maxIssues): Promise<JiraWalk>`: run `acliSiteGate` first and return its
     sentence as the walk's `error` (so nothing is filed) when it refuses; then one search,
     `issues` capped at the bound, `advisory: tooBroad(cfg)` when the extra row came back, `error`
     sentence otherwise. As a second check against a profile switch between the gate and the
     search, when the captured search output carries `self` URLs, any issue whose `self` host is
     not the configured site fails the whole walk with the mismatch sentence rather than filing
     part of it. `readLinked` reaches acli only through `sweep`, so it gets both checks.
   - `acliPreflight(cfg, ctx)`: run `acliSiteGate`; on refusal return its sentence. Then run the
     real JQL with a bound of 1 and return its error.
   - Every `run` call passes `input: ""` and a timeout that keeps a whole sweep inside the
     sweeper's 60 s cap (the local method uses 20 s per request).
5. **Dispatch in `jira.ts`.** `sweep` and `preflight` call the acli functions when
   `cfg.queryVia === "acli"`. No fallback to the local ladder. `writeTarget` refuses an acli
   source with a new `ACLI_WRITE_PENDING` sentence that says write-back through acli is not
   available in this build and names the local method as the way to write back today. Phase 2
   deletes this constant.
6. **Settings panel** (`src/web/components/TaskSourcesPanel.tsx`, the Query via select near
   line 388): add `<option value="acli">Atlassian CLI (acli)</option>`, update the select's tooltip,
   and show a short note when acli is selected naming the one-time `acli jira auth login --web`.
   Reuse the existing note styling.
7. **Fake `acli`** in `e2e/fixtures/fake-agents.ts`, modelled on `FAKE_JIRA`: CommonJS, records
   `{argv, cwd}` under `MC_E2E_RECORD_DIR` as `acli-<time>-<pid>.json`, answers `jira auth status`
   with the captured logged-in shape for a fixed fake site, answers `workitem search` from a canned
   response (a spec-controlled file or env var, so one spec can make a sweep file a card), and
   prints `acli version 0.0.0 (fake)` for `--version`. Wire it in `e2e/fixtures/daemon.ts` as
   `MISSION_ACLI_BIN` beside `MISSION_JIRA_BIN`, and add it to the `bins` the fixture returns.
8. **Documentation.** `docs/dispatch-and-backlog.md` Jira section: the new Query via value, how to
   install and log in, the site-match rule, paging behaviour as captured, and that write-back on
   acli arrives later. `docs/configuration.md`: `MISSION_ACLI_BIN`. `docs/upstart.md`: acli as the
   environment-free option for Upstart Jira. No em dashes in prose.

## 6. Data, API and compatibility

- No migration. Stored configs without `queryVia`, or with `"local"`/`"upstartclaw"`, parse and
  behave exactly as before.
- No route changes; `PUT /api/task-sources/config` accepts the new enum value through the schema.
- `EXECUTABLE_IDS` gains one id at the end; nothing is renamed or reordered.
- Mission Control stores no acli credential and never reads acli's keychain entry.

## 7. Tests and verification

- New `test/jira-acli.test.ts`: argv construction (including the probe row), the fault classifier
  against the captured logged-out and unknown-flag stderr, the no-results case, the output reader
  against every captured search fixture, the tail advisory, `acliSiteGate` refusing (status failure, unknown site, mismatched site) in
  preflight and in every sweep with no search spawned and nothing filed, a search result whose
  `self` host differs from the configured site failing the walk, and that
  an acli sweep never touches `jiraBin()` or `JIRA_API_TOKEN` (stub `run` through a seam the
  module exposes, as the UpstartClaw deps do).
- Extend `test/task-source-contract.test.ts` or `test/jira-writeback.test.ts` so an acli source's
  `annotate` and `resolve` return the `ACLI_WRITE_PENDING` refusal with `outcomeUnknown: false`
  and spawn nothing.
- `test/executable-contracts.test.ts`: the new id and spec.
- `test/e2e-fixture-programs.test.ts`: the fake `acli` records its argv and answers search and auth
  status with well-formed output.
- Playwright, extending `e2e/specs/settings-task-sources-jira.spec.ts`: select Atlassian CLI
  (acli), see the login note, "Check it works" passes against the fake, a sweep files a card from
  the fake's canned issue with the expected title and browse link, and an unusable acli (fake
  answering unauthorized) shows the login sentence, and a sweep after the fake's active site is
  switched to another host files nothing and shows the mismatch sentence.
- Commands: the single-file form
  `node --test --import ./test/setup-state.mjs --import tsx test/jira-acli.test.ts` while
  iterating; then `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
  `npm run smoke`, `npm run test:e2e`.
- Runtime check: start the built app or daemon without Jira environment variables, configure an
  acli source against the operator's real site, press "Check it works" and run one sweep (reads
  only). Attach the screenshot and the outcome to the pull request, not to the repository.

## 8. Merge and exit criteria

- Source plan acceptance criteria 1, 2, 3, 5 and 6 hold for the read path.
- An acli source's write-back refuses with `ACLI_WRITE_PENDING`, spawning nothing.
- Fixtures under `test/fixtures/acli/` contain only synthetic hosts, keys and people (no value
  from the operator's real site), and their `README.md` names the acli version and commands.
- Every acli sweep, preflight and linked read runs `acliSiteGate` before it searches, and files
  nothing when the active site cannot be proven to be the configured one.
- All commands in section 7 pass; the pull request records what the capture established,
  especially the `--paginate`/`--limit` semantics, whether `self` is present, the `auth status`
  site format, and whether `view --fields "*all"` exposes transitions.

## 9. Downstream handoff

Phase 2 may rely on, and must not rename or reshape: the `"acli"` enum value and option label;
`acliBin()` and the `"acli"` executable id; `jira-acli.ts` and its exported `acliFault`,
`acliFailure`, `acliActiveSite` and `acliSiteGate`; the fixture directory and its README; the fake `acli`, its
record format and its `MISSION_ACLI_BIN` wiring; the empty-stdin rule. Phase 2 removes
`ACLI_WRITE_PENDING` and replaces the refusal with real write-back.

## 10. Cross-phase audit record

- Written first. The site-identity reader and the site gate are placed here, not in Phase 2,
  because every read needs them and Phase 2's writes need the same answer; one owner prevents two
  parsers of `auth status` and two definitions of "the right site".
- Review round 1 (Inspector, PR #1282): the site check moved from preflight-only to every sweep
  and linked read, because acli's active profile can change after preflight and a sweep would
  otherwise file another site's issues; and fixtures became fully synthetic, because real keys
  and hosts are operator data.
- Review round 2 (CodeRabbit, PR #1282): the capture JQL and local paths are named as operator data
  too, so neither the fixtures nor their README carries them.
- The `view --fields "*all"` capture is placed here because Phase 2's resolve contract depends on
  its result and Phase 2 has no logged-in capture step of its own.
