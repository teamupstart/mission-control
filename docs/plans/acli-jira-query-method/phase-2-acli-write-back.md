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
  `src/server/task-sources/jira-acli.ts` with `acliFault`, `acliFailure`, `acliActiveSite` and
  `acliSiteGate`,
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

1. **Write site gate, and a check after every write.** acli 1.3.40 cannot bind a single
   command to a site or profile: `workitem comment create`, `workitem transition` and
   `workitem view` take no `--site` or profile flag, and `acli --help` has no global one
   (verified from `--help`). The active login can therefore change between any check and the
   write that follows it, and no pre-check can close that window. The write path narrows it and
   makes a hit visible instead of silent:
   - Reuse Phase 1's `acliSiteGate` immediately before every write (comment,
     view-then-transition), never a cached answer from an earlier sweep or preflight. Its refusal
     becomes a write-back refusal with "so nothing was written" appended, `outcomeUnknown:
     false`, and nothing that can mutate has been spawned.
   - Before a transition, the `view` read in step 4 also proves the issue is on the configured
     site: a `self` host in its output that is not the configured site refuses the resolve.
   - After every write, run `acliSiteGate` again, and read the `self` host from the write's own
     `--json` output where it carries one. If either shows another site, report the delivery as
     `outcomeUnknown: true`, naming both sites and the issue key, so the ledger never retries it
     and the operator is told to check both sites. A write is reported delivered only when both
     agree with the configured site.
   - If a later acli release adds a per-command site or profile selector, pass the configured
     site through it on every command and keep the checks above as a second line.
2. **Comment.** `acliCommentArgs(key, notice)`:
   `workitem comment create --key <KEY> --body <JSON.stringify(commentBodyAdf(notice))>`. If argv
   size is a concern for long outcomes, use `--body-file` with a private temp file that is removed
   afterwards. Success is exit 0. Failure goes through `acliFault`: `no-answer` is
   `outcomeUnknown: true` with `UNKNOWN_OUTCOME`; anything else is a refusal quoting acli.
3. **Annotate.** `acliAnnotate(cfg, notice)`: `writeTarget` checks, then the gate. On acli the
   comment is ALWAYS posted, whatever `cfg.linkVia` says, because it is the only place the pull
   request link can go (adopted decision: report the remote link as unavailable and still post
   the comment). Then by `cfg.linkVia`: `comment` posts the comment and nothing else; `both` and
   `remote-link` post the comment and add the remote link to `unavailable` with a sentence saying
   acli cannot post a remote link and that the comment carries the pull request link. The result
   follows `annotate`'s existing done/idle/unavailable shape: a posted comment is a delivery
   (`commented; the remote link ...unavailable...`), and only a failed comment is a refusal or an
   unknown outcome. So a `linkVia: "remote-link"` source on acli delivers the comment instead of
   refusing with nothing written, and the ledger does not retry it. With no pull request URL
   there is still a comment to post (the finish notice); the remote link is then `idle`, exactly
   as `annotate` treats it today.
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
   - run `workitem transition --key <KEY> --status <wanted> --yes --json`. `--json` ("Generate a
     JSON output") is verified in acli 1.3.40's `workitem transition --help`; its output shape is
     not, because capturing it would mean moving a real issue. So exit 0 alone is never success:
     - parse the `--json` output for a per-issue result for `<KEY>`; one that reports failure, or
       an error field, is a refusal quoting it, even when the exit code is 0;
     - then read the status again with `workitem view <KEY> --fields status --json`. Only that read
       showing `<wanted>` returns `moved to "<wanted>"`. Showing any other status is a refusal that
       names it and quotes acli's reason, `outcomeUnknown: false`, since the issue verifiably did
       not move. A failed confirming read is `outcomeUnknown: true`, because the move may have
       happened;
     - `no-answer` from the transition itself is `outcomeUnknown: true`. Any other non-zero exit is
       a refusal that names the issue's current status and quotes acli's own reason (which may
       list the reachable statuses): for example `MC-12 cannot move to "Done" from "In Review" -
       acli said: <reason>. Set this source's resolve status to one the issue can reach`. Never
       retry on another rung.
     The fake models every branch: exit 0 with a per-issue failure in its JSON, exit 0 with JSON
     the parser does not recognise, exit 0 where the confirming read still shows the old status,
     and exit 0 where the confirming read fails.
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
  with `linkVia` `comment` (comment only), `both` and `remote-link` (comment posted AND the
  remote link reported unavailable, a delivery rather than a refusal); the gate refuses on failed status, unknown
  site and mismatched site without spawning comment or transition; resolve already-there, moved,
  refused (current status and acli's reason in the sentence), `no-answer` as `outcomeUnknown`,
  failed status read as a refusal, empty target refused first; transition exit 0 with a per-issue
  failure in its `--json` output is a refusal; exit 0 is `moved` only when the confirming status
  read shows the target, a confirming read showing the old status is a refusal, and a failed
  confirming read is `outcomeUnknown`; a post-write site check or `self` host showing another site
  turns a delivered write into `outcomeUnknown` naming both sites; the transition probe path,
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
  `acliActiveSite`, `acliSiteGate`, the fixtures, the fake and the empty-stdin rule without renaming them; removes
  `ACLI_WRITE_PENDING` as Phase 1 specified.
- The transition probe depends on a Phase 1 capture result rather than a Phase 2 capture, because
  this phase forbids live acli runs that could write and the probe's evidence is a read Phase 1
  already performs.
- No concurrency with Phase 1: this phase edits the same module, fake and panel.
- Review round 1 (Inspector, PR #1282): the write gate now reuses Phase 1's `acliSiteGate`
  instead of defining its own, since the site check became a Phase 1 contract for every read.
- Review round 2 (Inspector and CodeRabbit, PR #1282): the transition runs with `--json` and is
  confirmed by a second status read before it counts as a move, because acli may exit 0 for a
  per-issue failure; and every write is followed by a site re-check, because acli 1.3.40 has no
  per-command site selector that could bind the write to the checked site.
- Review round 4 (Inspector, PR #1282): a `remote-link` source on acli posts the comment and
  reports the remote link unavailable instead of refusing, matching the adopted decision and this
  phase's outcome.
