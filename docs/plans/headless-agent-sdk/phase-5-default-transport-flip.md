# Phase 5 - Make the SDK transport the default

## Outcome

`claudeTransport` defaults to `"sdk"`. Every headless call the app makes for itself runs through
one transport, with `"print"` retained as the escape hatch an operator can pin.

Engineering value: the migration is actually delivered. Until this phase, the SDK path exists and
nobody uses it.

## Entry criteria and dependencies

- **Direct phase dependencies: Phase 3 AND Phase 4.** This is the join of the diamond. Flipping
  the default before the Inspector's grant works would run PR reviews with no tools; flipping it
  before the Foreman works would break the review loop in a separate process where the failure is
  harder to see.

## Scope

In scope: the default value, the operator-facing documentation, and the evidence that justifies
the flip.

Explicit non-goals:

- **Deleting `claude-cli.ts` or the `print` transport.** It stays as the escape hatch and as the
  comparison baseline. Deleting it is a later decision that wants time on the new default first.
- **Retiring `goal/prune.ts`.** Explicitly excluded by the approved decision: persistence stays
  on, so the sweep is still needed.
- **Live progress UI.** Considered and not adopted in the source plan.
- **The three excluded schemas from Phase 1.** They stay on the retry ladder.

## Repository findings

### The flip is one line and the risk is entirely in the evidence

`claudeTransportChoice()` (Phase 2) resolves config → env → shipped default. This phase changes
the shipped default. The code change is trivial; the work is proving it is safe, which is why
this is a phase rather than a footnote on Phase 4.

### The measurement that motivated the whole plan is the one to repeat

The Persona timeout investigation that started this work read `workflow_llm_calls` directly:

```sql
SELECT state, error_code, COUNT(*), MIN(duration_ms), AVG(duration_ms), MAX(duration_ms)
FROM workflow_llm_calls WHERE purpose='persona_review' GROUP BY state, error_code;
```

That table records `state`, `error_code`, `input_bytes`, `output_bytes` and `duration_ms` per
attempt, so it is the instrument for this phase too. A transport that is slower, or that fails
differently, will show up there before anyone notices it in the UI.

### `settingSources: []` is the behaviour change to measure

Phase 2 set it for determinism. Today's `-p` runs inherit whatever the CLI loads, which may
include the operator's `CLAUDE.md`. The source plan flagged this as needing an A/B rather than an
assumption, and this is the phase that owes that evidence: if reviewers get systematically
stricter or more lenient without their prompts changing, this is why.

### Two failure vocabularies must both stay legible

`workflow_llm_calls.error_code` distinguishes `persona_infrastructure` from `persona_parse`, and
the ensemble ledger classifies `interrupted` / `infrastructure` / `invalid_output`. An SDK error
or a `TerminalReason` must land in the same buckets, or the first production incident on the new
default is diagnosed against a category that silently changed meaning.

## Implementation steps

1. **Flip the default** in `claudeTransportChoice()`.
2. **Update `docs/configuration.md`** - `MISSION_CLAUDE_TRANSPORT` now documents `sdk` as the
   default and `print` as the escape hatch, with one sentence on when to reach for it.
3. **Update the linked technical docs** that describe how the app makes its own model calls, so
   the documentation matches the implementation. At minimum check `docs/foreman.md`,
   `docs/inspector-and-shipping.md` and `docs/workflows.md` for statements about `claude -p`.
4. **Map the failure vocabularies** if Phase 2 did not already: assert an SDK failure produces the
   same `error_code` a `-p` failure would have.

## Tests and verification

The automated suite is necessary and not sufficient here, because the thing being changed is a
default that every other test can pin explicitly.

- **Assert the default itself**, so a later edit cannot flip it back silently.
- **Assert the full suite passes with the default**, which is now the SDK path - this is the real
  coverage change, since every existing test that does not pin a transport now exercises the new
  one.

```sh
npm run typecheck && npm run lint && npm test
npm run build && npm run smoke
```

**Evidence required in the PR, not just tests:**

1. A before/after comparison on the same prompts for at least the Persona and Inspector paths,
   showing verdicts of the same shape and no systematic change in strictness. This is the
   `settingSources: []` A/B the source plan asked for.
2. `workflow_llm_calls` duration distributions before and after. The Persona ceiling is 600s
   since the timeout fix; a transport that shifts the distribution meaningfully toward it is a
   regression even if nothing times out yet.
3. Automation-line spend before and after, confirming roles, runIds and prices still land.

## Merge and exit criteria

- All commands pass with `sdk` as the shipped default.
- The three pieces of evidence above are attached to the PR.
- `print` still works when pinned, proven by a test that pins it.
- Documentation states the new default everywhere it previously stated the old one.

## Downstream handoff

There is no later phase. What a future change may rely on:

- **`ClaudeTransport` remains a real switch.** `print` is supported, not vestigial, until someone
  makes a separate argued decision to remove it - which wants a period of production time on the
  new default first.
- **The excluded Phase 1 schemas are still on the ladder**, and that is deliberate.
- **`goal/prune.ts` is still load-bearing.**

## Cross-phase audit record

- **Written fifth, and audited over the complete set.**
- Reconciled against Phase 4: Phase 4 leaves open how the worker learns the transport (`envVar`
  versus `LlmStatus`). This phase does not assume the answer - if Phase 4 chose `envVar`-only,
  the flip changes the daemon's default and the worker's default independently, and step 2's
  documentation must say so rather than describe a unified toggle that does not exist.
- Reconciled against Phase 3: the Inspector's granted runs spawn in `grant.cwd` and therefore
  litter outside the pruner's sweep. Flipping the default does not change that, and does not
  worsen it - it is the same gap the `-p` path has today. Recorded so the flip is not mistaken
  for its cause.
- Reconciled against Phase 1: `shapeGuaranteed` is still per call site. This phase must not use
  the flip as an occasion to set it globally.
- **Source-plan coverage check.** Every requirement of `plan.md` is owned by exactly one phase:
  the `--json-schema`/`outputFormat` win (1), the transport and its config, `abortController`,
  `maxBudgetUsd`, `stderr`, `settingSources`, transcript continuity (2), the Inspector's grant
  (3), the Foreman worker (4), the default (5). The approved decisions are honoured: no third
  `LlmRunnerId` anywhere, `persistSession` never turned off, no pruner retirement, and the latent
  driver bug excluded from every phase because it ships separately.
</content>
