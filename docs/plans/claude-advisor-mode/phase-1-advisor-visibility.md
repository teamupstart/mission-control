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

## Scope

- Parse advisor blocks in the shared Claude transcript parser.
- Render advisor rows in `TranscriptPanel`.
- Derive the session's advisor model in runtime meta and show a read-only chip.
- Pin advisor spend attribution with a unit test, and fix the envelope reader only if the test shows it is wrong.
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
- Block shapes, measured from Claude Code 2.1.317 binary strings; no real transcript sample exists on this machine:
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
6. **Spend.** Add a case to `test/claude-turn-usage.test.ts`: a result frame whose `modelUsage` holds an executor and an advisor model yields two `LlmSpendModelUsage` rows with their own costs.
   - If that already passes, `envelope.ts` stays unchanged.
   - If a real frame is later found to carry advisor tokens only in `usage.iterations` (entries of type `advisor_message`), that is a follow-up, not this phase. Note it in the PR.
7. **Fake agent.** In `e2e/fixtures/fake-claude.mjs`, add a deterministic prompt trigger, following the existing trigger pattern near line 231. It appends:
   - an assistant record carrying `advisorModel: "claude-opus-5-5"`, with a `server_tool_use` advisor block and an `advisor_tool_result` holding `advisor_result` text;
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
- `advisorModel` read from either location.

Add a `computeRuntimeMeta` case for the newest advisor model winning.

## Merge and exit criteria

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
- Checked against Phase 2: Phase 2 touches no file in this phase's parser, meta or transcript UI.
- The shared files are `fake-claude.mjs` (Phase 2 only adds an env field to the invocation record) and the docs section (Phase 2 appends). No conflicting decisions.
