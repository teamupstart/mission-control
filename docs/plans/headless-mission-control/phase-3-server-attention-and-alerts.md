# Phase 3: Server-side attention and headless alerts

Part of [Headless Mission Control](plan.md). The phase index is [`phased-plan.md`](phased-plan.md).

## Outcome

The daemon itself knows what needs you, and it tells you in three ways:

- `mission-control inbox` and `watch`;
- a macOS notification;
- an optional webhook or shell command.

The dashboard's Attention inbox looks and behaves exactly as before.

## Entry criteria

- Phase 1 has merged. This phase uses the CLI framework, `stream`, and `launchMode` in
  `/api/health`.

## Scope

1. Move `foldAttention` into `src/shared/`.
2. `GET /api/attention`.
3. The `attention_changed` server event.
4. `src/server/alerts/` with three sinks.
5. `inbox`, `watch` and `alerts` commands.
6. A Playwright regression spec.
7. Skill and docs sections.

**Non-goals:**

- Changing what counts as attention.
- Per-kind alert settings.
- Touch ID.

## Repository findings

- `foldAttention` and `AttentionInput` are in `src/web/lib/attention.ts:204,342`. The only
  import from outside `@shared` is `stateDisplay` from `./format.ts`.
  `src/web/lib/format.ts` itself imports only `@shared` modules. Check that there are no
  browser globals in the moved code.
- The dashboard narrows reviews to live sessions before folding (App's `answerableReviews`).
  The daemon must apply the same narrowing, and it should share it. Move the predicate with
  the fold, not a copy of it.
- Dismissals persist in `attention_dismissals` (`src/server/db.ts:4704`) and are read by
  `GET /api/attention/dismissals` (`routes.ts:9042`).
- The Alerts setting is `ui.alerts.{notifications,sound}` (`src/shared/protocol.ts:4449`). It
  is one toggle.
- `docs/agent-guides/change-contracts.md` requires every `ServerEvent` to be handled
  exhaustively in `src/web/useEventStream.ts`.

## Implementation steps

1. **Move the fold.** Move `foldAttention`, `AttentionInput`, `AttentionItem`, the dismissal
   key helpers, the live-review predicate, and the parts of `stateDisplay` the fold needs into
   `src/shared/attention.ts`. Use `src/shared/format.ts` too if `stateDisplay` has to move whole.
   `src/web/lib/attention.ts` re-exports or its importers switch over, whichever leaves fewer
   moving parts. Move the existing attention tests with the code.
2. **Daemon fold.** Add `src/server/attention.ts`, which builds `AttentionInput` from the
   registry, the reviews, ensembles, pipeline runs and commissions, tasks, resident runs and
   dismissals, and calls the shared fold. Add `GET /api/attention` with its response schema in
   `src/shared/protocol.ts`.
3. **Event.** Recompute on the same signals that already broadcast the inputs, debounced to
   about 250 ms. Emit `attention_changed {total, items}` only when the folded result differs.
   Add it to the `ServerEvent` union and handle it in `useEventStream.ts`; the dashboard may
   ignore the payload, because it keeps folding locally, but the case must exist.
4. **Alerts.** `src/server/alerts/index.ts` diffs successive folds into transitions: a new
   item, or an item whose occurrence changed. It hands each transition to every enabled sink.
   Failures are logged and never thrown.
   - `macos.ts` runs `osascript -e 'display notification "<summary>" with title "Mission
     Control"'` with the arguments escaped.

     It is enabled when all of these hold: `process.platform === "darwin"`,
     `ui.alerts.notifications` is on, and no dashboard client is subscribed to `/events`.
     Tell dashboard subscribers apart from CLI ones with a `client=cli` query parameter on
     the CLI's stream, so `watch` does not mute the macOS sink.
   - `outbound.ts` reads `alerts.outbound` from `app_config` (`{webhookUrl?, command?}`;
     https only for the URL). It POSTs or pipes the JSON
     `{kind, itemId, title, summary, sessionId?, taskId?, at}`, with a 10 s timeout and one
     retry. It must never include transcript or prompt text.
5. **Commands** (`commands/attention.ts`):
   - `inbox [--json]` reads `/api/attention`.
   - `watch [--json]` streams `/events?client=cli` and prints each `attention_changed`
     transition as one line, or NDJSON with `--json`.
   - In `commands/alerts.ts`: `alerts set --webhook <url> | --command <cmd> | --off`, and
     `alerts get`. It is a separate group, so it never collides with Phase 2's `config` group.
6. **Docs.** Add the headless channels to `docs/attention-and-alerts.md`, the outbound payload
   to `docs/security.md`, and this phase's sections to `skills/headless/SKILL.md` and
   `docs/headless.md`.

## Compatibility

- The dashboard behaves the same, because it uses the same fold function.
- `/api/attention` is new.
- `alerts.outbound` is a new `app_config` key, so no migration is needed.
- The macOS sink stays silent while a dashboard is connected, so desktop users get no
  duplicate notifications.

## Tests and verification

- `test/attention-fold.test.ts` (moved) passes unchanged from `src/shared/`.
- `test/attention-route.test.ts`: the in-process app with a pending review, a blocker and a
  dismissal. The route matches what the shared fold returns for the same input.
- `test/alerts.test.ts`:
  - transitions fire once, and nothing fires for an unchanged fold;
  - the macOS sink is gated on platform, the toggle and a dashboard subscriber (with an
    injected runner);
  - the outbound payload has no transcript or prompt field;
  - the webhook times out and retries;
  - a failing sink does not stop the others.
- `test/cli-attention.test.ts`: `inbox` and `watch` output, human and `--json`.
- `e2e/attention-inbox-headless.spec.ts`: with the fake agents, a pending review and a blocker
  appear in the Attention inbox, and dismissing one removes it. Select by role and label only.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run test:e2e`.
- Manual check: with a headless daemon and no dashboard open, trigger a `request_input`.
  A macOS notification appears, and `watch` prints it.

## Exit criteria

- One fold is shared by the dashboard and the daemon.
- `/api/attention`, the event, all three sinks and the commands work and are tested.
- The e2e spec passes.

## Downstream handoff

- `src/shared/attention.ts` is the only attention fold.
- `attention_changed` and `/api/attention` are stable contracts.
- The `?client=cli` subscriber marker belongs to this phase.

## Cross-phase audit

- This phase consumes only Phase 1.
- It does not edit Phase 2's group files. Alert settings use a separate `alerts` group, which resolved a `config` group-name collision
  with Phase 2 that the final audit found.
- It does not touch authorization, so it can merge in either order with Phases 2 and 4.
