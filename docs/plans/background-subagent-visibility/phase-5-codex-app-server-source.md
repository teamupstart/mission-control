# Phase 5: Codex app-server source

Source: [plan.md](plan.md). Index: [phased-plan.md](phased-plan.md).

## Outcome

Codex SDK (app-server) sessions, the default Codex runtime for dispatch, populate Session.subagents from Codex's own thread-tree frames, so their background children show in the chosen treatment.

## Entry and scope

Entry: Phase 1 merged. In: a reducer in the Codex adapter, the SdkEvent emission, a fake Codex scenario, docs/harnesses-and-terminals.md. Out: hooks (4); any change to frame muting, routing or PR authorship.

## Repository findings

- codex/sdk.ts consume() (924-1053) handles item/started and item/completed (973-1007); learnThreadTree (1108-1127) keeps parent edges only; itemActivity returns null for collab items (1402-1424); isCurrentThread drops child turn and status frames (932-956).
- Thread has parentThreadId, preview, createdAt, status, agentNickname, agentRole (protocol.ts:885-975); collabAgentToolCall has tool, status, receiverThreadIds, prompt (518-555); subAgentActivity has kind (436, 555). No item has a timestamp.
- isRetired and isOwnTree guard display and PR authorship; capped() bounds maps (293-324). F8.

## Steps

1. Reducer: spawnAgent or thread/started under this tree adds a child (type from agentRole or agentNickname, description from the spawn prompt or preview, startedAt on receipt); subAgentActivity and CollabAgentState set running, completed, failed (errored) or stopped (interrupted, shutdown); children named by an in-progress wait are hidden until it ends; retired trees dropped; capped.
2. Emit SdkEvent subagents per F5; fold on the accepted operator turn (F1).
3. Leave routing, muting and isOwnTree unchanged.
4. Fake Codex scenario: spawn two children, end the parent turn with them running, complete one.

## Tests

- Unit: scripted frames for spawn, wait-hidden, completion, error, interrupt, retired tree, cap; existing PR-authorship tests pass unchanged.
- e2e/specs/codex-background-agents.spec.ts, like codex-item-completed-conversation.spec.ts: a Codex dispatch shows sub-cards for its children.
- npm run typecheck, lint, focused tests, build, test:e2e.

## Exit and handoff

Merged with the spec green. No contract changes.

## Audit record

Emits the Phase 1 SdkEvent through the existing applyDriverEvent case; launchTurnId stays null.
