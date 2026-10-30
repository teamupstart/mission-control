# Phase 6: Session control through the Launch click

Part of [the phased plan](phased-plan.md) for [Residents](plan.md).

## Outcome

A profile with **Control other sessions** on gives its run the existing session-control grant
when the operator launches it with a click in the desktop app. The grant belongs to that run and
survives a daemon restart for the same conversation and task. Launches from anywhere else start
without control and say so.

## Entry criteria and dependencies

- Phase 2 merged (the Console band and dock rows that display grant status). Phase 2 itself
  follows Phase 1, which provides `launchResident()`, the launch route and the run row.

## Scope

- Profile section `authority`: `controlOtherSessions` (default off).
- A trusted resident-launch click in Electron main and preload.
- Daemon consumption of the authorization at launch, a durable per-run grant record, and
  reapplication on restore.
- `docs/security.md` amendment.

### Non-goals

Any other way to create a grant; changing the closed session-control action set.

## Repository findings and inherited contracts

- Grants live in `Registry.sessionControlGrants` (`src/server/registry.ts`), keyed by
  `sessionControlIdentity`: process id, native conversation, cwd, work episode and task.
  `setSessionControlEnabled` applies them.
- Trusted clicks are registered through `serveDashboardClick` (`src/main/dashboard-click-ipc.ts`)
  in `src/main/index.ts`; authorizations are armed in `src/main/session-control-authorization.ts`
  and consumed over the private channel in `src/server/session-control-authorization.ts`, with a
  15-second single-use window. Standalone daemons fail closed.
- The current contract (`docs/security.md`, Delegated session control): "Neither dispatch
  defaults nor a session-control tool can create a grant."
- An Electron capability spans `ipcMain.handle`, `contextBridge`, `src/web/mission-desktop.d.ts`
  and a guarded browser call site.
- Inherited: `launchResident()` is the only browser launch call (Phase 1); the Console band and
  dock rows (Phase 2); the run's pinned revision supplies the authority setting (Phase 1).

## Implementation steps

1. **Authority section** in `RESIDENT_PROFILE_SECTIONS` and `ResidentAuthoritySection`, off by
   default, with copy explaining that only a desktop Launch click grants control.
2. **Click**: register `mission:resident-launch-click` with `serveDashboardClick`, arming an
   authorization bound to the launch `requestId`, profile id and revision. Expose it through the
   preload and `mission-desktop.d.ts`. `launchResident()` arms it inside the click handler when
   the profile has control on and `window.missionDesktop` exists, then sends the `requestId`.
3. **Daemon**: the launch route asks the private channel to consume the authorization for that
   request, profile and revision. On success it records `control_authorized_at` on the run
   (`addColumn`), and once the session registers applies `setSessionControlEnabled` after the
   existing identity recheck. It records the grant's identity as it stood at grant time:
   `control_conversation_id`, `control_cwd` and `control_episode_id`. Without a valid
   authorization the run launches ungranted.
4. **Restore**: after SDK restore, a run with `control_authorized_at` is regranted only when the
   restored session's native conversation, cwd, work episode and task all match the recorded
   values. The process id is the one part of the grant identity that a restart necessarily
   changes, so it is the only part not compared. A clear, a new conversation, a changed cwd, a
   replacement work episode, or a restart on a new profile does not carry the grant. Turning
   control off with the existing toggle clears the columns.
5. **Surface**: the band and dock row show "control granted" or "control not granted" with the
   existing grant menu for the latter.
6. **Documentation**: amend `docs/security.md` and `docs/agent-guides/architecture.md`
   (Delegated session control) to state the exact rule, and describe it in `docs/residents.md`.

## Tests and verification

- Unit: authorization bound to request, profile and revision; expiry and replay refusal;
  launch without authorization is ungranted; restore regrants only when conversation, cwd, work
  episode and task all match, and refuses when the cwd or the work episode alone differs;
  revoke clears the record; agent and token callers cannot arm or consume.
- Desktop e2e using the shared `serveDashboardClick` fixtures: a Launch click grants control,
  a daemon restart keeps it, a standalone-browser launch shows "control not granted".
- `npm run typecheck`, `npm run lint`, `npm run test:electron`, `npm run test:e2e`.

## Exit criteria

The only new way a grant appears is a desktop Launch click for a profile with control on, scoped
to that run, and the security documents say so.

## Downstream handoff

No later phase may create a resident grant through any other path.

## Cross-phase audit record

- Follows Phase 2 and may run concurrently with Phases 3, 4, 5 and 7; the dock's Launch (Phase 2)
  inherits the click through `launchResident()`.
- Repair round 1: ordered after Phase 2 so the grant-status surfaces exist before this phase
  renders into them; authority is read from the run's pinned revision.
- Pull request review (CodeRabbit): restore compares the full grant identity except the process
  id, including cwd and work episode.
