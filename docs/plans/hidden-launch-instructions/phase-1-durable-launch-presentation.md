# Phase 1: Durable launch presentation

## Outcome and value

A person opening any fresh Mission Control-managed task conversation sees the human-authored task
request as the first user turn, not the complete platform launch contract. The agent still receives
the complete prompt, and Goal, Foreman, Workflow, Scout archive, review, retro, and other server-side
evidence consumers still read the complete native transcript turn.

This phase delivers the whole feature as one operable vertical slice across persistence, launch
delivery, transcript normalization, browser projection, documentation, and end-to-end verification.

## Entry criteria and direct dependencies

- Direct dependency: the planning session that publishes
  `docs/plans/hidden-launch-instructions/plan.md`,
  `docs/plans/hidden-launch-instructions/phased-plan.md`, and this phase file.
- The approved decision in the source plan is fixed: display `Task.intent`, keep the complete
  composed prompt everywhere outside the dashboard presentation layer.
- Start from a current default branch containing the published planning artifacts.

## Scope

- Classify non-empty prompts used to start fresh Mission Control-managed task conversations.
- Persist the classification across daemon restart and the initial provisional-to-native
  conversation-key bind.
- Attach additive launch presentation metadata to the matching normalized transcript message.
- Project the marked turn to the original human task request in every conversation-derived browser
  surface: Chat, Native, find-in-conversation, and Yours.
- Add focused tests, a failing-first Playwright regression, and user-facing documentation.

## Explicit non-goals

- Modifying, truncating, or deleting Claude, Codex, or Pi native transcript files.
- Changing the prompt delivered to an agent.
- Hiding a task assigned into an existing conversation, a human follow-up, a Foreman or Workflow
  turn, an empty resume, or any unmarked manual/discovered session.
- Backfilling old conversations by guessing that their first user turn was a launch.
- Changing Goal derivation, transcript paging limits, SSE byte anchors, or evidence retention.
- Adding a collapsed launch receipt or a reveal control.

## Repository findings and inherited contracts

- `src/server/dispatcher.ts` owns task launch composition and retains both the complete delivered
  prompt and `Task.intent` at the fresh-launch seams.
- `src/server/sdk/supervisor.ts` owns the only pre-registration window for SDK turn one. Marker
  persistence must precede session registration and the event pump so the first transcript stream
  cannot race ahead of its presentation metadata.
- Pi's actual delivered text includes `withRepoMemoryPointer(...)`. Fingerprint that final text, not
  the earlier shared `intent` variable.
- `src/server/transcript-attribution.ts` is the existing non-destructive overlay for normalized
  messages. Extend its responsibility semantically or introduce a sibling helper called from the
  same two route seams. Do not teach harness parsers about Mission Control task kinds.
- `TranscriptPanel` owns one transcript state and two renderings. Derive a projected array once and
  feed rows, find, and `ConversationActivity` from it while leaving history and stream offsets on the
  original messages.
- `TurnOrigin` remains authorship only. Use an additive presentation field, not a new origin value.
- Follow the test preload contract in the repository `AGENTS.md` for every focused Node command.

## Implementation steps

### 1. Reproduce the bug in the built dashboard first

Add or extend a Playwright spec, preferably in `e2e/specs/dispatch-and-converse.spec.ts`, that:

1. dispatches a task whose `Task.intent` is short and whose composed launch prompt contains a known
   platform-only sentence;
2. opens the real conversation pane after the fake SDK agent writes its native transcript;
3. initially fails because the platform-only launch text appears in the first user turn and in
   find or Yours;
4. independently reads the fake-agent launch record to prove the complete composed payload reached
   the provider boundary.

Keep all agent binaries faked and add no `data-testid` selectors.

### 2. Add a durable launch-presentation record

In `src/server/db.ts`, add a small table keyed by the same logical conversation key used by Goal and
notes. Store:

- the logical key;
- a stable fingerprint of the complete normalized launch text;
- the human display projection captured at launch;
- creation/update time needed for safe pruning.

Add typed read, upsert, move, delete/discard, load, and inactive-age prune operations following the
existing Goal and Foreman-invite persistence patterns. The table is marker state, not a second
transcript, so do not store the full composed prompt.

In `src/server/registry.ts`, own the in-memory projection and its lifecycle:

- record or stage a marker by session/logical key;
- discard a staged terminal marker when delivery is refused;
- move a marker from the provisional session key to the first native agent-session key;
- deliberately do not move it across native-to-native `/clear` rotation;
- prune only after sessions have been observed, protecting every current or exited-but-visible
  session key exactly as Goal pruning does;
- expose the current marker to transcript normalization without shipping the registry row on
  `Session` snapshots.

Hook marker pruning into the existing periodic Goal/invite maintenance pass rather than adding a
new timer or cleanup path.

### 3. Capture markers at every fresh managed launch seam

In `src/server/dispatcher.ts`:

- terminal Claude/Codex: record before `deliverIntent`, then discard if delivery throws or is not
  accepted;
- Pi: fingerprint the final memory-pointer-prefixed positional prompt, and record once the launched
  native identity is bound but before dispatch completion exposes a settled conversation;
- ordinary SDK dispatch: pass the complete prompt and `task.intent` into the supervisor launch
  presentation input;
- pipeline SDK dispatch: do the same with `launch.prompt` and the pipeline task's `intent`;
- terminal pipeline host: leave unchanged because it launches the Conductor host, not a directly
  streamable agent conversation.

In `src/server/sdk/supervisor.ts`, carry the optional launch-presentation input through `start` and
`adopt`. Persist it under the provisional key before `registerSdkSession` and before starting the
event pump. A direct supervisor caller that supplies no presentation metadata remains unchanged.

Presentation persistence is secondary to agent delivery. If a marker write fails after the agent
accepted turn one, log the loss without terminating or duplicating the agent session. Before-delivery
terminal state must still be discarded when delivery itself fails.

### 4. Extend the normalized transcript wire shape additively

In `src/shared/types.ts`, add an optional, semantic presentation object to `TranscriptMessage`, for
example a discriminated `kind: "launch"` carrying `displayText: string | null`. Do not overload
`origin`, mutate `text` on the server, or make the new field required for old clients and fixtures.

In `src/server/transcript-attribution.ts` and both transcript response seams
(`src/server/transcript-stream.ts` and the backward-page route in `src/server/routes.ts`), attach the
presentation only when all of these hold:

- the message is a user-role text turn;
- the current logical conversation has a durable launch marker;
- the normalized message text matches the recorded full-prompt fingerprint.

Preserve the native message id and every existing field. Messages without a marker or without a
match remain byte-for-byte equivalent on the wire to current behavior. Ensure both initial/resume/
append SSE frames and older pages use the same decoration path.

### 5. Project once for every browser conversation surface

Add a pure browser-safe helper under `src/web/lib/` that maps marked messages as follows:

- `displayText` present and non-empty: return the same message identity with `text` replaced by that
  human projection and with no platform text exposed to downstream display helpers;
- `displayText` absent: omit the marked turn rather than inventing a human message;
- no presentation marker: return the original message unchanged.

In `src/web/components/TranscriptPanel.tsx`, derive projected messages once from the unfiltered
`messages` state. Use that projected array for `transcriptRows`, `mergeConversation`, find indexing,
empty-state behavior, and `ConversationActivity`. Keep SSE merge, transcript-history caching,
backward paging, and byte positions on the original array.

Preserve ids so Yours rows and find hits still jump to the rendered turn. Ensure Chat and Native
renderings display the same projection and that a launch projection containing no tools cannot alter
Activity semantics.

### 6. Update documentation

Update `docs/sessions.md` at the dispatch/transcript and conversation-window sections. Explain that
fresh managed launches still record the full composed turn for the agent and evidence history, while
the dashboard displays only the human task request. State the exclusions for assignments into live
sessions, follow-ups, automation, resumes, manual sessions, and unmarked historical transcripts.

Do not document the single-test preload command beyond the repository `AGENTS.md` boundary.

## Data, API, migration, and compatibility details

- The SQLite change must be idempotent for existing databases and open safely on upgrade.
- The marker table is additive and empty for every existing installation. Absence means current
  rendering, providing downgrade and old-data compatibility without backfill.
- Normalize fingerprint input the same way harness transcript adapters normalize user text, at
  minimum trimming surrounding whitespace. Use one shared helper for capture and comparison.
- Store the human projection as it existed at dispatch so later task edits cannot rewrite visible
  history.
- Do not expose marker rows through general task/session APIs. Only the optional per-message
  presentation field crosses to the browser.
- Clear must select a new logical key with no marker. Initial synthetic-to-native binding is the
  only key movement allowed.
- Reconnect `pos`, initial `start`, `atStart`, and older-page `before` continue to describe the
  native file. Projecting display text never participates in offset math.

## Tests and verification

### Focused tests

- Persistence: round-trip, replacement, initial key move, discard, safe empty-live-set prune, and
  no move across clear.
- Registry/dispatcher: ordinary terminal pre-delivery marker and rollback, Pi exact delivered text,
  ordinary SDK propagation, pipeline SDK propagation, and no marker for live-session assignment.
- SDK supervisor: marker exists before the registered session can stream and survives restore data
  reload without replaying turn one.
- Attribution: only the matching user turn is marked; assistant, tool-only, unmarked, and mismatched
  turns are unchanged; stream and backward pages agree.
- Browser projection: display text replacement preserves identity and metadata, null projection
  omits, unmarked returns original, full platform text is absent from find, and Yours indexes the
  human request.
- Compatibility: manual/discovered, empty-resume, assigned, post-clear, and old transcript cases
  retain their real first user turn.

Use the repository preload for individual Node test files:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/<focused-file>.test.ts
```

### End-to-end

Run the focused built-dashboard spec after `npm run build`. It must prove:

- the first visible user turn is exactly the human task request in Chat view;
- the same projection appears in Native view;
- a platform-only launch sentence is absent from the log, find results, and Yours;
- a later human follow-up still appears and is searchable;
- the fake agent received the complete composed prompt;
- reload does not reveal the full launch text.

Use role, label, placeholder, or existing structural selectors. Save optional success evidence only
under the gitignored `e2e/.artifacts/` path and never commit it.

### Required command bar

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/dispatch-and-converse.spec.ts
```

Run the broader E2E suite if focused changes expose shared conversation regressions. On macOS under
the Codex seatbelt, run Electron-bearing tests with the scoped outside-sandbox approval required by
the repository instructions.

## Merge and exit criteria

- One reviewable pull request contains the durable marker, every launch seam, additive wire field,
  browser projection, documentation, and tests.
- The Playwright spec demonstrates the pre-fix failure and post-fix behavior through the real built
  dashboard without spending model tokens.
- The fake provider record proves full prompt delivery; server-side transcript tests prove evidence
  text remains full.
- Existing databases migrate safely; old and unmarked transcripts render unchanged.
- Chat, Native, find, and Yours agree on the human projection.
- All required commands pass, with any unrelated base-branch failure identified rather than hidden.
- The pull request is green with no unresolved actionable review comments.

## Downstream handoff

There are no later implementation phases. After merge, downstream work may rely on:

- `TranscriptMessage` optionally carrying semantic launch presentation metadata;
- native transcript text remaining authoritative for server consumers;
- browser conversation surfaces consuming the shared display projection;
- unmarked turns retaining current behavior.

Future presentation kinds may extend the discriminated field, but must not repurpose launch
metadata, overload authorship, or move visibility decisions into provider-specific parsers.

## Cross-phase audit record

- Initial audit: the single phase owns every approved requirement and no rejected receipt/full-hide
  option remains.
- Compatibility audit: persistence precedes every UI consumer, the UI preserves native ids, and
  unprojected byte history remains authoritative.
- Dependency audit: the only direct dependency is the planning session that publishes this file;
  there are no concurrent or downstream phases.
- Final audit: tests, documentation, migration behavior, and cleanup/pruning live with the behavior
  they introduce, so no unplanned cleanup phase is required.
