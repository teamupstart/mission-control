# Run Inspector rounds locally, before the pull request

Status: Decisions D1 to D4 were adopted by the operator on 2026-11-23, together with
requirement R1 and goal R2. Approval is recorded by Mission Control against the exact revision,
not in this file.

This is an analysis and options plan. Nothing in it is implemented.
Measured on 2026-11-20 and 2026-11-21 against `main` at `9f4db6308` and this machine's
Inspector ledger.

## Summary

You asked three things: how workflow Personas and Inspector differ, what the options are for
moving Inspector's rounds into the workflow, and what a "local only" setting would take. In
review you then asked how to include worktree read access for the Persona judges and a new
Inspector judge.

1. **The difference you named is real in the code but not on this installation.** On Claude,
   Inspector gets `Read`, `Grep` and `Glob` in the session worktree and Personas get no tools.
   Your Inspector has run on Codex since 2026-09-15, and Codex gets no tools at all. All 1,143
   review calls recorded since 2026-09-22 read the diff in the prompt and nothing else.
   Worktree access is not what separates your Inspector from your Personas today.
2. **What separates them is the loop, not the reader.** Inspector keeps a findings ledger in
   which any open finding blocks, reviews the whole diff from scratch on every push, never
   keeps a pass, and may run 100 rounds. A Persona returns one pass or fail and keeps a pass
   for the rest of the run. And an Inspector round can only start from a pushed head, so every
   round costs a push and a full CI run.
3. **A setting that only stops the GitHub comments already exists and saves no CI.** That is
   Dry run. Comments do not burn CI. The push each repair needs does. The setting that solves
   the problem changes what a review starts from (the local snapshot, before the push), not
   where its output goes.
4. **Adopted: Option A, a Local Inspector stage.** Run the same Inspector review (same brief,
   prompt, model setting and finding fingerprints) as a new workflow stage placed
   before the Pull Request action, on the Command-stage machinery that the Local CodeRabbit
   Command already established. One new Inspector setting turns it on. The review moves: the
   step after the pull request stops reviewing and only checks that what was pushed is what
   was reviewed. That new stage is the Inspector judge.
5. **Read access is a separate lever, and it is in the plan.** It makes reviewers more thorough.
   It does not make rounds fewer: the one comparison the ledger holds shows more findings with
   read tools and the same number of rounds. Local rounds are what make that thoroughness
   affordable. The Local Inspector always reads the whole submitted worktree (requirement R1),
   and every other Persona-based reviewer can be given the same access (goal R2).
6. **Order of work: repository access first.** You chose to give Codex and Claude reviewers
   repository access together, through the repository MCP server of the approved
   repository-access plan, before the Local Inspector is built on it. Your judges and Inspector
   stay on `gpt-6-sol`. The cost is time: the CI saving that started this plan arrives at
   Phase 5, after that plan's three phases.

## The problem, measured

`teamupstart/mission-control`, pull requests adopted from 2026-09-22 to 2026-11-20:

| Measure | Value |
| --- | --- |
| Pull requests Inspector reviewed | 245 |
| Review rounds | 1,060 (mean 4.3, median 3, maximum 22) |
| Rounds after the first | 815 |
| Pull requests with 5 or more rounds | 86 (35%) |
| Pull requests with 8 or more rounds | 41 (17%), holding 495 rounds, 47% of all rounds |
| Findings recorded | about 500 on 125 pull requests: 9 blocker, 301 major, 190 minor |
| Findings raised or re-raised in round 2 or later | 376 (75%) |
| Findings raised or re-raised in round 4 or later | 264 (53%) |
| CI per push | 88 jobs, 217 to 226 job-minutes (two sampled runs) |
| Inspector rounds against CI runs, five sampled pull requests | 6/6, 8/9, 6/6, 5/5, 6/6 |
| Estimated CI spent on rounds after the first | about 815 runs x 220 job-minutes = 180,000 job-minutes (3,000 job-hours) |

The last row is an estimate. It assumes every round after the first followed a push whose CI
ran to completion, which the five sampled pull requests support.

Two readings matter for the design:

- **One Inspector round is one push is one CI run.** The sample is one to one.
- **Rounds do not converge on a fixed list.** Three quarters of findings arrive after the first
  review. Each push is reviewed from scratch and usually turns up something new, so the gate
  ends only when a full fresh review happens to return nothing. Moving rounds local makes each
  one cheap. It does not by itself make them fewer. Decision D3 is the lever for that.

## How workflow Personas and Inspector differ

| Aspect | Workflow Persona | GitHub Inspector |
| --- | --- | --- |
| When it runs | On each workflow submission, before the pull request exists | After the pull request exists, on every pushed head, found by a 90 second poll |
| What it reviews | An immutable local snapshot: the branch diff, including uncommitted and untracked work | The diff GitHub serves for the pushed head |
| Repository access | None. The prompt is everything it sees (`src/server/workflows/engine.ts:1226` passes no tool grant) | Claude: `Read`, `Grep`, `Glob` in the session worktree, with deny paths. Codex: none (`src/server/llm/codex.ts:471`, `sandbox: null`; it runs in a temp directory with the shell tool off) |
| Context | Human goal, decisions, acceptance criteria, steering, transcript, upstream Command results, registered evidence and images, repository standards, earlier Persona feedback | `INSPECTOR.md` brief, repository standards (`CLAUDE.md`, `AGENTS.md`, memory index), the pull request title and description, its own open findings |
| Guidance | Persona Markdown frozen into the published workflow version | `INSPECTOR.md` from the reviewed repository, read fresh every round |
| Output | One verdict: pass, or fail with requested changes and evidence quotes | A findings list (path, line, severity, title, body) plus the fingerprints it declares resolved |
| Memory across rounds | A pass is kept for the rest of the run (`skipPassedJudges`) unless the node sets Recheck after repairs. Earlier feedback is history only | A fingerprinted ledger (`inspector_comments`). A finding stays open until a later round names it resolved. Nothing is ever "passed" |
| What ends the loop | Every judge has passed once | A fresh review of the current head returns nothing new and every earlier finding is resolved, minor ones included |
| Round limit | Maximum repair rounds, default 5, up to 20 | 100 reviews per pull request. Gate repairs also draw on the run's repair rounds |
| Cost of one more round | Model calls for the judges that have not passed | A push, a full CI run, GitHub API calls, the poll wait, and the model call |
| Side effects | None outside Mission Control | Live: review comments, replies, thread resolution, a safe-to-merge comment. Dry run: nothing posted |
| Model | Per node. Built-ins pin Codex `gpt-6-sol` | Settings > Models. Yours is Codex `gpt-6-sol` |
| What depends on it | The Pull Request action waits for it | The Inspector completion gate (No-Mistakes version 18 onward), Shipping (needs a Live published review of the exact head), the session chip, Foreman relay |

Three consequences:

- **On this installation the two reviewers have the same reader**: the same model, seeing only
  a diff. Inspector's extra findings come from a different brief, an itemized output in which
  any item blocks, and a fresh sample on every push.
- **Observation is separate from review.** The Inspector worker is also the only thing that
  reads adopted pull requests from GitHub (state, head, checks, CodeRabbit follow-up, stacks,
  Shipping). A local review replaces none of that, so the worker stays.
- **On Claude the remote review is less exact than it looks.** Its tools read the live session
  worktree (`liveDir`, `src/server/inspector/worker.ts:375`), which can be ahead of the pushed
  head it is reviewing. A local stage that reads the submission's own captured checkout reads
  exactly what it judges.

## What already exists that this builds on

- **Local CodeRabbit Command** (No-Mistakes version 22, `src/server/workflows/coderabbit.ts`).
  A third-party reviewer running as a Command stage before the Personas, against the review
  snapshot commit, with retained and paged findings, a per-run allowance of 10, a severity
  threshold, and block-or-skip policies. It is the shape a Local Inspector needs. The slot
  registry (`WORKFLOW_CHECK_SLOTS`, `WORKFLOW_COMMAND_INTERPRETERS` in `src/shared/workflow.ts`)
  is the sanctioned extension point.
- **Review snapshot and publication tree.** An uncommitted submission is reviewed as a commit
  of exactly the captured content. The Inspector gate and the Pull Request action already
  compare the pull request head's Git tree with it.
- **Dry run.** Inspector already reviews without posting and relays findings to the session.
- **The Inspector review core.** `buildReviewPrompt` (`src/server/inspector/prompt.ts`),
  `planReview` (`src/server/inspector/verdict.ts`) and the findings text renderer
  (`src/server/inspector/findings-text.ts`) do not depend on GitHub. Only the diff fetch, the
  pull request title and body, line anchoring and posting do.
- **The sandboxed read grant.** `LlmRunner.sandbox` (`src/shared/llm.ts`) and the Inspector's
  `REVIEW_TOOLS` and `DENY_PATHS` (`src/server/inspector/worker.ts`) already give a Claude
  review `Read`, `Grep` and `Glob` in one directory with secret paths denied. Codex cannot
  take that grant, which is why D4 does not build on it.
- **The earlier plan** `docs/plans/pre-pr-inspector/plan.md` (August 2026) chose a Code Quality
  Judge Persona. Versions 9 to 17 ran without the Inspector gate. Version 18 (#1043) restored
  it for the High Rigor preset. This plan is that plan's Option C, now far cheaper because of
  the items above.
- **Persona repository access** (`docs/plans/persona-repository-access/plan.md`, with
  `phased-plan.md` and three phase files beside it) was approved in September 2026 and is not
  present in `src/`. Under D4 its three phases are Phases 1 to 3 of this plan.

## Flow change

Today, every Inspector round is a push:

```mermaid
flowchart LR
  S[Session] --> W[Commands and Personas, local]
  W --> P[Pull Request action: push]
  P --> G[GitHub: pull request head, CI 88 jobs]
  G --> I[GitHub Inspector reviews the pushed head]
  I -->|findings typed into the session| S
  S -->|repair push, every round| G
  I -->|clean| C[Workflow complete]
```

With Option A, the rounds happen before the push:

```mermaid
flowchart LR
  S[Session] --> W[Commands and Personas, local]
  W --> L[Local Inspector stage]
  L -->|findings: repair locally, resubmit, no push| S
  L -->|pass| P[Pull Request action: push once]
  P --> G[GitHub: pull request head, CI once]
  G --> O[Inspector worker observes, posts nothing]
  O -->|head tree equals reviewed tree| C[Workflow complete]
```

### Stage order, before and after

The Inspector review does not stay where it is. It moves from after the pull request to a new
stage before it.

| Order | No-Mistakes version 22, today | Version 23, proposed |
| --- | --- | --- |
| 1 | Typecheck, test, lint | Same |
| 2 | CodeRabbit, when the repository enables it | Same |
| 3 | Intent Conformance, Test Coverage | Same |
| 4 | Code Risk, Code Quality, Code Design | Same |
| 5 | Test Evidence, Documentation, Slop Filter | Same |
| 6 | Pull Request action: push | **Local Inspector, a new stage.** It reviews the local snapshot. Findings return to the session, which repairs and resubmits without pushing. Every Inspector round happens here |
| 7 | After the pull request: GitHub Inspector reviews the pushed head. Each finding means repair, push, CI, and another review | Pull Request action: one push, one CI run |
| 8 | None | After the pull request: no review. A check confirms that the pushed content is the content stage 6 passed |

## Approach adopted, and the alternatives considered

**Adopted (D1): Option A, a Local Inspector stage.** Run the real Inspector review as a workflow
stage before the Pull Request action, and let a setting tell the GitHub worker to skip heads
that stage already reviewed. Each round costs one model call and no CI, and a converged change
is pushed once. It does not by itself reduce the number of rounds. D3 does that.

Not adopted:

- **Option B, an Inspector Persona with no new runtime.** One small pull request, but it is a
  third code-review Persona and not the Inspector: no findings ledger, severity, fingerprints,
  or per-repository `INSPECTOR.md` read fresh. Versions 9 to 17 already ran this shape.
- **Option C, keep the rounds on GitHub and make CI skip draft pull requests.** Almost no
  product work, but it edits every repository's CI configuration, makes rounds no faster, and
  surfaces CI failures only after Inspector converges.

**Option D, Persona repository access first, is adopted as the foundation and not as a
substitute.** Alone it would leave the GitHub rounds where they are. Under D4 it is built
first, and Option A is built on it.

## Design (Option A)

### 1. A review core that accepts a local subject

Extract from `reviewRound` (`src/server/inspector/worker.ts`) the part that does not need
GitHub: brief, standards, prompt, runner options, verdict parsing, and planning. Feed it:

| Input | GitHub review today | Local review |
| --- | --- | --- |
| Diff | `gh api` pull request diff | `git diff <merge-base> <review snapshot commit>`, same byte cap |
| Base | The pull request's base | The base ref resolution CodeRabbit already uses, frozen per submission |
| Title and description | Pull request title and body | The run's captured goal, fenced as untrusted, same cap |
| Brief and standards | `readBrief`, `readStandards` | The same calls |
| Open findings | Ledger rows for the pull request | Unresolved findings of this stage's previous attempt in the same run |
| Tools | Claude: read tools in the session worktree. Codex: none | Always, on Codex or Claude: repository read, search, glob and Git queries over the whole submitted worktree, through the repository MCP server (requirement R1) |
| Output | Posted or drafted comments | Findings retained on the attempt. Nothing posted |

The output schema, fingerprints, secret scrubber and the rule that a finding must name a
changed file all stay. The policy text changes one sentence: findings go to the author's
session rather than to public comments. Spend is recorded under the existing
`inspector:review` role.

**Requirement R1, set by the operator on 2026-11-23: the Local Inspector has read access to
the whole submitted worktree. It is never limited to the diff.** Every local review can read,
search and glob the complete submitted checkout and query its Git status, diff, log, show and
blame. That checkout is the submission's exact-state repository artifact: committed, staged
and unstaged content, plus untracked files Git does not ignore. The repository policy's
sensitive-path protections apply and are at least as strong as the Inspector's deny paths
today. There is no diff-only mode. If a review cannot be given that access, the stage does
not review. It blocks for the operator and says why. It never falls back to the prompt alone,
and it never passes without having had the access.

How R1 is met (D4): the access comes from the repository MCP server of the approved
repository-access plan, which gives Codex and Claude the same operations, limits and denials.
The Local Inspector therefore keeps the Inspector's existing provider and model setting, which
is Codex `gpt-6-sol` on this installation, and gets no model row of its own. It does not use
the Claude-only read grant. The stage cannot be enabled before Phases 1 to 3 have landed.

### 2. An `inspector` Command slot: the Local Inspector

Append `inspector` to `WORKFLOW_CHECK_SLOTS` with its own interpreter, owned like `coderabbit`
(no editable argv). In Library > Commands it carries an allowance per run (default 10), a
timeout (default 10 minutes, the Inspector's own), the exhaustion policy (default Block for
operator action), and the blocking severity (D3: major and above by default, so minor and nit
findings are reported without blocking).

- **Passes** when the review returns no blocking finding and every earlier blocking finding is
  resolved.
- **Fails** with a repair packet that lists each unresolved finding in full (severity, path and
  line, title, body), rendered by the existing findings text renderer. The session repairs
  locally and the next submission is reviewed. Nothing is pushed.
- **Skips with a note** when Local review is off, Inspector is off, or the repository lacks the
  Commands consent every Command already needs.
- **Blocks for the operator** on a provider failure, an oversize diff, or repository access
  being unavailable (requirement R1). None of these spends a repair round or sends a code-fix
  packet.
- **A spent allowance follows the slot's exhaustion policy.** The default, Block, blocks for
  the operator. Skip skips the stage with a note, and a skipped stage keeps the GitHub review.

Findings are retained as the attempt's normalized findings, read through the existing Load
findings control and `read_workflow_command_output`.

Why a Command stage and nothing else:

- Not a Persona: the Persona path has no findings ledger, severity or fingerprints, and its
  guidance is frozen at publish, while `INSPECTOR.md` belongs to the reviewed repository.
- Not a new node kind: every graph surface (schema, validation, editor, pipeline view, run
  detail, export) would need it. The `check` wire kind already carries one reviewer.
- Not the completion policy: it runs after End, which is after the Pull Request action.

### 3. One setting: review in the workflow before the pull request

Add a boolean to the Inspector config, `localReview`, default off. It lives in the existing
`inspector` config blob, so it needs no migration. Settings > GitHub Inspector shows it as
**Review in the workflow before the pull request opens**. It combines with the existing mode:

| Setting | Before the pull request | After the pull request |
| --- | --- | --- |
| Local review off (today) | Nothing | Every pushed head is reviewed on GitHub. Live posts, Dry run records |
| Local review on, Dry run | Local Inspector rounds | Heads matching a local pass: nothing. Other heads: reviewed, never posted. Nothing merges. This is "local only, no GitHub comments" |
| Local review on, Live | Local Inspector rounds | Heads matching a local pass: nothing. Other heads: reviewed and posted as today |

"Other heads" are later pushes whose content differs from what was reviewed locally (CI
repairs, conflict merges, branch updates), pull requests from workflow versions without the
stage, and pull requests opened outside a workflow. They keep the path they have today, so no
pull request silently loses review and no in-flight run is stranded when the setting flips.

The whole feature sits behind a preview feature flag, per `docs/feature-flags.md`. With the
flag off the control is hidden and the stored value reads as off.

### 4. A new built-in version, with the review moved before the pull request

No-Mistakes Review version 23 is version 22 plus one evaluation stage holding the Local
Inspector, placed last before the Pull Request action, so it reviews content every other
reviewer has already accepted. See "Stage order, before and after".

With Local review on, the review no longer happens after the pull request. Version 23 keeps
the `inspector` completion policy for two reasons only: so the step after the pull request can
run the check in item 5, and so that with Local review off the new stage skips with a note and
version 23 behaves exactly as version 22. That makes it safe as the current version for every
installation. Existing bindings keep their pinned version.

### 5. After the pull request: a check, not a review

With Local review on, the Inspector completion gate is satisfied when both hold:

1. the submission's Local Inspector attempt **passed** (not skipped) on publication tree T; and
2. the adopted, open pull request's head has Git tree T, the comparison the gate and the Pull
   Request action already make.

No remote model call and no comment. The step stays for two reasons:

- **Proof of what was pushed.** It catches a session that commits something different between
  the local pass and the push.
- **Fallback.** A run whose stage was skipped, or whose pinned version has no stage, keeps the
  GitHub review path it has today, and the gate says which path it is on.

Alternative, not proposed: give version 23 no step after the pull request at all
(`completionPolicy: none`, as versions 9 to 17 had). The run would then complete when the pull
request opens. Nothing would confirm that the pushed content is the reviewed content, and with
Local review off the version would lose the GitHub gate version 22 has.

### 6. The GitHub worker skips what was reviewed locally

The worker still sweeps every adopted pull request for observation: state, head, checks,
CodeRabbit follow-up, stack lifecycle and Shipping. For a head whose tree matches a passed
local review it starts no review, answers no thread and posts nothing. Existing Inspector
threads on pull requests already open are left as they are.

### 7. Shipping (decision D2)

Shipping today requires a Live, published GitHub review of the exact head. A locally reviewed
head has none. Under D2 Shipping accepts a matching local review as merge provenance: a new
review posture, `local`, appended to `INSPECTOR_POSTURES`, valid only while Local review is on
and only for a head whose tree and base match. Until Phase 6 lands, repositories holding the
merge grant keep the GitHub review for every head.

Dry run stays dry for a locally reviewed head, and the rule is enforced twice. The merge
predicate's first gate reads the Inspector's current posture and refuses every merge while
the Inspector is off, in Dry run, or the repository is not on its list. That gate stays first
and unchanged. And the worker records the `local` posture only while that current posture is
Live. In Dry run a matched head still gets no GitHub review and no post, but it is recorded
with the current posture (`dry-run` or `not-allowlisted`), as a dry review is today. When the
operator switches to Live, the next sweep finds the match still holds and records `local`
without a GitHub review, because a local review withheld nothing from publication.

### User-visible surfaces

Every one needs a Playwright spec, and the modal inset check where a modal opens:

- Settings > GitHub Inspector: the Local review control and its explanation of the three rows
  above.
- Library > Commands: the Local Inspector row (allowance, timeout, exhaustion policy, blocking
  severity per D3).
- Workflow pipeline view: the new stage in version 23.
- Run detail: the Local Inspector card with findings and confirmation that it read the
  worktree, and the Completion tab's "reviewed locally" state.
- Session chip and Shipping merge queue: the local posture and its block reasons.
- Persona editor (Phase 3): the repository access control the approved repository-access plan
  specifies, and the run detail's record of repository queries.

### What does not change

- Published workflow versions, bindings, node ids, and the `mission-inspector:v1` marker.
- The adoption rule: only pull requests Mission Control proved it opened.
- One GitHub poller. The daemon is the only database writer.
- Dry run still means dry for the merge.
- Persisted identifiers are appended, never renamed: the `inspector` slot and the `local`
  posture here, and the `repository` evidence kind in the approved repository-access plan.

## Read access for the judges

Added in revision 2, from the review discussion.

### What the ledger says

Inspector ran on Claude with read tools for one week before it moved to Codex, which has none.
That is the only comparison this installation holds (`teamupstart/mission-control`, all pull
requests with at least one review):

| Inspector configuration | Pull requests | Findings per pull request | Pull requests with any finding | Major or worse per pull request | Rounds per pull request |
| --- | --- | --- | --- | --- | --- |
| Claude `claude-sonnet-5`, read tools (adopted 2026-09-08 to 09-14) | 71 | 2.58 | 79% | 0.93 | 4.1 |
| Codex `gpt-5.6-sol`, no tools (2026-09-15 to 09-25) | 67 | 1.79 | 61% | 1.25 | 3.5 |
| Codex `gpt-6-sol`, no tools (2026-09-26 on) | 226 | 2.13 | 50% | 1.31 | 4.5 |

The model changed along with the tools, and so did the work under review, so this is
suggestive and nothing more. Read with that caution: with read tools Inspector flagged more
pull requests and found about a fifth more per pull request, mostly minor, and the number of
rounds did not move. Read access is a thoroughness lever. It is not a rounds lever.

### Where it helps, and where it does not

| Judge | Expected benefit | Why |
| --- | --- | --- |
| Local Inspector (the Inspector judge) | High, and required (R1) | Its brief tells it to open files before it comments. A diff-only Local Inspector is not allowed |
| Code Design Reviewer | High | "This duplicates a helper that already exists" needs to know what exists |
| Test Coverage Judge | High | Whether a test exists, and whether it reaches the production path |
| Documentation Steward | High | Stale documents are found by searching. Today the author must register document text as evidence |
| Code Risk Reviewer, Code Quality Judge | Medium to high | Callers, error paths and resource lifetimes outside the changed hunk |
| Slop Filter | Medium | It can check that an API or import exists before calling it invented |
| Intent Conformance Judge, Test Evidence Auditor | Low | They judge the goal and the registered evidence, not the repository |

It also removes one ceiling: the Persona prompt truncates a large diff, and a judge with read
access can open what was cut.

### What it costs

- **Provider.** Only Claude can take the sandboxed read grant today. Codex declares no sandbox
  because it cannot restrict reads to one directory, and every built-in judge is pinned to
  Codex `gpt-6-sol`. D4 closes that gap with the repository MCP server instead of moving
  reviewers to Claude.
- **Time and spend.** `docs/inspector-and-shipping.md` records 225 to 272 seconds for a
  tool-using review of a 10 KB diff. A prompt-only judge is one call. Read access belongs on
  the judges that need it, not on all of them.
- **Verdict contract.** A requested change must cite evidence. A file the judge read needs a
  new evidence kind, `repository`, appended to the existing eight.
- **Size.** The approved repository-access plan estimates 4,800 to 6,200 lines of production
  code across its three serial phases.
- **More findings mean more rounds** unless the blocking threshold in D3 is set.

### The Inspector judge

The Local Inspector stage is the Inspector judge, and worktree read access is a requirement
for it (R1 in design item 1), not something that depends on configuration. It always reviews
with repository access through the repository MCP server, on whichever provider the Inspector
setting names. When that access is unavailable the stage blocks instead of reviewing the diff
alone. Its run card confirms that it read the worktree.

### How reviewers get repository access (decision D4, adopted)

**Goal R2, stated by the operator on 2026-11-23: repository access should be available to
every Persona-based reviewer in workflows, not only the Local Inspector.**

**Adopted route (D4): build the approved repository-access plan first, for Codex and Claude
together.** That plan's three phases become Phases 1 to 3 here, unchanged in scope:

- Repository access is set per Persona, `none` or `read`, and defaults to `none`. A review that
  reads files is slower and costs more, so it is turned on for the reviewers that need it.
- A reviewer with `read` runs once in an isolated review workload and queries a local
  repository MCP server: read, search and glob, plus Git status, diff, show, log and blame.
- The server reads a portable artifact of the exact submitted checkout, applies one security
  policy for both providers, and records an audit entry for every operation.
- Built-in Personas take a local access override. Shipped built-in workflow versions are not
  changed by it, so using it with No-Mistakes means duplicating the workflow, or a later
  built-in version decided from the measurements Phase 3 makes possible.

The Local Inspector (Phase 4) is the second consumer of the same workload and artifact. This
plan changes nothing in the approved plan and supersedes none of its requirements.

Not adopted: a Claude-only first step that would have handed Persona reviewers the Inspector's
existing read grant in one phase. It was faster, but it would have left Codex reviewers
without access and forced the Local Inspector onto Claude.

Suggested first judges once access exists: Code Design Reviewer, Test Coverage Judge,
Documentation Steward, Code Risk Reviewer and Code Quality Judge.

## Phases (outline)

| Phase | Delivers | Proves |
| --- | --- | --- |
| 1. Repository MCP and workload foundation | Phase 1 of the approved repository-access plan (`docs/plans/persona-repository-access/phase-1-repository-mcp-workload-foundation.md`) | A Codex or Claude review workload can query a repository view through the MCP server and nothing else |
| 2. Portable exact-state artifact | Phase 2 of that plan (`phase-2-portable-exact-state-artifact.md`) | The exact submitted checkout can be sealed, verified and materialized for a workload, with sensitive content left out |
| 3. Persona and Workflow integration | Phase 3 of that plan (`phase-3-persona-workflow-integration.md`): the per-Persona access setting, capture at submission, the workload in the engine, the `repository` evidence kind, the editor control | Goal R2: any Persona reviewer, on Codex or Claude, can be given repository access. Read-enabled judges can be measured against their prompt-only twins |
| 4. Local Inspector Command | Review core extraction, the `inspector` slot and interpreter, every review reading the worktree through the repository workload with no diff-only mode (requirement R1), findings retention and repair packet, the `localReview` setting gating only whether the stage runs, the Library row and run card, preview flag, docs | The stage works in a duplicated workflow while GitHub Inspector still gates, and no local review runs without repository access. The ledger then shows how many GitHub rounds remain after a local pass, against the 4.3 baseline |
| 5. Local review replaces the GitHub round | No-Mistakes version 23, the gate accepting a matching local pass, the worker skipping matched heads, Settings control copy, Completion tab and chip states | A converged change reaches GitHub with one push and one CI run, and completes with no GitHub review |
| 6. Shipping on local provenance (D2) | The `local` posture in the merge predicate, merge queue reasons, Trust and Prerequisites copy | YOLO merges a locally reviewed head and holds any head that is not |

The phases are serial: each depends on the one before it. Phases 1 to 3 keep the order the
approved plan fixes. Phase 4 needs the workload, the artifact and the capture that Phase 3
completes, because requirement R1 forbids a Local Inspector that cannot read the worktree.

Phase 4 is the proving period for the Local Inspector. If GitHub rounds after a local pass
stay near zero, Phase 5 is safe. If they do not, the gap is measurable before anything remote
is switched off.

## Risks and open questions

- **Round count.** Local rounds draw on the run's repair budget, default 5, and 35% of pull
  requests took 5 or more Inspector rounds. Read access raises the finding count further.
  D3's threshold is the control for that, and the budget stays operator-adjustable per
  built-in.
- **The saving comes late.** The CI saving that started this plan arrives at Phase 5. Phases 1
  to 3 are the approved plan's 4,800 to 6,200 lines of repository-access work, and nothing in
  them changes how many rounds run on GitHub.
- **The approved plan is two months old.** It was last checked against `main` on 2026-09-04
  at `v1.7.1`. Its phase files must be revalidated against current `main` before they are
  scheduled.
- **Engine seam.** The Command runtime spawns an argv in a leased worktree. The Local Inspector
  is a review that runs in the approved plan's review workload over the submission's
  repository artifact. Phase 4 must reuse that workload runner from a Command stage without a
  second execution path.
- **Slower rounds.** A review that reads files is slower and costs more per round than the
  diff-only review Inspector runs today.
- **Prompt drift.** A local review sees the goal instead of a pull request description. Phase 4
  measures whether its findings match the GitHub review's on the same content.
- **Base drift.** The local diff is against the base as it was at review time. The tree match
  proves the head's content, not that the base did not move. Personas have the same exposure.
- **Spend.** A local round costs the same review call as a GitHub round, and a read-enabled
  review costs several times a prompt-only one. The saving is CI and waiting, not tokens.
- **Instructions in repository files.** A reviewer that reads files can read text written to
  steer it. The files are the operator's own repository as submitted, and the access is
  read-only with sensitive paths denied by the repository policy.
- **Two findings stores.** Local findings are run data on the attempt. The Inspections table
  keeps listing GitHub reviews only. Phase 5 decides whether to mirror them at adoption.
- **Residual GitHub rounds.** A later push that changes the reviewed content (a CI repair, a
  conflict merge) is an "other head" and is reviewed on GitHub as today.

## Verification

- Repository access (Phases 1 to 3): the verification the approved repository-access plan
  specifies for each of its phases, on both providers.
- Focused node tests for the review core with a fake runner (Phase 4): local diff,
  open-finding carry, resolution, blocking threshold, off-diff drop, scrubbing, repository
  access present on every local review, and unavailable access blocking instead of reviewing
  (R1).
- Engine tests: stage ordering before the Pull Request action, the repair loop on fresh
  evidence, allowance and exhaustion policy, skip reasons, restart recovery.
- Gate tests: a matching tree completes, a moved head does not, a skipped stage falls back.
- Worker tests: no review, reply or post for a matched head. Observation continues.
- Shipping tests (Phase 6): refusal for an unreviewed, amended or later-pushed head, and for a
  matching local pass while the Inspector is in Dry run.
- A Codex Local Inspector review that reads the worktree through the repository workload
  (Phase 4).
- Playwright specs for every surface above. Typecheck, lint, build, smoke.

## Decisions

Adopted by the operator. The follow-up choice and the approval are recorded by Mission Control
against the exact revision, not in this file.

| Id | Decision | Adopted choice | Source |
| --- | --- | --- | --- |
| R1 | Whether the Local Inspector may review from the diff alone | No. It always has read access to the whole submitted worktree | Line comment, 2026-11-23 |
| R2 | Whether repository access stops at the Local Inspector | No. It is available to every Persona-based reviewer in workflows | Line comment, 2026-11-23 |
| D1 | Which option | A, Local Inspector stage | Dashboard answer, 2026-11-23 |
| D2 | Whether Shipping accepts a matching local review as merge provenance | Yes, as Phase 6 | Dashboard answer, 2026-11-23 |
| D3 | Which findings block the local stage | Tunable in Library > Commands, default major and above | Dashboard answer, 2026-11-23 |
| D4 | Which route gives reviewers repository access | The approved repository-access plan first, for Codex and Claude together. No Claude-only step | Dashboard answer, 2026-11-23 |

## Review record

- 2026-11-21, revision 1. The operator moved every decision to discussion and asked how to
  include worktree read access for the Persona judges and a new Inspector judge. Revision 2
  added "Read access for the judges".
- 2026-11-23, revision 2. The operator again moved every decision to discussion, then asked how
  a local round can exist when the Inspector runs after the pull request. Revision 3 added
  "Stage order, before and after" and made the move before the pull request explicit. Revision
  4 rebuilt the rendered page from this Markdown and changed no content.
- 2026-11-23, line comments on revision 4. The operator asked why Claude has read tools and
  Codex does not, which was answered in the thread, then set requirement R1 (revision 5) and
  stated goal R2 (revision 6).
- 2026-11-23, dashboard answer on revision 6. Asked how to settle the plan, the operator chose
  "Adopt them, but build Codex repository access first". Revision 7 records D1 to D4 as
  adopted, makes the approved repository-access plan's three phases the first three phases
  here, builds the Local Inspector on the same repository workload after them, removes the
  Claude-only step and the Local Inspector's separate model row, and condenses the options
  that were not adopted.
- Earlier revisions numbered the phases differently. The numbering in "Phases (outline)" is
  the current one.
- 2026-11-23, review of the pull request. Design item 2 stated the spent-allowance rule two
  ways. Revision 10 states one: the slot's exhaustion policy decides, with Block as the
  default.
- 2026-11-23, Plan Validation review. Design item 7 did not say where Dry run is checked for a
  locally reviewed head. Revision 12 states it: the merge predicate's current-posture gate,
  and the worker recording `local` only under Live.

## Evidence

- Inspector ledger, read-only: `inspector_prs` and `inspector_comments` in this machine's
  Mission Control database, filtered to `teamupstart/mission-control`. The problem table uses
  `adopted_at` within 60 days of 2026-11-20. The read access table uses every reviewed pull
  request, grouped by adoption date.
- Review provider: `usage_ledger` rows with `note_key = 'inspector:review'`. Claude
  `claude-sonnet-5` from 2026-09-08 to 09-15, then Codex `gpt-5.6-sol` to 09-25 and
  `gpt-6-sol` since. Within the 60 day window: 1,094 on `gpt-6-sol` and 49 on `gpt-5.6-sol`.
  Stored Inspector config: `runner: codex`, `mode: live`.
- CI: job durations for runs 44857733861 and 44857661151, and `ci.yml` run counts for pull
  requests 1553, 1550, 1533, 1523 and 1488, read with `gh`.
- Code: `src/server/inspector/worker.ts` (`inspectorRunOptions`, `liveDir`, `processPr`,
  `reviewRound`, `REVIEW_TOOLS`, `DENY_PATHS`), `src/server/inspector/prompt.ts`,
  `src/server/llm/codex.ts`, `src/shared/llm.ts`, `src/server/workflows/engine.ts`,
  `src/server/workflows/prompt.ts`, `src/server/workflows/coderabbit.ts`,
  `src/server/workflows/builtin-workflows.ts`, `src/shared/inspector.ts`,
  `src/shared/workflow.ts`.
- Docs: `docs/inspector-and-shipping.md`, `docs/workflows.md`, `docs/workflow-system.md`,
  `docs/feature-flags.md`, `docs/agent-guides/change-contracts.md`,
  `docs/plans/pre-pr-inspector/plan.md`, `docs/plans/persona-repository-access/plan.md` and
  its `phased-plan.md`.
