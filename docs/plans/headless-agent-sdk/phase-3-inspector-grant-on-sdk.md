# Phase 3 - The Inspector's tool grant on the SDK transport

## Outcome

The Inspector's two calls - the PR review and its follow-up replies - can run on the SDK
transport with the same read-only tools and the same deny rules they enforce today. This is the
only caller in the codebase that holds any tools at all.

Engineering value: the tool grant stops being a hand-built `--settings` JSON string and becomes
options the SDK enforces, without weakening a single deny rule.

## Entry criteria and dependencies

- **Direct phase dependency: Phase 2.** `runClaudeSdkOneShot` exists and currently *refuses*
  grants; this phase replaces that refusal with an implementation. It is the only phase permitted
  to.
- Runs **concurrently with Phase 4**. Neither touches the other's files: this phase owns
  `src/server/inspector/` and the grant path in `claude-sdk.ts`; Phase 4 owns
  `src/server/foreman/`. Neither consumes a decision the other makes.

## Scope

In scope: rendering `LlmToolGrant` into SDK options, proving equivalence with today's deny
rules, and the Inspector's two call sites (B1, B2).

Explicit non-goals:

- **Widening the grant.** It stays `Read,Grep,Glob` (`src/server/llm/claude.ts:35`). A caller
  wanting `Bash` or `Write` edits that line and argues for it there, which is the point of the
  line existing.
- **`canUseTool`.** The SDK's permission callback is a live-session mechanism for asking a human.
  A headless review has nobody to ask, so the grant must be enforced by *rules*, not by a
  callback that would have to auto-answer - an auto-answering callback is a permission system
  that always says yes.
- **The Foreman.** Phase 4.
- **Changing the default transport.** Phase 5.

## Repository findings

### Five defence layers, four of them paid for by the grant

`src/server/inspector/worker.ts:255-307` documents them, and this phase must preserve all five:

1. **Provider-enforced deny rules.** `DENY_PATHS` (`:278-294`) covers `**/.env*`, `**/*.pem`,
   `**/*.key`, `**/id_rsa*`, `**/.git/config`, `**/.npmrc`, `**/.netrc`, `//Users/*/.aws/**`,
   `//Users/*/.ssh/**`, `//Users/*/.claude/**`, `//Users/*/.mission-control/**` and more. Every
   path is denied for **every** tool held, not just `Read` - because `Grep` on an absolute path
   prints the lines a `Read(...)`-only rule pretended to protect, and `Glob` confirms the file
   exists (`:272-276`).
2. **The worktree cwd as the read scope.** Under a headless run there is nobody to approve a read
   outside it, so the read fails instead (`claude-cli.ts:122-131`).
3. **The changed-path filter in the planner** (`worker.ts:838-839`).
4. **`scrubSecrets` on every outbound string** (`worker.ts:729`).
5. **`grantRefusal` before the spawn** (`src/shared/llm.ts:317-332`), which is shared rather than
   per-runner because every rule it checks is an interface violation rather than a provider quirk.

### The equivalence anchor already exists

`test/llm-runner-contract.test.ts:313-331` asserts that `claudeGrantSettings(...)` byte-equals the
Inspector's own `DENY_SETTINGS` constant, importing the real constants rather than a copy
(`:84`). That test is this phase's anchor: whatever the SDK path sends must reduce to the same
permission set, or `grantRefusal` must refuse it.

### `cwd` is a grant property, and it breaks a pruner assumption

A granted run must spawn in `grant.cwd` - the PR's worktree - not `HEADLESS_CWD`. That is already
true on the `-p` path and already known to put the Inspector's transcripts outside what
`goal/prune.ts` sweeps (`claude-cli.ts:180-183`). This phase inherits the gap rather than
creating it, and must say so rather than quietly widening it, because Phase 2 made transcript
continuity an exit criterion for the tool-less path.

### `settingSources` interacts with the grant

Phase 2 sets `settingSources: []` for determinism. A granted run passes `settings` carrying the
deny rules. Verify these compose: the deny payload must apply even with no setting sources
loaded, or the grant is silently unenforced - the exact failure `grantRefusal` exists to make
impossible.

## Implementation steps

1. **`src/server/llm/claude-sdk.ts`** - replace the phase-2 refusal with:
   - `grantRefusal(claudeRunner.sandbox, grant)` first, before anything is constructed. A grant
     this runner would only partly honour must not run at all.
   - `tools: [...grant.tools]` instead of `[]`.
   - `cwd: grant.cwd` instead of `HEADLESS_CWD`.
   - `settings` built by the **existing** `claudeGrantSettings(grant)`
     (`src/server/llm/claude.ts:49-55`), not a new renderer. One derivation of the deny rules, or
     the two transports drift the first time either is edited.

2. **Verify enforcement rather than assume it.** If the SDK's `settings` option does not apply
   the deny rules when `settingSources` is empty, the correct response is to make the composition
   explicit - not to drop `settingSources: []`, and never to ship the grant unenforced. If no
   composition enforces them, this phase **stops** and the Inspector stays on `print`; that is a
   legitimate outcome and must be reported rather than worked around.

3. **`src/server/inspector/worker.ts`** - no change expected. `inspectorRunOptions`
   (`:172-196`) already builds the grant capability-gated on `runner.sandbox` rather than on a
   runner id, which is the pattern that makes this transparent.

4. **Document the pruner gap** beside the `cwd` decision in `claude-sdk.ts`, pointing at the
   existing note in `claude-cli.ts:180-183` so there is one statement of it, not two.

## Tests and verification

- **Extend `test/llm-runner-contract.test.ts`** with the SDK mirrors of its three grant tests
  (`:313-363`):
  - a granted SDK run passes exactly `Read,Grep,Glob`, `cwd` equal to the grant's real path, and
    a `settings` payload byte-equal to the Inspector's `DENY_SETTINGS`;
  - a grant naming a tool outside `CLAUDE_GRANTABLE_TOOLS`, a relative `cwd`, or an empty
    `tools` array is refused **before** `query()` is called, asserted by the fake never being
    invoked;
  - the tool-less path still passes `tools: []`, proving the grant did not leak into it.
- **An enforcement test, not just a rendering test.** Rendering the right string is what the
  existing test proves. Prove the rules *bind*: script the fake to report a denied path and
  assert the run surfaces it as a failure rather than a result. If the seam cannot express that,
  say so in the PR rather than claiming coverage that does not exist.

```sh
node --test --test-concurrency=2 --import tsx test/llm-runner-contract.test.ts
npm run typecheck && npm run lint && npm test
npm run build && npm run smoke
```

## Merge and exit criteria

- The byte-equality anchor passes for the SDK path.
- With `MISSION_CLAUDE_TRANSPORT=sdk`, an Inspector review of a real PR produces a verdict of the
  same shape, with `role: "inspector:review"` ledger rows carrying a `runId`.
- No deny rule was removed, reworded, or scoped to fewer tools.
- The transcript-location gap is documented in one place, not two.

## Downstream handoff

Later phases may rely on:

- **The grant path being implemented and enforced**, so Phase 5's default flip does not leave the
  Inspector broken.
- **`claudeGrantSettings` remaining the single renderer** of deny rules for both transports.

Later phases must not change:

- `CLAUDE_GRANTABLE_TOOLS`, `DENY_PATHS`, or the path-major/tool-minor rendering that
  `test/llm-runner-contract.test.ts:313-331` pins.
- The capability gate in `inspectorRunOptions` (`worker.ts:186-190`), which is what keeps Codex
  correctly tool-less.

## Cross-phase audit record

- **Written third.** Reconciled against Phase 2: Phase 2 declared `cwd: HEADLESS_CWD` a fixed
  property and required a later phase that changes it to answer to the pruner. This phase changes
  it for granted runs only and discharges that obligation by documenting the inherited gap. No
  edit to Phase 2 was needed - its wording already anticipated this case.
- Reconciled against Phase 4 (written after this one): both depend only on Phase 2 and share no
  files. Phase 4 touches `src/server/foreman/`; this phase touches `src/server/inspector/` and the
  grant branch of `claude-sdk.ts`. Phase 4 adds no branch to that function, so the two merge in
  either order.
</content>
