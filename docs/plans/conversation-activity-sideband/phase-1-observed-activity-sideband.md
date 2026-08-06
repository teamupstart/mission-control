# Phase 1: Observed activity sideband

Parent plan: [Conversation observed activity sideband](plan.md)

Phase index: [phased-plan.md](phased-plan.md)

Visual target: [Duplex Console mockup](../../mockups/conversation-terminal/02-duplex-console.html)

## Outcome

Conversation gains a responsive Observed activity sideband that lists transcript-recorded tool invocations using data Mission Control already has. The surface works in Console detail and expanded session cards, coexists with Conversation Find, preserves composer and scroll geometry, and clearly avoids unsupported lifecycle claims.

This document is the proposed implementation route, not a substitute for repository truth. The implementer should use engineering judgment, preserve the stated contracts, and record material deviations in the implementation PR.

## Entry conditions and dependencies

- The planning PR containing this document and the linked mockups is merged.
- The implementer has read `AGENTS.md`, `README.md`, `docs/agent-guides/architecture.md`, `docs/agent-guides/change-contracts.md`, and the complete `e2e/README.md`.
- No implementation phase precedes this one.
- Existing transcript, Find, and Conversation geometry tests pass at the starting revision.

## Scope

- Project each loaded transcript tool invocation into a compact observed-activity view model.
- Render a right-side activity rail at wide container widths.
- Provide a non-cramping stacked or collapsible treatment at narrow container widths.
- Let Conversation Find temporarily replace the activity rail and restore activity when Find closes.
- Cover empty, live-update, scrollback, reconnect-derived, and missing-input states without a second cache.
- Add unit, Electron geometry, and Playwright coverage.
- Document the meaning and limitation of Observed activity in the README.

## Non-goals

- New shared wire types, server events, routes, database schema, hooks, transcript formats, or polling loops.
- Tool result, success, failure, duration, output count, lifecycle, or OS process reporting.
- Raw tool input or output display beyond the current display-safe tool projection.
- Replacing inline transcript tool chips or changing transcript parsing semantics.
- Durable history beyond the loaded transcript window.

## Repository findings and contracts

### Canonical state

`src/web/components/TranscriptPanel.tsx` owns `messages: TranscriptMessage[]` and feeds them into the current transcript row model. Build the activity projection from that same array. Do not retain a separate event log in component state; doing so would introduce ordering, reconnect, and scrollback drift.

### Complete invocation coverage

`transcriptRows()` intentionally folds tool-only turns for the main log. It is not the correct input for activity because tool calls may also appear on messages that contain prose. Flatten `message.tools` directly in message order and tool-array order.

### Display projection

`src/web/lib/tools.ts` already contains `toolChip()` and the harness-neutral label and target behavior used by transcript chips. Reuse or extract that behavior so the transcript and activity rail cannot disagree. Missing or unrecognized input degrades to the normalized tool name.

### Layout ownership

Conversation Find already uses `.find-split` and a secondary `.find-rail`, with a container query that stacks narrow layouts. Extend this ownership model instead of adding a third competing column. While Find is open, Find must remain visible and own the rail. When it closes, Observed activity returns.

### Host parity

The shared `TranscriptPanel` renders in both Console detail and expanded cards. Keep host-specific branching out of the activity model. Use existing container behavior so both hosts receive the same feature and accessibility semantics.

### Honest language

The normalized transcript proves only that an invocation record was observed at the message's approximate time. Allowed terms include `Observed activity`, tool names, targets, and transcript time. Disallowed status implications include `running`, `complete`, `ok`, `failed`, duration, and output counts.

## Ordered implementation steps

### 1. Add a pure observed-activity projection

Work in `src/web/lib/tools.ts` or add a focused browser-safe module such as `src/web/lib/conversation-activity.ts` if separation improves ownership.

- Define a small presentation model containing a local key, timestamp, normalized label, optional target/detail, and accessible text.
- Flatten every `TranscriptMessage.tools` entry in canonical transcript order.
- Reuse the existing tool chip projection rather than duplicating harness-specific input parsing.
- Keep timestamp formatting presentational and consistent with Conversation conventions.
- Do not add fields to `ToolCall` or `TranscriptMessage`.

Add focused tests in `test/transcript-tools.test.ts` or a new `test/conversation-activity.test.ts` covering:

- mixed prose and tool turns;
- multiple calls in one message;
- missing and unknown inputs;
- stable ordering and local keys;
- repeated projection over the same messages without duplicate rows;
- older messages prepended ahead of current activity.

### 2. Build the accessible rail

Add a focused component such as `src/web/components/ConversationActivity.tsx` and integrate it from `src/web/components/TranscriptPanel.tsx`.

- Use a semantic section with a heading named `Observed activity`.
- Announce the stream connection separately from invocation outcome if connection state is shown.
- Render the empty state `No observed tool activity yet`.
- Keep row text compact and scannable, with a full accessible name when visual truncation is required.
- Reuse existing icons or typographic conventions. Do not add an unrelated icon system.
- Ensure controls have role- or label-based selectors and visible focus. Do not add `data-testid`.
- Respect reduced-motion preferences for any reveal or collapse transition.

Derive the rows during render or memoization from `messages`. Loading older transcript data and reconnect replacement must update activity through the existing transcript state path.

### 3. Resolve Find and responsive geometry

Update `src/web/components/TranscriptPanel.tsx` and the Conversation section of `src/web/styles.css`.

- At wide container widths, place transcript and Observed activity in the existing two-region Conversation frame.
- Give transcript and activity their own overflow regions while preserving the pinned composer.
- When Find is open, render Find in the secondary region and withhold the activity rail from that slot.
- Restore activity on Find close without losing transcript position or composer focus.
- At the existing narrow-container breakpoint, stack or collapse activity so the transcript retains a useful reading width.
- Prevent horizontal host-page overflow in Console detail and expanded cards.

Use the Duplex Console mockup as visual direction, not as literal markup or a source of unsupported status data. Keep the production surface aligned with Mission Control's existing design language.

### 4. Extend automated user-visible evidence

Update `test/transcript-scroll-electron.test.ts` and its existing fixture rather than creating a parallel geometry harness.

Assert, for both Console detail and expanded cards:

- wide layout with activity visible;
- Find open with Find owning the rail;
- Find closed with activity restored;
- narrow layout with transcript, composer, and activity reachable;
- composer pinned within its host;
- independent transcript and activity overflow without page overflow.

Add a Playwright scenario in `e2e/specs/dispatch-and-converse.spec.ts` or a focused Conversation spec. Use the fake-agent fixtures only. Extend the relevant fixture with deterministic transcript tool data if current records do not exercise every assertion.

The browser scenario must verify:

- the observed tool label and target appear after a fake transcript update;
- the UI says `Observed activity` and does not display lifecycle status for the row;
- a mixed prose/tool turn is represented;
- opening Find replaces the activity rail and closing Find restores it;
- the narrow layout remains operable by role, label, or visible text.

### 5. Document and complete the release bar

Update the Conversation section of `README.md` to explain:

- the rail reflects tool invocations observed in the loaded transcript;
- it is not a complete process list or tool-result monitor;
- Find temporarily takes over the secondary rail.

Review the diff for accidental wire, server, database, or harness changes. Any need for those is a scope expansion and must be documented before proceeding.

## Data and API compatibility

- No database migration.
- No new `ServerEvent`, SSE endpoint, HTTP route, hook field, or harness capability.
- No change to `TranscriptMessage`, `ToolCall`, transcript parser output, or eviction semantics.
- No second activity persistence or replay source.
- Existing transcripts with missing input continue to render using the tool name.
- All harnesses inherit the feature through the normalized transcript shape.

## Verification commands

Run focused checks while iterating, then the complete release bar from the repository root with Node.js 24 or newer.

```sh
node --test --test-concurrency=2 --import tsx test/transcript-tools.test.ts
node --test --test-concurrency=2 --import tsx test/conversation-activity.test.ts
node --test --test-concurrency=2 --import tsx test/transcript-scroll-electron.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/dispatch-and-converse.spec.ts
npm run test:e2e
```

Run only the focused unit command that matches the chosen test-file location. On macOS under the Codex seatbelt, request the repository-prescribed scoped outside-sandbox approval for real Electron tests. Install Playwright Chromium only if the machine does not already have it.

Perform a manual visual check at desktop and narrow container widths for Console detail and an expanded card, with Find both open and closed. Compare information hierarchy and density to the Duplex Console mockup while preserving the production design system.

## Merge and exit criteria

- Every acceptance criterion in `plan.md` is met.
- Projection tests cover ordering, mixed turns, missing input, and older scrollback.
- Electron geometry evidence covers both hosts, wide and narrow layouts, activity, Find takeover, and composer placement.
- Playwright proves the visible feature through the built dashboard and fake agents without model spend.
- Typecheck, lint, unit tests, build, smoke, and full e2e are green.
- README copy accurately states the observed-only contract.
- No unsupported lifecycle wording appears in code, tests, or docs.
- The implementation PR describes material deviations from this proposed route and includes concrete proof of work.

## Downstream handoff

There is no later implementation phase. If richer tool results or process telemetry are requested after this phase, treat that as a new plan with a new cross-harness activity contract. Do not stretch the transcript-derived presentation model into an implied lifecycle API.

## Cross-phase compatibility audit

Not applicable between implementation phases because this is the only phase. Before merge, audit the existing seams instead:

- browser projection consumes the unchanged normalized transcript contract;
- Find and activity have exclusive secondary-rail ownership;
- both Conversation hosts use the same component behavior;
- transcript state remains the sole source for live updates and history;
- future lifecycle telemetry is neither assumed nor blocked by this presentation-only model.
