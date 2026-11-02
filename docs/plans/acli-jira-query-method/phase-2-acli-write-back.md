# Phase 2: acli write-back

Source plan: `docs/plans/acli-jira-query-method/plan.md`. Index:
`docs/plans/acli-jira-query-method/phased-plan.md`. Prerequisite phase:
`docs/plans/acli-jira-query-method/phase-1-acli-read-path.md`.

## 1. Outcome

A Jira source on **Atlassian CLI (acli)** writes back like a local one, with no environment
variables: when a task opens a pull request or finishes, the issue gets the Mission Control
comment with a clickable pull request link, and when resolve is on, the issue moves to the
configured status. A requested remote link is reported as unavailable because acli has none. No
write is ever attempted unless acli is provably logged in to the source's configured site.

## 2. Entry criteria and dependencies

- Phase 1 has merged: the `"acli"` query method, `acliBin()`, the `"acli"` executable id,
  `src/server/task-sources/jira-acli.ts` with `acliFault`, `acliFailure` and `acliActiveSite`,
  the captured fixtures under `test/fixtures/acli/`, and the fake `acli` wired as
  `MISSION_ACLI_BIN`.
- Read Phase 1's pull request for what the capture established, in particular the `auth status`
  site format and whether `view --fields "*all" --json` exposes transitions.

## 3. Scope and non-goals

In scope: acli `annotate` (comment, remote link reported unavailable) and `resolve` (status read,
transition probe, transition), the write site gate, removal of `ACLI_WRITE_PENDING`, the panel's
remote-link note, fake `acli` write handling, tests, and documentation.

Not in scope: changing the read path's contracts; pushing tasks to Jira; any change to the local
or UpstartClaw write paths; any fallback from acli to `jira` or `JIRA_API_TOKEN` (adopted
decision: none).

**Never run an acli write command against a real Jira site** - not to test, not to capture. Writes
are exercised only against the fake. The operator verifies one real write after merge.

## 4. Repository findings and inherited contracts

- Write-back verbs in `src/server/task-sources/jira.ts`: `writeTarget` (`:1912`), `annotate`
  (`:1974`), `resolve` (`:2093`). Their rules carry over unchanged: the key is validated by
  `issueKeyFor`; a run that died without an answer is `outcomeUnknown: true` and never retried
  automatically (`cliWritebackFailure`); a refusal is `outcomeUnknown: false`; "already there" is
  success (`restResolve`); nothing to do is a delivery, nothing possible is a refusal (`annotate`'s
  tail).
- Reusable: `commentBodyAdf`, `commentBodyText`, `writebackBlocks`, `transitionFor`,
  `currentStatusFrom`, `writebackDone`/`writebackRefusal` (export the two helpers if needed rather
  than copying them), `UNKNOWN_OUTCOME`.
- The CLI-only local path already reports an impossible remote link as unavailable with the
  comment still posted (`jira.ts:1989-2031`); reuse that shape and wording style.
- `TASK_SOURCE_KIND_INFO.jira` already declares `canAnnotate` and `canResolve`; no flag changes.
- Verified acli 1.3.40 commands: `workitem comment create --key <KEY> --body <text or ADF>`;
  `workitem view <KEY> --fields <list> --json`; `workitem transition --key <KEY> --status <name>
  --yes`; there is no remote-link command (`link create` is `--out/--in/--type`, issue-to-issue).

## 5. Implementation steps, in order

1. **Write site gate.** In `jira-acli.ts`, `acliWriteGate(cfg)`: run `acli jira auth status`;
   refuse with the `acliFailure` sentence when it fails; refuse when `acliActiveSite` returns
   `null` ("cannot confirm which Jira site acli is logged in to, so nothing was written"); refuse
   when it differs from `siteHost(cfg.site)`, naming both hosts and `acli jira auth switch`. Every
   refusal here is `outcomeUnknown: false`, and nothing that can mutate has been spawned.
2. **Comment.** `acliCommentArgs(key, notice)`:
   `workitem comment create --key <KEY> --body <JSON.stringify(commentBodyAdf(notice))>`. If argv
   size is a concern for long outcomes, use `--body-file` with a private temp file that is removed
   afterwards. Success is exit 0. Failure goes through `acliFault`: `no-answer` is
   `outcomeUnknown: true` with `UNKNOWN_OUTCOME`; anything else is a refusal quoting acli.
3. **Annotate.** `acliAnnotate(cfg, notice)`: `writeTarget` checks, then the gate, then by
   `cfg.linkVia`: a wanted remote link is pushed to `unavailable` with a sentence saying acli
   cannot post a remote link and that the comment carries the pull request link; a wanted comment
   is posted. Return values follow `annotate`'s existing done/idle/unavailable rules exactly, so a
   `linkVia: "remote-link"` source on acli is a refusal ("nothing could be written") rather than a
   silent success.
4. **Resolve.** `acliResolve(cfg, notice)`:
   - empty `resolveTransition` refuses first (`NO_TARGET_STATUS`), then `writeTarget`, then the
     gate;
   - read the current status with `workitem view <KEY> --fields status --json` and
     `currentStatusFrom` (adapting the captured envelope if needed); already there is
     `writebackDone(already "<status>")`; a failed read is a refusal, never `outcomeUnknown`;
   - **transition probe** (adopted decision): if Phase 1 found transitions in
     `view --fields "*all" --json`, read them and use `transitionFor` so an unreachable target is
     refused with the reachable list before anything moves, and the transition is requested by the
     matched name. If Phase 1 found none, skip the probe;
   - run `workitem transition --key <KEY> --status <wanted> --yes`. Exit 0 is
     `moved to "<wanted>"`. `no-answer` is `outcomeUnknown: true`. Any other failure is a refusal
     that names the issue's current status and quotes acli's own reason (which may list the
     reachable statuses): for example `MC-12 cannot move to "Done" from "In Review" - acli said:
     <reason>. Set this source's resolve status to one the issue can reach`. Never retry on another
     rung.
   - Note `transition --json` exists; if its output reports per-key failure while exiting 0, treat
     that as a refusal. Model this in the fake and test it.
5. **Dispatch in `jira.ts`.** `annotate` and `resolve` call the acli functions when
   `cfg.queryVia === "acli"`. Delete `ACLI_WRITE_PENDING` and its branch in `writeTarget`. The
   local path's `writeRungs`, `RESOLVE_NEEDS_READ` and REST code stay as they are.
6. **Settings panel** (`src/web/components/TaskSourcesPanel.tsx`, the Link via select near line
   626): when Query via is acli and Link via is not "Comment", show a note that acli cannot post a
   remote link and the comment carries the pull request link. Remove any Phase 1 copy that says
   write-back through acli is unavailable.
7. **Fake `acli`.** Extend the Phase 1 fake: `workitem comment create` and `workitem transition`
   record and print success by default; `workitem view` answers with a canned status in the
   captured shape; a spec-controlled switch makes `transition` refuse with an acli-style
   `✗ Error:` line and makes `auth status` report a different site.
8. **Documentation.** `docs/dispatch-and-backlog.md` Jira write-back: what acli sources write, the
   remote-link limitation, the site gate, and the resolve refusal wording. Remove the Phase 1
   "arrives later" text. No em dashes in prose.

## 6. Data, API and compatibility

- No schema, migration, route or capability-flag changes.
- Local and UpstartClaw write-back behaviour is byte-for-byte unchanged; the existing
  `test/jira-writeback.test.ts` cases must pass untouched.
- The write-back ledger's retry rules are unchanged: only `outcomeUnknown: false` failures are
  retried automatically.

## 7. Tests and verification

- `test/jira-acli.test.ts` (extend): comment argv carries valid ADF with the link mark; annotate
  with `linkVia` both / comment / remote-link (refusal); the gate refuses on failed status, unknown
  site and mismatched site without spawning comment or transition; resolve already-there, moved,
  refused (current status and acli's reason in the sentence), `no-answer` as `outcomeUnknown`,
  failed status read as a refusal, empty target refused first; the transition probe path,
  exercised against a fixture with transitions even if the real capture had none, so the code path
  is covered either way.
- `test/task-source-writeback.test.ts` / `test/task-source-writeback-e2e.test.ts`: an acli source's
  delivery passes through the ledger with the same retry semantics.
- `test/e2e-fixture-programs.test.ts`: the fake's write verbs record argv and honour the refusal
  switch.
- Playwright, extending `e2e/specs/task-source-writeback.spec.ts`: an acli source with write-back on
  delivers a comment and a move recorded by the fake; a refused move shows the sentence naming the
  current status; the remote-link note appears when Query via is acli and Link via is not
  "Comment".
- Commands: single-file runs while iterating, then `npm run typecheck`, `npm run lint`,
  `npm test`, `npm run build`, `npm run smoke`, `npm run test:e2e`.

## 8. Merge and exit criteria

- Source plan acceptance criteria 4, 5 and 6 hold; together with Phase 1, all six hold.
- `ACLI_WRITE_PENDING` no longer exists.
- No code path can spawn an acli write before the site gate passes, and no test can reach a real
  `acli`.
- The pull request states whether the transition probe is active (Phase 1 found transitions) or
  skipped, and asks the operator to verify one real comment and move on a test issue after merge.

## 9. Downstream handoff

This is the last phase. The final state matches the source plan with no deferred cleanup. A future
acli release that adds remote links would extend `acliAnnotate` behind the same gate and fake.

## 10. Cross-phase audit record

- Checked against Phase 1's handoff: consumes `acliBin`, `acliFault`, `acliFailure`,
  `acliActiveSite`, the fixtures, the fake and the empty-stdin rule without renaming them; removes
  `ACLI_WRITE_PENDING` as Phase 1 specified.
- The transition probe depends on a Phase 1 capture result rather than a Phase 2 capture, because
  this phase forbids live acli runs that could write and the probe's evidence is a read Phase 1
  already performs.
- No concurrency with Phase 1: this phase edits the same module, fake and panel.
