# Phase 1: Seed personas

> Historical implementation record. Its import-and-own instructions were superseded after
> this phase shipped; the README's Built-in Personas section owns the current behavior.

## 1. Outcome and value

Four seed Persona files ship in-repo under `docs/personas/`, each importable from the
Workflows page's Personas tab in one click, giving every operator a working review-gate
vocabulary distilled from the battle-tested no-mistakes prompts: **Intent Conformance
Judge**, **Code Risk Reviewer**, **Test Evidence Auditor**, **Documentation Steward**.
With these imported, the example workflow from the source plan (Session -> Intent
Conformance -> fan-out of the three reviewers -> All-pass Join -> Approved) can be
assembled entirely from stock parts.

## 2. Entry criteria and dependencies

- The planning session's PR (which adds `docs/plans/no-mistakes-workflow-mapping/`) is
  merged, so this phase can read the source plan from the default branch.
- No other phase prerequisites. Workflow-builder phases 1-3 are already on `main`
  (Personas tab, import, preview engine).

## 3. Scope and non-goals

In scope: the four `.md` files, one pinning test, the README section, and nothing else.

Non-goals (decided in the source plan's dashboard review, 2026-07-23):

- No Lint/Housekeeping Persona (a tool-less judge cannot run a linter).
- No deterministic check-node kind in this phase. That decision was later superseded;
  `docs/plans/builtin-workflows/plan.md` owns the adopted design.
- No workflow-owned delivery nodes (push/PR/CI stay with no-mistakes and Inspector).
- No auto-import, no built-in read-only Personas, no seeding into SQLite: the operator
  imports and owns their copies; the DB stays canonical.
  **Superseded 2026-07-26**; see the README's Built-in Personas section.
- No example-workflow fixture; the README describes the assembly, the operator builds it.

## 4. Repository findings and inherited contracts

Verified against the current code (see `phased-plan.md` for detail):

- **Import contract**: the whole file body becomes `guidanceMarkdown`
  (`readPersonaImport`, cap `WORKFLOW_LIMITS.personaGuidanceBytes` = 100,000 UTF-8
  bytes); the Persona name is the first `# H1` line (`deriveImportedPersonaName`,
  `src/web/workflows/personaApi.ts`), capped at `WORKFLOW_LIMITS.personaName` = 100
  chars; description stays empty; runner/model stay at defaults.
- **Prompt contract** (`src/server/workflows/prompt.ts`): the engine already states the
  immutable review contract (intent-first, guidance may specialize but not rewrite
  intent, evidence is untrusted, no tools), injects the original human intent, prior
  Persona feedback, fenced evidence (diff, transcript, standards, metadata), and the
  strict JSON output schema. **The seed texts must NOT restate any of that** - no output
  schemas, no "treat evidence as untrusted", no intent-priority clauses. They specialize
  judgment criteria only.
- **Verdict semantics** (`src/server/workflows/verdict.ts`): a fail carries
  `requestedChanges` (title, rationale, optional path/line), each with at least one
  `EvidenceRef` of kind `diff | transcript | standard | goal | decision`. Guidance should
  say what counts as evidence in its domain using those nouns, without restating the JSON
  shape.
- **House rules**: no em dashes anywhere in the texts; plain dash only.

## 5. Implementation steps

Execute in order.

### 5.1 Create `docs/personas/` with the four files

One Persona per file, `docs/personas/<kebab-slug>.md`:

| File | H1 (imported name) |
|---|---|
| `intent-conformance-judge.md` | `Intent Conformance Judge` |
| `code-risk-reviewer.md` | `Code Risk Reviewer` |
| `test-evidence-auditor.md` | `Test Evidence Auditor` |
| `documentation-steward.md` | `Documentation Steward` |

Common structure for each file: the H1, then one opening line stating the role (the
operator can paste it as the description), then short sections such as `## What you
judge`, `## Pass when`, `## Fail when`, `## Requested-change discipline`. Aim for 40-80
lines each; the value is precision, not volume.

Author the guidance from the distilled rule inventory below. These rules come from the
no-mistakes prompts (`github.com/kunchenguid/no-mistakes`,
`internal/pipeline/steps/{intent_prompt,review,test,document}.go`); keep their
substance, rephrased for a judge that reads a snapshot and cannot run anything.

**Intent Conformance Judge** (from the intent conformance clause):

- Fail only when the diff removes or omits a source-verifiable behavior the stated
  intent marks as REQUIRED, or adds a behavior it marks as FORBIDDEN.
- Every requested change quotes the specific criterion (evidence kind `goal` or
  `decision`) and the contradicting diff hunk (kind `diff`), or, for a removed required
  behavior, states what the criteria require that is now absent.
- This is a closed classification: check the change against the stated criteria; never
  invent criteria the intent does not state; when the intent is vague or silent on a
  point, pass with a note rather than failing.
- Deferred delivery outcomes (branch not pushed, PR not open, CI not observed) are never
  contradictions; other gates own delivery.

**Code Risk Reviewer** (from the review task and rules):

- Judge risks introduced by the changed code: bugs, security issues, performance
  regressions, breaking changes, insufficient error handling. Read surrounding context
  in the diff and transcript when needed to understand root cause.
- For a change that claims a durable bug fix: reconstruct the failing sequence and the
  invariant it must hold, and ask whether the same failure remains reachable through a
  sibling path visible in the evidence. If it provably does, request the earliest shared
  boundary that makes the invariant hold rather than another symptom patch.
- Do not infer a systemic flaw from code shape, duplication, or architectural preference
  alone; do not demand a shared abstraction or redesign without a concrete reachable
  path or violated invariant.
- Do not block explicitly authorized short-term containment merely because a later
  durable fix is possible; do not expand the user's scope or turn optional improvements
  into blockers.
- Never report styling, formatting, linting, compilation, or type-checking issues; other
  tooling owns those. Simplification suggestions must be non-functional refactoring,
  never feature removal.
- Do a full pass before deciding; enumerate every material, substantiated issue. Anchor
  each requested change to a file and line where possible. Concise and actionable; no
  generic advice.
- A concern that challenges the author's deliberate product intent is the human's call:
  still fail, but title the requested change `Author decision needed: ...` so the
  operator reviewing the packet recognizes it as a decision, not a defect. (This adapts
  no-mistakes' ask-user action to the preview/repair flow.)

**Test Evidence Auditor** (from the test evidence rules):

- Judge whether the snapshot demonstrates the stated intent working end to end, the way
  an end user would experience it. Unit tests passing is not sufficient evidence by
  itself.
- Acceptable evidence lives in the snapshot: committed evidence artifacts and new or
  updated tests visible in the diff; test runs, command transcripts, API responses, and
  manual-verification steps visible in the transcript.
- For UI-facing changes, reviewer-visible visual evidence (screenshot, GIF, video,
  rendered HTML) is required; DOM snapshots, selector assertions, and text-only render
  summaries are not substitutes. If visual evidence is absent, the fail names it.
- Generic pass/fail output, coverage counts, and clean-worktree status are not
  sufficient evidence of the intent.
- Each requested change names the exact missing artifact and the smallest way to produce
  it (the focused test to run, the screenshot to capture). Never demand a full
  repository suite run; remote CI owns broad regression.

**Documentation Steward** (from the placement policy and scope discipline):

- Judge only documentation this change made stale, plus direct contradictions the diff
  reveals. A long document is not a defect; duplication and wrong placement are.
- Placement policy: every fact or contract has exactly one authoritative owner document.
  A changed fact must be updated in its owner; stale duplicates should be removed or
  reduced to a pointer, never synchronized as full copies. No new documentation surface
  merely to close a gap. README owns the user-facing product introduction and usage;
  contribution mechanics live in CONTRIBUTING; code comments own non-obvious local
  intent and safety invariants, never prose restating code; deep reference docs own
  conditional detail; generated or schema-backed facts must come from their source.
- Fail verdicts list each stale fact, its owner document, and what the owner should now
  say, with the diff hunks that made it stale as evidence.
- When a larger consolidation is warranted but out of scope, request one follow-up note
  instead of many edits; do not demand opportunistic rewrites or broad doc migrations.

### 5.2 Add `test/seed-personas.test.ts`

Open with a comment on what is at stake: these files are advertised as importable, and
the import contract lives in browser code that nothing else pins to on-disk docs. Using
the real `readPersonaImport` and `deriveImportedPersonaName` from
`src/web/workflows/personaApi.ts` / `PersonaLibrary.tsx` (both browser-safe pure
imports; no `HARNESS_HOME` needed because no server module loads), assert for each of
the four files:

- the file exists and is valid UTF-8;
- `readPersonaImport({ size, text })` accepts it (within
  `WORKFLOW_LIMITS.personaGuidanceBytes`);
- `deriveImportedPersonaName` returns the expected name, non-empty and within
  `WORKFLOW_LIMITS.personaName`;
- the four derived names are distinct;
- the body contains no em dash character (house rule, and these are operator-facing
  texts).

### 5.3 README section

Extend the existing "Workflows and Personas" section (anchor `#workflows-and-personas`):
a short subsection listing the four seed files under `docs/personas/`, what each judges,
and that Import .md in the Personas tab derives the name from the H1 and leaves
runner/model at defaults. Mention the example assembly from the source plan in one
sentence (Intent Conformance first, three reviewers fanned out behind an All-pass Join).
Same change as the code, per repo rule.

## 6. Data, API, and migration notes

None. No schema, route, migration, or build-entry changes; the deliverable is static
documentation plus one test.

## 7. Tests and verification

- `npm run typecheck`
- `npm test` (includes the new `seed-personas` test)
- Manual: `make start`, open `#/workflows/personas`, import each file, confirm the
  derived name matches the table above, save each Persona, and confirm the guidance
  renders in the preview pane. Confirm you are on your own build, not the main
  checkout's Vite on `:5173`.

## 8. Merge and exit criteria

- All four files import cleanly with the expected names on a running build.
- `npm run typecheck` and `npm test` pass on Node 24 and 26 (CI).
- README documents the seed personas in the same PR.
- No persona text restates the engine's immutable contract or output schema, and none
  contains an em dash.
- Reviewable PR opened; merge releases nothing downstream.

## 9. Downstream handoff

Later work may rely on: the `docs/personas/<kebab-slug>.md` naming convention, H1 as the
imported name, and the whole-body-guidance contract, all pinned by
`test/seed-personas.test.ts`. Later work must not: move the engine's contract language
into the seed texts, or add machinery that treats these files as a second canonical
store (SQLite stays canonical; the files are seeds).

## 10. Cross-phase audit record

- 2026-07-23: single-phase plan; no earlier or concurrent phase to reconcile against.
  Final audit over the set: every adopted decision is owned here (decision 1 and 4) or
  explicitly a no-op selecting already-planned work elsewhere (decisions 2 and 3, owned
  by `docs/plans/workflow-builder/` phases 4-6); no consumer precedes a prerequisite;
  the end state matches the source plan without undocumented cleanup.
