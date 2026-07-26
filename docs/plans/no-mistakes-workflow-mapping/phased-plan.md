# Phased implementation: no-mistakes gates as workflow Personas

> Historical implementation record. Its seed/import instructions were superseded after
> delivery; the README's Built-in Personas section owns the current behavior.

Source plan: `docs/plans/no-mistakes-workflow-mapping/plan.md` (approved 2026-07-23; rendered
page `plan.html` beside it).

## Incorporated human decisions

Submitted through the Mission Control dashboard review on 2026-07-23 and already folded into
the source plan:

1. **Persona set**: author all four - Intent Conformance Judge, Code Risk Reviewer, Test
   Evidence Auditor, Documentation Steward. Lint/Housekeeping not adopted.
2. **Deterministic test/lint command gates**: leave outside the graph. CI enforces them at
   the PR head; the Inspector final gate (phase 5 of the workflow-builder plan) makes them
   binding. No check-node kind.
3. **Ship tail**: as planned - graph success shows a missing-PR wait offering the existing
   no-mistakes/PR wrap-up, then the Inspector final gate. No workflow-owned delivery nodes.
4. **Persona texts**: seed `.md` files shipped in-repo under `docs/personas/`, importable
   from the Personas tab. **Superseded 2026-07-26**; see the README's Built-in Personas
   section.
5. **Follow-up**: this phased implementation plan.

Decisions 2 and 3 are do-nothing decisions: they select the already-planned workflow-builder
phases (4-6) over new machinery and require no work here. The implementable remainder is
decision 1 + 4: author the four seed persona files, with documentation and tests.

## Investigated findings (what the repository actually does)

- **Import contract** (`src/web/workflows/PersonaLibrary.tsx`,
  `src/web/workflows/personaApi.ts`): `readPersonaImport` rejects files over
  `WORKFLOW_LIMITS.personaGuidanceBytes` (100,000 UTF-8 bytes); the entire file body becomes
  `guidanceMarkdown`; `deriveImportedPersonaName` takes the first `# H1` line (else the
  filename); description stays empty and runner/model stay at defaults. A seed file is
  therefore self-describing: its H1 is the Persona name and its opening line doubles as the
  description the operator will paste.
- **Prompt contract** (`src/server/workflows/prompt.ts`, `buildPersonaPrompt`): the engine
  already emits the immutable review contract, the original human intent block, prior
  Persona feedback, fenced untrusted evidence (metadata, diff, transcript, standards), and
  the required JSON output schema. The published Persona Markdown is interpolated between
  intent and evidence. **Seed guidance must not restate the contract, the intent priority,
  the untrusted-evidence rule, or the output schema** - duplicating them is double
  instruction and drifts when the engine's wording changes.
- **Verdict semantics** (`src/server/workflows/verdict.ts`, `@shared/workflow.ts`): a fail
  needs at least one `EvidenceRef` per requested change; evidence kinds are
  `diff | transcript | standard | goal | decision`; infrastructure problems must never be a
  fail verdict (the engine says this in the prompt already). Requested changes carry
  `title`, `rationale`, optional `path`/`line`. Guidance should tell each Persona what
  *counts* as evidence for its domain, in these terms.
- **Name limit**: `WORKFLOW_LIMITS.personaName` is 100 characters; the H1-derived name must
  fit. `personaDescription` is 500 (unused by import).
- **`docs/personas/` does not exist yet**; nothing else claims the path.
- **README** has a "Workflows and Personas" section (anchor `#workflows-and-personas`,
  referenced from the Configuration table around lines 2400-2401); seed-file documentation
  belongs there. Repo rule: README updates land in the same change.
- **Tests** are flat `test/<feature>-<aspect>.test.ts`, `node:test` + `node:assert/strict`.
  `deriveImportedPersonaName` and `WORKFLOW_LIMITS` are browser-safe pure imports, so a test
  can pin the seed files against the real import functions without a server or DB
  (no `HARNESS_HOME` preamble needed - but keep the rule in mind if any server module ever
  gets imported).
- **Source prompts** (the distillation input) live in the public repo
  `github.com/kunchenguid/no-mistakes` under `internal/pipeline/steps/`:
  `intent_prompt.go` (conformance clause), `review.go` (review task + rules), `test.go`
  (evidence rules), `document.go` (placement policy + scope discipline). The distilled rule
  inventory is embedded in the phase file, so the implementing agent does not need to clone
  the upstream repo.
- **House rules that bind the persona texts themselves**: no em dashes anywhere; the texts
  are documentation-adjacent product content and read by operators.

No discrepancies between the source plan and the repository were found; the plan was written
against this same code.

## Phase table

| Phase | Name | Direct prerequisites | Deliverable |
|---|---|---|---|
| 1 | Seed personas | none (planning session only) | `docs/personas/*.md` x4, `test/seed-personas.test.ts`, README section |

One phase. The whole deliverable is four Markdown files, one test file, and a README
section - splitting it would create review units smaller than their overhead, and there is
no schema, migration, or cross-consumer boundary to stage.

## Dependency graph and concurrency

```mermaid
flowchart LR
  P[Planning session PR merges] --> A[Phase 1: Seed personas]
```

No concurrency groups; nothing to serialize against. The only edge is the planning-session
prerequisite (the phase reads these plan artifacts from the default branch).

## Merge order

Phase 1 merges alone. Its merge releases nothing downstream; future workflow-builder phases
(4-6) are owned by `docs/plans/workflow-builder/` and are independent of these files.

## Cross-phase contracts

For later work (not scheduled here) that may build on the seed files:

- File naming: `docs/personas/<kebab-slug>.md`, one Persona per file, H1 = Persona name.
- The H1-name and whole-body-guidance contract is the Personas tab import contract; anything
  that later auto-imports or drift-checks these files must reuse
  `deriveImportedPersonaName` and `readPersonaImport` semantics rather than re-parse.
- The seed texts assume the engine's immutable prompt contract exists and deliberately do
  not restate it; a future engine-prompt change does not require editing the seeds unless it
  changes what a Persona may claim.

## Final verification strategy

- `npm run typecheck` and `npm test` green (the new test runs with the suite).
- Manual: `make start`, open `#/workflows/personas`, import each of the four files, confirm
  the derived name, and save. Confirm the README section renders and its instructions match
  the UI.
- The phase's exit criteria in `phase-1-seed-personas.md` are the binding list.
