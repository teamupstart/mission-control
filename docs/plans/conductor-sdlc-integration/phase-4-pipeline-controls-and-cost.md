# Phase 4: Pipeline controls and cost

## Outcome

The dashboard can act on a pipeline, not just watch it: daemon start/stop/pause/resume,
park/unpark, DECIDE re-entry grants (with `plan` excluded, as conductor itself enforces), a
hosted daemon console, and a hosted terminal for the reseal ceremony. Attention rows gain their
verb buttons and resolve when the halt clears. Conductor's per-feature usage totals roll into
MC's spend ledger under a new append-only writer id.

## Entry criteria and dependencies

- Direct prerequisites: Phase 2 (the run detail's reserved header action slot) and Phase 3
  (the `pipeline_halt` rows the verbs attach to).
- Transitively phase 1 (the pipelines module and projection).

## Scope

- **`src/server/pipelines/conductor/control.ts`** (new): spawn conductor CLI verbs - daemon
  start/stop/pause/resume, park/unpark, `decide-grant`, and reseal - and validate each
  invocation by parsing its expected stdout, never by exit code alone (conductor's engineer
  verbs exit 0 on malformed invocations; this is a documented conductor limitation). Refuse
  `decide-grant --step plan` MC-side before spawning, mirroring conductor's own refusal, so the
  UI can explain rather than relay a CLI error. The module still never writes a conductor-owned
  file: the CLI is the only mutation path.
- **Action routes** in `src/server/routes.ts` under `/api/` (loopback-guarded like their
  neighbors), one per verb, keyed by `(provider, repo, slug)` and validated with Zod schemas
  via `parseBody`. Every action re-projects the run afterward and emits `pipeline_upsert`, so
  the UI converges without polling.
- **Hosted consoles**: "Open daemon console" attaches through conductor's sanctioned
  `daemon connect --attach-into <tmux target>` into an MC-hosted terminal; "Open reseal
  terminal" hosts an interactive terminal running the reseal verb, because conductor refuses
  reseal on a non-TTY (the ceremony is deliberate). Use the existing terminal-hosting
  mechanisms under `src/server/terminal/`; write policy stays in `actions.ts` per the module
  boundaries.
- **UI wiring**: the phase 2 header action slot gets Console, Park/Unpark, and
  Grant DECIDE re-entry (a small picker over the grantable steps, `plan` absent with a note,
  since a plan grant can never be issued); the phase 3 attention rows get the matching verbs
  per halt class (`needs-human`: grant/unpark plus runbook; `protected-artifact`: open reseal
  terminal; `mechanical`: unpark). The daemon chip in the Pipelines rail reflects
  pidfile/PAUSED transitions live.
- **Cost roll-in**: conductor's per-feature usage totals enter `usage_ledger` under a fifth
  append-only writer id `conductor` with `spend_kind: "automation"`, following the four
  existing hardcoded-INSERT patterns in `src/server/db.ts`; the change-contracts writer-id list
  gains the id in the same commit. Idempotent upserts keyed per feature, so re-projection never
  double-counts; the run detail and existing spend surfaces show the figure.

## Non-goals

- No ingest route or plugin (phase 5). No dispatch kind or Foreman triage (phase 6). No new
  conductor verbs: only what conductor's CLI already offers, spawned as-is.

## Repository findings

Verified at `dc2d99a` (MC) and `8b51392d` (conductor):

- Conductor's control surface: `daemon start/stop/pause/resume` (pause/resume work but are
  undeclared in the help tree), park/unpark markers under `.daemon/parked/`, grants under
  `.daemon/grants/`, `decide-grant` refusing `--step plan`, reseal refusing non-TTY, and
  `daemon connect --attach-into <tmux target>` as the sanctioned console attach.
- `usage_ledger` has four hardcoded writer ids (otel, driver, rollout, report; INSERT sites
  around `src/server/db.ts:5273-5519`); writer ids are append-only per the change contracts.
- Terminal hosting mechanisms live in `src/server/terminal/`; policy belongs in `actions.ts`.
- The Foreman worker never touches SQLite; nothing in this phase may hand it a database path.

## Implementation steps

1. `control.ts` with per-verb stdout validators; unit tests over canned stdout transcripts
   (success, malformed-but-exit-0, daemon-absent) using the fake `conduct-ts`.
2. Action routes with Zod schemas; unit/HTTP tests for each verb, the plan-grant refusal, and
   the post-action re-projection event.
3. Hosted console and reseal terminal through the existing terminal backends.
4. UI: header actions, attention verbs, grant picker, daemon chip transitions.
5. Cost roll-in with idempotency tests and the change-contracts edit.
6. E2E on the fake CLI and fixture tree.

## Data and compatibility

- New writer id `conductor` is append-only from this commit; no schema change to
  `usage_ledger` itself.
- Actions are conductor-version-tolerant: an unrecognized stdout shape surfaces as a failed
  action with the captured output, never as a silent success.

## Tests and verification

- Unit: stdout validators, plan-grant refusal, idempotent cost upserts, re-projection on
  action.
- E2E: an attention action drives the fake CLI and the row resolves when the fixture halt
  clears; the daemon chip follows fixture pidfile/PAUSED transitions; the grant picker never
  offers `plan`; the reseal button opens a hosted terminal (fake ceremony); cost figure
  appears on the run detail.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
  `npm run smoke`, `npm run test:e2e`.

## Merge and exit criteria

- Definition of done per AGENTS.md; README and docs cover the actions and the writer id.
- With the integration disabled, no action route acts and no console can be opened.
- One reviewable PR; its merge releases phase 6.

## Downstream handoff

- The action route surface `(provider, repo, slug)` plus verb: phase 6's Foreman triage calls
  these routes (through the daemon, never SQLite) and must not grow a parallel control path.
- The `conductor` usage writer id (append-only).
- The stdout-validation posture: any future verb addition validates output, never exit codes.

## Cross-phase audit record

- 2026-08-14: initial version. Depends on phases 2 and 3 (direct) for the surfaces its verbs
  mount on; phase 1 is transitive. Cost roll-in placed here rather than phase 1 because the
  figures come from conductor state the control/refresh path already re-reads, and the writer
  id belongs in the same commit as its first INSERT.
