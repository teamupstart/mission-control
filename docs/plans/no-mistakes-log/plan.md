# Plan: no-mistakes Fix Log

Status: phases 1-2 implemented; phase 3 (foreman) deferred
Owner: ai-harness
Related: the no-mistakes strip (`src/web/components/NomistakesStrip.tsx`), which shows a
run *while it runs*. This shows what its fixes *did*, after it stops.

## Goal

A session-scoped log of every fix no-mistakes committed on this session's branch, on the
session card, answering three questions per fix:

1. **What changed** - the commit, its files, its diffstat, and a link to the real diff.
2. **Why** - the justification no-mistakes gave: the findings it reported, each with the
   severity, the location, and its description.
3. **Who authorized it** - auto-fixed by the pipeline, or fixed because someone replied,
   with the reply text.

It **outlives the run** (a finished run stops being interesting to watch at exactly the
moment it starts being interesting to review) and it **empties when the session is reset**.
The card's height stays fixed no matter how many fixes land.

## Why this shape

The run summary already on the card is the wrong carrier for this. `axi status` reports
findings **only while parked at a gate** (`gateFields(gate)` is emitted only when
`awaitingStep()` matches), so an auto-fix round's findings never appear on that surface at
all. And `step_results.findings_json` is overwritten by each fix round, so a finding is
gone from the live status the moment it is fixed. The strip cannot answer "why did this
change happen" even in principle.

Three facts make this buildable as a **join over data that already exists**:

- **Every fix self-commits, deterministically.** `deterministicFixCommitMessage`
  (`internal/pipeline/steps/common_fix.go:93`) writes `no-mistakes(<step>): <summary>`.
  So the list of fixes is `git log <base>..HEAD --grep '^no-mistakes('`.
- **The context is in no-mistakes' database.** Each `step_rounds` row holds
  `findings_json` (the justification - descriptions run 500-900 chars of real reasoning),
  `user_findings_json` (the reply, attached per-finding as `user_instructions` by
  `mergeUserOverridesJSON`), and `selection_source` (`user` vs `auto_fix`).
- **The join key is exact.** A round's `fix_summary` is character-for-character the
  commit subject after the prefix. Verified against live data: round
  `review | fix(queue): queues survive a restart, sweep needs evidence to escalate` joins
  commit `0eda227 no-mistakes(review): fix(queue): queues survive a restart, sweep needs
  evidence to escalate`.

### The round offset (learned while building)

The round carrying a `fix_summary` is the round that **ran** the fix, so its own
`findings_json` is the re-review *afterwards* - the justification for the NEXT fix. What
caused a commit is on **round - 1**, where the executor wrote the selection
(`SetStepRoundSelection` / `SetStepRoundUserFindings`) before looping to execute it.

Live proof: commit "fix(queue): queues survive a restart" sits on round 2, whose findings
are 13 with the reply "fix all thirteen". It was actually caused by round 1's 4 findings
and "apply all four". Reading the fix round's own context looks entirely plausible and is
wrong - it silently mis-attributes every multi-round fix.

Round 1 is a real exception: `document` and `lint` do their work on first execution, so
findings and fix come from the same call and nobody was asked. A naive `round >= 2` guard
drops context for every doc and lint fix (live data has 22 such rounds).

Both cases are pinned by `test/nomistakes-fix-context.test.ts`.

### Scope by repo, not branch (learned while building)

A fix commit outlives the branch it was made on: `axi run` rebases, branches get renamed,
work gets carried forward. So the round explaining a commit on *this* branch is often filed
under an older one - live, "fix(queue): drafts surface" sits on `session-work-queue-impl`
while its round is under `cite-idle-nudge-evidence`. Branch-scoping the lookup lost context
for two thirds of a real branch's fixes (2/6 resolved; repo-scoping took it to 4/6, the
remaining two having no round rows at all). Repo is specific enough: the key is
(step, summary), and a summary is a whole sentence the agent wrote.

**Reset needs no bookkeeping.** `resetToOrigin` runs `git reset --hard origin/main`
(`src/server/actions.ts:319`), which destroys the fix commits. A git-derived log empties
itself. Unlike `nmDismissed`, there is no dismissal set to maintain, and it survives a
daemon restart for free.

### Join from git to rounds, never the reverse

Some rounds record a `fix_summary` but commit nothing - `commitAgentFixes` returns early
when `git status --porcelain` is empty, and the live `lint` step has two such rounds
("typecheck clean; no linter or formatter configured"). Git is what proves a fix changed
code; the database only explains it. Driving from git also degrades well: a fix with no
matching round still lists, just without context, rather than vanishing.

## Data model

Two tiers, because the context is big. A 22-finding fix carries ~20KB of descriptions;
denormalizing that onto every card would push megabytes through the session snapshot on
every SSE tick. So the card gets a light summary and the detail is fetched when a fix is
opened - the same shape the diff already uses.

```ts
// src/shared/types.ts

/** Who caused a fix to happen. */
export type NmFixDecision = "auto" | "replied";

/** One no-mistakes fix commit on a session's branch. Card-weight. */
export interface NmFixSummary {
  sha: string;              // short sha, the detail key
  step: string;             // review | document | lint | test | ...
  summary: string;          // commit subject minus the "no-mistakes(step): " prefix
  committedAt: number;      // epoch ms
  filesChanged: number;
  added: number;
  removed: number;
  /** From the matched round; null when no round matched. */
  decision: NmFixDecision | null;
  findingCount: number;
}

/** One finding no-mistakes reported as justification. */
export interface NmFixFinding {
  id: string;
  severity: string;         // error | warning | info
  file: string;
  line: number | null;
  description: string;      // the justification, verbatim
}

export interface NmFixFile { path: string; added: number; removed: number }

/** Everything behind one fix. Fetched on demand. */
export interface NmFixDetail {
  sha: string;
  step: string;
  summary: string;
  committedAt: number;
  decision: NmFixDecision | null;
  /** The reply that authorized it (user_instructions), once - not per finding. */
  reply: string | null;
  findings: NmFixFinding[];
  files: NmFixFile[];
  added: number;
  removed: number;
}
```

`Session` gains `nomistakesFixes: NmFixSummary[]` (empty when none), denormalized next to
`nomistakes`.

## Server

### `src/server/nomistakes-fixes.ts` (new)

- `listFixes(cwd)` - `git log <base>..HEAD --grep '^no-mistakes(' --numstat` with a
  NUL-delimited format, parsed into commits + per-file numstat. `<base>` comes from
  `sourceRef()`, exported from `diff.ts` rather than reimplemented.
- `loadRoundContext(cwd, branch, commits)` - opens `NM_HOME ?? ~/.no-mistakes/state.sqlite`
  **read-only** via `node:sqlite`, returns `Map<"step\x00summary", RoundContext>`. Narrowed
  by the commits it is explaining, so the work is bounded by the branch and not by the
  repo's history: a repo accrues fix rounds forever (67 live, against 6 fixes on a branch)
  and each drags ~20KB of json.
  Repo-scoped: the session cwd is usually a worktree, so the repo is resolved with
  `dirname(git rev-parse --path-format=absolute --git-common-dir)`, which yields exactly
  `repos.working_path`. Falls back to branch-only scoping if that lookup misses, and to
  no context at all if the DB is absent or its schema has moved.
- `readFixLog(cwd)` - joins the two and returns `{ summaries, details }`.

Caps: 50 fixes, 40 findings per fix, 60 files per fix, 2000 chars per description, 4000
chars per reply. **Each is logged, and none may shrink a count the card states.** A cap that
silently drops the tail reads as "this is everything," which is worse than the cap itself:

- `filesChanged` and `findingCount` are the TRUE totals; `files` and `findings` are the
  capped lists. The card shows the totals and says when the list is short of them.
- The fix log asks git for `MAX_FIXES + 1`, so hitting the cap is detected rather than
  inferred - at exactly 50 you cannot tell "50 fixes" from "50 of more".

### Polling

Folded into the existing no-mistakes poller, which already walks every gated worktree.
Keyed by HEAD sha: the fix log only changes when a commit lands, so `git log` + the sqlite
read run only when `git rev-parse HEAD` moves. A gated session with a still branch costs
one `rev-parse` per tick.

The fix log is **not** gated on an active run - that is the entire point.

### Registry

- `applyNomistakesFixes(sessionId, fixes)` - same emit-on-change shape as
  `applyNomistakesNarration`.
- `clearNomistakesFixes(sessionId)` - called from the reset route beside
  `dismissNomistakes`, so the card is clean the moment reset returns rather than one poll
  later. No dismissal set: the commits are gone, so the next poll agrees.

### Routes

- `GET /api/sessions/:id/nomistakes/fixes/:sha` - `NmFixDetail`, 404 when unknown.
- `GET /api/sessions/:id/diff?commit=<sha>` - the one genuine addition to existing code.
  `computeSessionDiff` currently takes `?base=` and diffs from `merge-base(HEAD, ref)`,
  which structurally cannot isolate one commit: passing a SHA yields everything *since*
  it. Add a commit mode diffing `<sha>^..<sha>`, falling back to the empty-tree hash for a
  root commit.

## UI

`src/web/components/NomistakesFixLog.tsx`, rendered by `SessionCard` below the strip when
`nomistakesFixes.length > 0`.

- **Rollup row** (collapsed default): `◇ fixed by no-mistakes · review 5 · document 3` and
  a count. This is the whole footprint at rest.
- **Scroll region** (open): `max-height: 208px`, `overscroll-behavior: contain` so hitting
  the end does not scroll the fleet grid behind it. The card's height is a constant.
- **Per-fix detail**, opened in place, one at a time, fetched on first open and cached:
  - `no-mistakes found · N findings` - severity chip, `file:line`, description clamped to
    3 lines (the clamp `.nm-findings` already uses, for the same 900-char reason).
  - `you replied` / `auto-fixed` - the reply text, clamped to 4 lines, expandable.
  - `changed` - sha, diffstat, files, and **View diff** into the existing `DiffViewer`
    scoped to that commit.
- Colors encode the lane: amber for a reply, green for auto-fixed.

## Phases

1. **Types + server + poller + rollup list.** The log lists and scrolls; no detail yet.
2. **Detail route + context UI + commit-scoped diff.** The narrative and View diff.
3. **Foreman attribution** (deferred, see below).

## Deferred: foreman attribution

**Blocked on the foreman/no-mistakes integration landing first** (in flight on
`mancej/foreman-sees-nomistakes-gates`). Building attribution against it now means building
against a moving target, and the integration is what makes attribution tractable at all.

The reply text a foreman nudge produces is **already on the card today** - the foreman types
into the session, the agent relays it via `axi respond --instructions`, and that lands in
`user_instructions`. What's missing is only the *byline*: `selection_source` records that
someone answered (`user` vs `auto_fix`), never who. So this is a label on text you can
already read, not a missing capability.

Two things make it cheap once the integration lands, and both are worth knowing before
anyone re-scopes this:

- **The plumbing exists.** `session_events (session_id, ts, kind, payload)` is durable and
  indexed, with a `logEvent()` writer and exactly one caller (`registry.ts`). Recording an
  outbound foreman send is a call, not a subsystem. The `SessionNote` can't serve here - it
  is one upserted row, so its text is overwritten by the next verdict.
- **There is a real key, not a time window.** The in-flight branch marks a gate verdict
  `gate:${nm.id}:${gateStep}` - keyed on the RUN id (deliberately: successive runs share a
  branch). This log already resolves a commit to a round, and a round hangs off a
  `step_result` carrying `run_id` and `step_name`. So `gate:<runId>:<step>` joins exactly.
  Remaining wrinkle: one (run, step) can have several fix rounds; round number or timestamp
  settles it. `NmFix*` would need to carry `runId`, which `loadRoundContext` already has.

Until then phases 1-2 ship two honest lanes, `auto` and `replied`, with the reply verbatim
so you can see who it sounds like. A third lane guessed from a time window would be worse
than no lane.

## Testing

- `test/nomistakes-fixes.test.ts` - the git log parse: multi-file numstat, binary `-`/`-`
  (Number("-") is NaN and would poison the diffstat), rename arrows, a summary containing
  `: `, and non-fix subjects (`--grep` is only a prefilter).
- `test/nomistakes-fix-context.test.ts` - the round join, against a database built to match
  no-mistakes' real schema: the round-1 offset, the round-1 exception, auto-fix narrowing
  by `selected_finding_ids`, cross-branch context, and a fix with no round. These are the
  tripwire for the schema coupling. Mutation-checked: reintroducing the offset bug fails
  three of them.
- `test/nomistakes-fixlog-e2e.test.ts` - real origin + clone + real fix commits through the
  registry and routes: the card lists only no-mistakes commits (not hand-written ones);
  reset empties the log and polling can't bring it back; a failed reset leaves it; the
  detail route 404s a non-fix sha; `?commit=` isolates one fix and doesn't leak later
  commits; an unreachable sha reports rather than guessing.

Verified end-to-end in the real app (isolated daemon, built UI, real fix commits whose
subjects match live rounds): the card renders the rollup, the scroll region caps at 208px
with 501px of content, and the narrative shows real justification text and the real reply
("The user decided the ask-user finding. Apply all four."). That pass caught the diff
header reading "HEAD vs \<parent\>" for a single fix - the exact misreading `?commit=`
exists to prevent - now "fix \<sha\>".

## Risks

- **Private schema.** `state.sqlite` has no compatibility promise and `axi` is the
  supported surface - which is exactly why this data is unreachable today. We are on
  v1.34.2 with v1.37.0 released. Mitigation: every DB read is defensive and the log
  degrades to git-only context when anything is missing, so a schema move costs the *why*,
  never the log. The real fix is an upstream `axi rounds --run <id>`; this is what we do
  until then.
- **Rebase/squash.** `axi run` rebases and a squash-merge rewrites these commits, so the
  log is honestly "fixes currently on this branch", not "fixes ever applied". Consistent
  with resetting on reset.
