# Phase 1: Advisor visibility

Plan: `docs/plans/claude-advisor-mode/plan.md`. Index: `docs/plans/claude-advisor-mode/phased-plan.md`.

## Outcome

Operators who already set `advisorModel` in their Claude Code settings can see the advisor working:

- Each advisor call appears as a row in the session transcript.
- The session header shows which advisor model the session used.
- Advisor tokens are attributed to the advisor model in spend.
- The docs explain that Mission Control inherits the setting.

No configuration is added in this phase.

## Entry criteria

The planning session's pull request has merged, so the plan files exist on the default branch. There are no phase prerequisites.

## Gate: probe one real advisor call first

The block shapes, the location of `advisorModel`, and where advisor tokens are reported all come from CLI binary strings. No real sample exists. Before building fixtures or tests on them, capture one real advisor call:

1. In a scratch directory, run one short headless turn with an advisor attached:

   ```sh
   claude -p --model sonnet --settings '{"advisorModel":"opus"}' --output-format json "<a small task that asks Claude to consult its advisor before answering>"
   ```

   This costs one small paid turn on the operator's account, outside any test. Use `--settings` rather than editing `~/.claude/settings.json`. If the account lacks the advisor feature flag, set `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1` for the probe only.
2. Keep the printed result frame. Record whether `modelUsage` contains the advisor model and whether `usage.iterations` has `advisor_message` entries.
3. Open the session's JSONL transcript under `~/.claude/projects/` and copy the assistant records for the advisor call. Record where `advisorModel` appears and the exact `server_tool_use` and `advisor_tool_result` shapes.
4. Save a sanitized copy of both under `test/fixtures/` (a captured fixture, with ids and any account data replaced). The unit tests and the fake agent use that captured shape, not the inferred one.

**If no real advisor call can be captured** (the CLI or API refuses the advisor even with the experimental variable), stop. Open no PR. Report the probe's output back to the human so they can decide how to proceed. Do not ship this phase on inferred shapes.

When the probe succeeds, include its findings (field locations and which usage field carried advisor tokens) in the PR description.

## Scope

- Parse advisor blocks in the shared Claude transcript parser.
- Render advisor rows in `TranscriptPanel`.
- Derive the session's advisor model in runtime meta and show a read-only chip.
- Attribute advisor tokens to the advisor model from the field the probe observed, with a unit test built from the captured frame.
- Add a fake-agent trigger for advisor blocks.
- Add an e2e spec.
- Add the `### Advisor` docs section.

## Non-goals

- Any dispatch, task, capability or launch change (Phase 2).
- Live advisor control.
- Reading effective Claude settings to guess whether an advisor is configured but not yet called.
- Codex or Pi.

## Repository findings this phase relies on

- `toMessage` (`src/server/harness/claude/transcript.ts:99-146`) renders both terminal and SDK transcripts, because the SDK subprocess writes the same JSONL. Today its block loop drops anything other than `text`, `tool_use` and `tool_result`.
- `computeRuntimeMeta` (`src/server/harness/claude/meta.ts:155`) reads the newest main-chain assistant record for model and usage. That is the place to read `advisorModel`.
- `SessionMeta` (`src/shared/types.ts:286-300`) and `RuntimeMetaRow` (`src/web/components/session-bits.tsx:1879`), which renders `ModelPicker` and `EffortPicker`, are where the chip goes. The board tile at `src/web/components/layouts/SessionTile.tsx:544` has its own copy of the row.
- Transcript UI: `src/web/components/TranscriptPanel.tsx` (`ToolChips` :2256, `Turn` :1867, `TerminalTurn` :2069) and `src/web/lib/tools.ts` (`transcriptRows` :359).
- Spend: `claudeEnvelopeModels` (`src/server/harness/claude/envelope.ts:61-97`) is covered by `test/claude-turn-usage.test.ts`.
- Block shapes, measured from Claude Code 2.1.317 binary strings; no real transcript sample exists on this machine, which is why the probe gate comes first. Where the probe disagrees with these, the probe wins:
  - assistant content `{type: "server_tool_use", name: "advisor", id, input: {}}` followed by `{type: "advisor_tool_result", tool_use_id, content}`;
  - `content.type` is one of `advisor_result` (with `text`), `advisor_redacted_result`, or `advisor_tool_result_error` (with `error_code`);
  - a result may carry `stop_reason: "refusal"`, which the CLI shows as "Advisor declined to advise on this request";
  - assistant records carry an internal `advisorModel` field. That it sits at the record's top level is inferred, about 75%. Read it from either the record or `message`, and tolerate both being absent.

## Implementation steps

1. **Shared type.** Add the following to `TranscriptMessage` in `src/shared/types.ts`, with a doc comment naming the source blocks:

   ```ts
   advisor?: { model: string | null; outcome: "advised" | "redacted" | "declined" | "error"; text?: string; errorCode?: string }
   ```

   Add `advisorModel?: string | null` to `SessionMeta`.
2. **Parser.** In `toMessage`, handle the two block types:
   - `server_tool_use` with `name === "advisor"`: no tool chip. It is the call marker, and the CLI also hides it.
   - `advisor_tool_result`: map `content.type` to `outcome`, keep `text` only for `advisor_result`, and keep `error_code`.
   - Any other `content.type`, or a malformed block: ignore it, as the CLI does.

   A message whose only content is an advisor result must still produce a message, so update the empty-message guard. Read the advisor model from `rec.advisorModel ?? m.advisorModel`.
3. **Runtime meta.** In `computeRuntimeMeta`, set `advisorModel` from the newest main-chain assistant record that carries one. Leave it absent when none does, and do not let a missing advisor stop the existing early return.
4. **Transcript UI.**
   - Render a compact advisor row in both `Turn` and `TerminalTurn`.
   - `advised` reads "Advisor (<model>) reviewed the conversation". The advisor text sits in a collapsed disclosure, closed by default, because it can be long.
   - `redacted` shows the same label with no text. `declined` reads "Advisor declined to advise on this request". `error` reads "Advisor unavailable (<code>)".
   - Use existing transcript row styles. Any new CSS goes in `src/web/styles.css`, beside the tool-chip rules.
5. **Session chip.** In `RuntimeMetaRow` and the `SessionTile` copy, render a read-only chip "Advisor: <model>" when `meta.advisorModel` is set.
   - It needs an accessible name, for example `aria-label="Advisor model"`.
   - Add no `data-testid`.
   - It is not a picker.
6. **Spend.** Add a case to `test/claude-turn-usage.test.ts` built from the probe's captured result frame. It must show the advisor's tokens attributed to the advisor model as their own `LlmSpendModelUsage` row.
   - If the real frame reports advisor tokens in `modelUsage` under the advisor model, `claudeEnvelopeModels` already does this and `envelope.ts` stays unchanged.
   - If the real frame reports them only in `usage.iterations` (entries of type `advisor_message`), extend `claudeEnvelopeModels` (`src/server/harness/claude/envelope.ts`) to emit a row per advisor model from those entries, without double-counting tokens already in `modelUsage`. This is part of this phase.
7. **Fake agent.** In `e2e/fixtures/fake-claude.mjs`, add a deterministic prompt trigger, following the existing trigger pattern near line 231. Copy the record shapes from the probe's captured transcript, including where `advisorModel` sits. It appends:
   - an assistant record carrying the advisor model at the observed location, with a `server_tool_use` advisor block and an `advisor_tool_result` holding `advisor_result` text;
   - a second record with `advisor_tool_result_error`.
8. **E2e spec.** Add `e2e/specs/advisor-visibility.spec.ts`. Dispatch a Claude task whose prompt hits the trigger, open the session, and assert:
   - the advisor row label is visible;
   - its disclosure reveals the advisor text;
   - the error row reads "Advisor unavailable";
   - the header chip named "Advisor model" shows the model.

   Select by role, label or text. Spend no model tokens.
9. **Docs.** Add `### Advisor` to `docs/dispatch-and-backlog.md`, beside `### Default effort`. Cover:
   - what the advisor is;
   - that Mission Control sessions inherit `advisorModel` from user, project and local settings on both runtimes;
   - the gating (first-party API only, server feature flag, `CLAUDE_CODE_DISABLE_ADVISOR_TOOL`);
   - the pairing rule;
   - that typing `/advisor` in any session writes the operator's global `~/.claude/settings.json`;
   - that Mission Control has no per-dispatch override yet.

   Add one line under `## Task kinds` in `docs/models.md` pointing to it. Use no em dashes.

## Tests and verification

```sh
node --test --import ./test/setup-state.mjs --import tsx test/claude-turn-usage.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/<the transcript parser test file>.test.ts
npm run typecheck && npm run lint
npm run build && npx playwright test e2e/specs/advisor-visibility.spec.ts
```

Add parser unit cases beside the existing `toMessage` tests (find them with `grep -rl "toMessage" test/`):

- advised, redacted, declined and error results;
- an unknown `content.type`;
- `server_tool_use` producing no chip;
- an advisor-only message being kept;
- `advisorModel` read from the location the probe observed, using the captured fixture.

Add a `computeRuntimeMeta` case for the newest advisor model winning, using the captured transcript fixture.

## Merge and exit criteria

- The probe gate captured a real advisor call; its fixtures are committed and its findings are in the PR.
- Advisor tokens from the captured frame are attributed to the advisor model, whichever usage field carried them.
- Transcripts without advisor blocks render byte-for-byte as before; the existing parser tests pass unchanged.
- The new spec passes against the build. Typecheck, lint and the unit shards are green.
- Docs describe inheritance and the global-write caveat.

## Downstream handoff

Phase 2 may rely on:

- `TranscriptMessage.advisor` and `SessionMeta.advisorModel` exactly as defined here;
- the advisor trigger in `fake-claude.mjs`;
- the `### Advisor` docs section.

Phase 2 must not change those shapes or the trigger's output. It may append to the docs section and to the fake's invocation record.

## Cross-phase audit

- Written first. It owns every shared shape listed in the index's cross-phase contracts that Phase 2 consumes.
- Repair round 1: advisor spend attribution, including the `usage.iterations` case, is owned here, not deferred, matching the root plan. A real-advisor probe gate now precedes fixtures and tests, so the chip and spend tests rest on captured shapes. Phase 2 is unaffected beyond reusing the captured fixture through the fake agent.
- Checked against Phase 2: Phase 2 touches no file in this phase's parser, meta or transcript UI.
- The shared files are `fake-claude.mjs` (Phase 2 only adds an env field to the invocation record) and the docs section (Phase 2 appends). No conflicting decisions.
