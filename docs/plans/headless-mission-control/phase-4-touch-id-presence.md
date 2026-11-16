# Phase 4: Touch ID for the three human-only grants

Part of [Headless Mission Control](plan.md). The phase index is [`phased-plan.md`](phased-plan.md).

## Outcome

With no desktop app, an operator at the Mac can do three things by touching the Touch ID
sensor. No agent can do any of them on its own:

- grant session control;
- launch a resident with **Control other sessions**;
- publish a product issue.

## Entry criteria

- Phase 1 has merged. This phase uses the CLI framework and the actor rule.

## Scope

1. The `native/operator-presence/` addon and its builder.
2. `src/server/operator-presence.ts`.
3. Chaining Touch ID into the three authorizers.
4. The audit record.
5. The `grant`, `resident launch` and `issue publish` commands.
6. The docs.

**Non-goals:**

- Any change to the desktop click path.
- Non-macOS presence signals.
- Password fallback.

## Repository findings

- **Session control.** `PUT /api/sessions/:id/session-control` (`src/server/session-control.ts:113`)
  refuses agent callers first (`sessionControlCallerRefusal`) and then awaits the injected
  `authorize({sessionId, enabled, requestId})`. The default is
  `sessionControlAuthorization()` (`src/server/session-control-authorization.ts:37`), which
  returns `false` with no `parentPort`.
- **Resident launch.** `POST /api/residents/profiles/:id/launch` (`routes.ts:9367`) passes
  `mayConsumeControlClick: sessionControlCallerRefusal(c) === null`.
  `ResidentManager.consumeLaunchClick` (`src/server/residents/manager.ts:612`) calls
  `authorizeLaunch({requestId, profileId, revision})`, which defaults to
  `residentLaunchAuthorization()`. Refusal does not block the launch; the run starts without
  control. Automatic restarts use `resident-restart:<uuid>` request ids
  (`src/shared/session-control-authorization.ts`).
- **Product issues.** `resolveProductIssueAuthorization()`
  (`src/server/product-issue-authorization.ts:102`) checks, in order:
  `MISSION_PRODUCT_ISSUE_AUTHORIZATION_CMD`, then the `parentPort`, then none. Its timeout is
  15 s.
- **Native addons.** `native/keep-awake/` (`binding.gyp`, `.mm`) is the model, together with
  `scripts/build-keep-awake-native.mjs`, `src/server/keep-awake-native.ts`, and
  `publishNativeAddon` in `scripts/native-addon-publish.mjs`. Publishing is a rename, never a
  copy (see `AGENTS.md`).

## Implementation steps

1. **The addon.** `native/operator-presence/operator_presence.mm` exports
   `authenticate(reason, timeoutMs) -> Promise<{ok, code}>`. It uses `LAContext` with
   `LAPolicyDeviceOwnerAuthenticationWithBiometrics`, sets `localizedFallbackTitle = @""` so
   there is no password button, and calls `invalidate` on timeout. Codes: `ok`, `cancelled`,
   `timeout`, `no-hardware`, `not-enrolled`, `locked`, `no-console`, `error`. Before
   prompting, report `no-console` when the console user is not this user, or when the session
   has no GUI.

   Add `scripts/build-operator-presence-native.mjs`, publishing only through
   `publishNativeAddon`, and wire it into `build:native`. On other platforms the build is a
   no-op, and the loader reports `unsupported`.
2. **The authorizer.** `src/server/operator-presence.ts` exposes
   `authorizeWithPresence({action, target, requestId, requestedBy})`:
   - It loads the addon lazily, and an injectable `PresenceBackend` stands in for it in tests.
   - It is single-flight: a second call while a prompt is open returns `busy`.
   - It allows at most one prompt every 10 s, and returns `rate-limited` otherwise.
   - The reason text names the action and the target title, and appends "(requested by a
     managed session)" when `requestedBy` is the agent actor.
   - It times out after 60 s.
   - It writes one audit line per attempt (action, target, actor, result code) to the daemon
     log and the existing audit store, if there is one.
   - It returns `{granted, code}`.
3. **Chain the three authorizers.** The order is always: `parentPort` when present, then
   presence on macOS, then refuse.
   - Session control: `sessionControlAuthorization()` falls through to presence with
     `action: "session-control"`. Revoking (`enabled: false`) never needs presence, because
     it only removes authority.
   - Resident launch: `residentLaunchAuthorization()` falls through to presence only when the
     `requestId` is a plain UUID. A `resident-restart:` id refuses without prompting, so
     automatic restarts never show a prompt.
   - Product issues: add a presence step after `parentPort` in
     `resolveProductIssueAuthorization()`, and keep the existing command seam first.
   - Change the refusal strings (`SESSION_CONTROL_DESKTOP_REQUIRED` and
     `PRODUCT_ISSUE_AUTHORIZATION_UNAVAILABLE`) to name both ways in: the desktop app, or Touch
     ID. The CLI prints the presence `code`, so the operator knows why it was refused.
4. **Commands** (`commands/grants.ts`). Each command mints a `requestId`:
   - `grant session-control <session> [--off]` calls the PUT route with
     `{enabled, requestId}`.
   - `resident launch <profile> [--with-control]` calls the launch route.
   - `issue publish <draft>` calls the existing product-issue publish route.

   Each prints "Touch the sensor to confirm..." while it waits.
5. **Docs.**
   - `docs/security.md`: what the presence signal proves, the biometrics-only policy, each
     refusal code, the rate limit, single-flight, and the residual risk of a prompt you did not
     request.
   - The Grants sections in `skills/headless/SKILL.md` and `docs/headless.md`. The skill tells
     agents never to call these commands for the operator.

## Compatibility

- When Electron owns the daemon, the click path is used and presence is never consulted.
- The test seams still work.
- Linux CI never loads the addon. The backend is injected in tests, and the loader reports
  `unsupported` off macOS.

## Tests and verification

- `test/operator-presence.test.ts`, with an injected backend:
  - each code maps to a refusal;
  - single-flight and the rate limit work;
  - the reason text carries the action, the target and the managed-session label;
  - the audit line is written;
  - the 60 s timeout works (with fake timers).
- `test/presence-chaining.test.ts`:
  - session control: `parentPort` wins, presence is used without it, revoke needs no
    presence, and agent callers are still refused before any prompt;
  - resident launch: a UUID prompts, `resident-restart:` never prompts, and a refusal still
    launches without control;
  - product issues: the command seam wins, then `parentPort`, then presence.
- Extend `test/native-addon-publish.test.ts` to cover the new builder.
- `test/cli-grants.test.ts`: the request shapes and how each refusal code is printed.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:native` and
  `npm run smoke`.
- Manual check on a Mac with Touch ID, using a headless daemon:
  - `grant session-control` approves once, is cancelled once, and times out once;
  - `resident launch --with-control` approves;
  - over SSH with no console session, the result is `no-console`.

## Exit criteria

- All three grants work headless with Touch ID, and refuse with a clear code otherwise.
- The desktop path is unchanged.
- Tests and the manual check pass, and `docs/security.md` is updated.

## Downstream handoff

`authorizeWithPresence` is the only presence signal. Future human-only actions call it and
do not add another one.

## Cross-phase audit

- This phase consumes only Phase 1 (the `grants` group and `actorHeaders`).
- It does not edit Phase 2's or Phase 3's group files. The only shared CLI edit is one line
  in `commands/index.ts`.
- `docs/security.md` is also edited by Phase 3, but in a different section (the outbound
  payload), so a conflict there is a trivial textual merge.
- It resolves the source plan's resident-restart risk by refusing `resident-restart:` ids
  without a prompt.
