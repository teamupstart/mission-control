# Phase 2: CLI operator commands

Part of [Headless Mission Control](plan.md). The phase index is [`phased-plan.md`](phased-plan.md).

## Outcome

Every day-to-day operator action can be done from a terminal, or by a harness through the
skill:

- list, inspect and tail sessions;
- send to a session, queue for it, interrupt, pause, resume or kill it;
- create, dispatch and cancel tasks;
- answer reviews, approve or reject them, and decide plans;
- reply to blockers;
- answer SDK permission dialogs.

## Entry criteria

- Phase 1 has merged: the CLI framework, the actor rule, and the skill and docs skeletons.

## Scope

- Command groups `sessions`, `control`, `tasks`, `review`, `plan`, `blocker`, `dialog` and
  `config`.
- Their skill and docs sections.

**Non-goals:**

- `inbox` and `watch` (Phase 3).
- `grant`, `resident launch` and `issue publish` (Phase 4).
- New daemon behaviour.

A route is added only if a command truly has none, and then it gets its schema in `src/shared/`.

## Repository findings

These routes come from `src/server/routes.ts` unless another file is named. Confirm each one
before you use it:

- **Sessions:** `GET /api/sessions` (2189), `/transcript` (4604), `/transcript/stream`
  (4566), `/pane` (4657), `/diff` (4902).
- **Control:** `/send` (6009), `/queue` (7042), `/interrupt` (6688), `/kill` (6648).
  `/pause`, `/resume` and `/api/pause/fleet` are in `src/server/pause/routes.ts`.
- **Tasks:** `GET`/`POST /api/tasks` (4329, 9011), `/dispatch` (9644), `/cancel` (9781).
- **Reviews:** `POST /api/reviews/:id/resolve` (5923).
- **Blockers:** `/api/sessions/:id/blocker/reply` (6209) and `/blocker/clear` (6223).
- **SDK dialogs:** `/select-option` (6092) and `/submit-options` (6138). The dialog shape is
  `session.dialog` (`src/server/sdk/dialog.ts`, `activePaneDialog` in `src/shared/session.ts`).
- **UI config:** `GET`/`PUT /api/ui/config` (8476).
- Managed plan reads are the same reads the dashboard's `ManagedPlanReader.tsx` uses. Reuse
  that route.

## Implementation steps

1. `commands/sessions.ts`:
   - `ls` (state, harness, title, id prefix);
   - `show <id>`;
   - `tail <id>` (transcript stream through `stream`, Ctrl-C to stop);
   - `pane <id>`;
   - `diff <id>`.

   An id can be given as a unique prefix. An ambiguous prefix exits 2 and lists the matches.
2. `commands/control.ts`: `send`, `queue`, `interrupt`, `pause`, `resume`, `kill` and
   `pause-all`. Text comes from an argument or from stdin (`-`). `kill` asks for confirmation
   on a TTY unless `--yes` is given.
3. `commands/tasks.ts`: `task add` (`--repo`, `--agent`, `--workflow`, `--dispatch`),
   `task ls`, `task dispatch <id>`, `task cancel <id>`. The defaults for `--repo` and
   `--workflow` come from `config`.
4. `commands/review.ts`:
   - `review ls` lists the pending reviews from `GET /api/reviews` or the `/events` snapshot,
     whichever the dashboard uses.
   - `answer <id> [--choice n | --text ...]` renders the options as a numbered list. On a
     TTY without flags it prompts. A free-text answer is accepted only for open questions.
   - `approve <id>`, `reject <id> [--reason]`.
5. `commands/plan.ts`:
   - `plan show <id> [--revision n]` prints the Markdown and the preview path.
   - `plan decide <review-id>` steps through each decision: radios as numbers, multi-select
     as comma lists, and `allowOther` as free text. It submits one resolve call. `--dismiss`
     dismisses the review.
6. `commands/blocker.ts` (`blocker reply <session> <text>`, `blocker clear <session>`) and
   `commands/dialog.ts` (`dialog <session>` shows the active dialog and takes
   `--option n`, or a multi-select list).
7. `commands/config.ts`: `config get|set default-repo|default-workflow`. It writes a
   `cli.defaults` key in `app_config` through a small new route with its schema in
   `src/shared/protocol.ts`. `app_config` is a key-value store, so it needs no migration.
8. Add each group to the registry, and fill in its section in `skills/headless/SKILL.md` and
   `docs/headless.md`.

## Compatibility

- Every request carries `actorHeaders()`. When the CLI runs inside a managed session, the
  daemon refuses operator-only actions exactly as it already does for agents, and the CLI
  prints the daemon's refusal text with exit 1.
- No route semantics change.

## Tests and verification

`test/cli-commands.test.ts` runs against the in-process HTTP app. For each group it covers:

- the request sent (method, path, body);
- human and `--json` output;
- prefix resolution;
- `answer`/`plan decide` choice mapping, including multi-select and `allowOther`;
- the TTY confirmation on `kill`;
- an operator-only action refused under the managed-session environment.

Run it with `node --test --import ./test/setup-state.mjs --import tsx test/cli-commands.test.ts`,
then `npm run typecheck`, `npm run lint` and `npm test`.

Manual check against a headless daemon:

- dispatch a task to Claude and to Pi;
- `tail` it;
- answer a `request_input`;
- decide a plan;
- `kill` it.

## Exit criteria

- Every command in the table in source-plan section 2 (except `inbox` and `watch`) works
  against a live daemon and has tests.
- The skill and docs sections are complete.

## Downstream handoff

Phases 3 and 4 add their own groups and do not edit these files. `review ls` remains the
review-only listing. `inbox` (Phase 3) is the cross-kind view.

## Cross-phase audit

- This phase consumes only the Phase 1 contracts.
- It does not touch `src/web`, `src/shared/attention.ts`, alert code or authorization code,
  so it can merge in either order with Phases 3 and 4.
- The only shared edit is one line per group in `commands/index.ts`.
