# Phase 1: Memory convention and loading

## 1. Outcome

Mission Control understands the `.agents/memory/` repository memory convention. After
this phase, any target repo that carries a committed `.agents/memory/MEMORY.md` gets it
loaded into every MC review prompt (Inspector, personas, workflow context) through the
standards bundle, and pi dispatches into such a repo receive a one-line pointer to it in
their opening prompt. The shared constants this phase introduces are the contract every
later phase builds on. No memories exist anywhere yet; this phase makes MC ready for the
first one.

## 2. Entry criteria and dependencies

- None. This is the first phase.
- The approved source plan and this phase file are on the default branch (the planning
  PR has merged), so the paths this task names resolve.

## 3. Scope and non-goals

In scope:

- `src/shared/memory.ts` (new): the convention constants.
- `src/server/standards.ts`: include the memory index in the standards bundle.
- `src/server/dispatcher.ts`: pi-only memory pointer at dispatch.
- Focused tests in `test/` and README documentation.

Non-goals:

- No retro skill, session action, route, or UI (phases 2 and 3).
- No writes into any target repository. This phase only reads.
- No Claude/Codex dispatch changes: they load the committed root doc natively, which is
  the point of the convention (source plan, "Auto-loading into dispatched sessions").

## 4. Repository findings and inherited contracts

- `readStandards(repoRoot, changedPaths)` at `src/server/standards.ts:80` builds a
  `wanted` list: `ROOT_NAMES = ["AGENTS.md", "CLAUDE.md"]` pushed at `standards.ts:91`,
  then nested docs from the changed-path directory climb. A root-relative always-applies
  doc slots in as an additional push beside `ROOT_NAMES`; `join(root, subpath)` accepts
  subpaths and `readRepoDoc` (`src/server/util/repo-doc.ts:100`) already enforces
  containment and symlink safety. Caps: `MAX_FILE_BYTES = 24KB`, `MAX_TOTAL_BYTES =
  64KB`; `truncated` is reported, never swallowed. Push order controls both budget
  priority and the `realPath` identity dedupe, so the memory index is pushed AFTER the
  root names: AGENTS.md must win the budget and the citation.
- **Discrepancy corrected from the source plan:** pi's opening prompt never goes through
  `deliverIntent`. The dispatcher guards pi out of intent delivery
  (`dispatcher.ts:295`); turn one rides the launch argv via
  `preparePiLaunch(task.intent)` (`dispatcher.ts:229-231`,
  `src/server/harness/pi/launch.ts:22-26`). The pointer is therefore composed into the
  intent at the dispatcher call site: `preparePiLaunch(pointer + task.intent)`. The
  existing leading `-`/`@` guard in `preparePiLaunch` then sees the pointer's first
  character, which is safe, and the hazard characters land mid-string. `launch.ts`
  stays pure.
- `src/shared/` is browser-safe: no `node:` imports in the new module (AGENTS.md,
  controlled paths).

## 5. Implementation steps

1. Create `src/shared/memory.ts` exporting, with doc comments explaining the convention:
   - `MEMORY_DIR = ".agents/memory"`
   - `MEMORY_INDEX_PATH = ".agents/memory/MEMORY.md"`
   - `MEMORY_REFERENCE_MARKER = ".agents/memory/MEMORY.md"` (the stable substring the
     retro skill checks for in AGENTS.md; exported separately so the check and the path
     can diverge later without breaking the skill contract).
2. In `src/server/standards.ts`, add a `ROOT_EXTRA_PATHS = [MEMORY_INDEX_PATH]` list and
   push `join(root, name)` for each entry immediately after the `ROOT_NAMES` push at
   `standards.ts:91`. No other changes; the existing loop, caps, and dedupe do the rest.
3. In `src/server/dispatcher.ts`, in the pi branch (`dispatcher.ts:229-231`), check
   whether `join(wt.path, MEMORY_INDEX_PATH)` exists; when it does, prepend a single
   pointer line to the intent passed to `preparePiLaunch`, in the shape:
   `Before starting, read .agents/memory/MEMORY.md (repository agent memory).` followed
   by a blank line. Build the line from the shared constant, not a string literal.
4. Tests in `test/` (node:test, node:assert/strict):
   - standards: a fixture repo with `.agents/memory/MEMORY.md` sees the index in the
     bundle; a repo without it is unchanged; ordering keeps AGENTS.md first; an
     oversized index sets `truncated` without evicting the root docs.
   - dispatcher pi pointer: composed only when the file exists; an intent starting with
     `-` or `@` still gets the newline guard behavior when no pointer applies; the
     pointer text derives from `MEMORY_INDEX_PATH`.
5. README: a short section documenting the `.agents/memory/` convention: what lives
   there, that MC reads the index into review prompts, that pi dispatches get a pointer,
   and that the retro feature (later phases) is the writer.

## 6. Data, API, and migration details

None. No schema, protocol, or persisted-vocabulary changes. `StandardsBundle` shape is
unchanged; it just may contain one more `RepoDoc`.

## 7. Tests and verification

- `npm run typecheck`
- `npm run lint`
- `node --test --test-concurrency=2 --import tsx test/<new standards test>.ts` and the
  dispatcher test file
- `npm test`
- No e2e spec: this phase has no UI surface (AGENTS.md policy: pure server behavior
  belongs in `test/`).

## 8. Merge and exit criteria

- All of section 7 green locally and in CI.
- A fixture repo's memory index demonstrably reaches `readStandards` output, and a pi
  dispatch against a memory-carrying repo composes the pointer (both proven by tests).
- README documents the convention.
- No unrelated edits in the diff.

## 9. Downstream handoff

Later phases may rely on:

- `src/shared/memory.ts` and the exact exported names and values of `MEMORY_DIR`,
  `MEMORY_INDEX_PATH`, `MEMORY_REFERENCE_MARKER`. These values become paths committed
  into target repositories; they must never change after this phase merges.
- The standards bundle including `.agents/memory/MEMORY.md` when present.
- The pi pointer behavior at dispatch.

Later phases must not move the constants out of `src/shared/` (the web bundle imports
them in phase 3).

## 10. Cross-phase audit record

- 2026-08-04: Initial version. Pi pointer seam corrected from the source plan's
  `deliverIntent` to the `preparePiLaunch` call site after repository verification.
