# Headless mode: installation plan that avoids conflicts

Status: plan for the spike branch `feat/headless-mode-spike`. Evidence: `docs/reports/headless-install-review/report.html` (13 conflicts found between the approved headless plan and a machine that has the Mission Control desktop app).

## The idea

While the spike is being proven, **everything it installs lives under a different name and inside a named instance called `spike`**. The desktop app and the spike can then run on the same machine at the same time without either one touching the other's files, processes or ports. When the spike is proven, a separate, planned graduation step renames and merges it into the app's owned surfaces.

This plan covers the spike stage in full and the graduation stage as a checklist with exit gates. It changes the approved spec in a few places (section "What changes in the approved documents").

## Rules

1. **Touch nothing the app owns.** During the spike no command reads or writes the default state home `~/.mission-control`, the default Claude config `~/.claude` and `~/.claude.json`, or the default launchd labels.
2. **Every installed name is unique to the spike** and cannot be matched by an existing recogniser (hook script names, skill prefixes, MCP server name, launchd labels).
3. **Only a named instance can be installed.** `mctl setup` without `--instance spike` refuses during the spike.
4. **A spike process refuses to act on the default instance** even if mis-launched (no env, wrong folder).
5. **Remove only what was written.** An ownership manifest in the instance folder lists every file and registration `mctl` wrote.

## Names (spike stage and where each would collide)

| Surface | Spike name | What it would collide with | Why it cannot collide |
|---|---|---|---|
| Instance | `spike` | the default instance | own state folder, port, labels, config folder |
| State folder | `~/.mission-control-instances/spike` | `~/.mission-control` (app state, `harness.db`, state lock) | different path, so a different state lock and a separate database |
| Port | first free port from 7417 | 7317 (app daemon) | stored in `instance.json`; never 7317 |
| launchd labels | `com.mission-control.daemon.spike`, `com.mission-control.foreman.spike` | `com.mission-control.daemon` written by `scripts/install-service.mjs`, plus its legacy labels | suffix; `install-service` removes only its fixed list |
| Claude config folder | `~/.mission-control-instances/spike/claude` | `~/.claude` (the app's hooks, `mission-control` MCP, `mission-*` skills) | `CLAUDE_CONFIG_DIR` set by `mctl claude`; spike S-02 showed plugin install under it changes nothing in `~/.claude` |
| Plugin | `mission-control-spike`, marketplace `mission-control-spike-local` | none today; keeps the plugin out of the app's namespace | installed only in the instance config folder |
| MCP server | `mc-spike` (inside the plugin) | the owned user-scope server `mission-control`, which the app's installer repairs by exact name | different name; the plugin namespaces it further |
| Hook script | `satellites/handoff-spike-hook.mjs` | the app recognises its hooks by the substrings `harness-hook.mjs` and `satellites/hook.mjs` (`MISSION_HOOK_SCRIPTS`) | the spike name contains neither substring; and it is registered only in the plugin's `hooks.json`, which the app's installer never reads |
| Skills | plugin skills `handoff`, `checkin` (invoked as `/mission-control-spike:handoff`) | the reconciler owns every `~/.claude/skills/mission-*` and `fleet-*` link (`SKILL_DIR_PREFIXES`) and removes stale ones | plugin skills create no entry in `~/.claude/skills`; no spike name uses those prefixes |
| Command | `/mission-control-spike:mc` (`/mc` where unambiguous) | none | plugin-namespaced |
| CLI | `mctl`, run as `npm run mctl -- --instance spike ...` from the spike checkout; **no PATH shim** | none exists today | nothing is written outside the instance folder |
| Settings | `handoff.launcher.prompt` | the app's settings | stored in the instance's own database |
| Environment | `MISSION_HANDOFF_LAUNCHER`, and per instance `MISSION_HOME`, `MISSION_PORT`, `CLAUDE_CONFIG_DIR` set by `mctl claude` | existing `MISSION_HEADLESS` (different meaning, not reused) | unique name; instance variables exist only in the launched process |

## Guards the spike must have

| # | Guard | Prevents |
|---|---|---|
| G-1 | The spike daemon refuses to start unless `MISSION_HOME` is a named instance folder under `~/.mission-control-instances/`. It never opens `~/.mission-control/harness.db`. | Applying schema 35 to the app's real database. A newer schema could stop the installed app opening it. |
| G-2 | `mctl setup`, `uninstall`, `daemon` and `claude` require `--instance {name}` (or `MCTL_INSTANCE`) with a non-default name. | Editing `~/.claude`, `~/.claude.json` or default labels. |
| G-3 | The plugin hook is a no-op unless `MISSION_HOME` names an instance folder (read from the environment `mctl claude` sets, or `instance.json` beside `CLAUDE_CONFIG_DIR`). It never falls back to port 7317. | A `claude` session started by hand with the instance's config folder posting spike events to the app's daemon. |
| G-4 | `runtimeRoot` must be a stable checkout that is not a pooled worktree (reuse `transientCheckoutRoot`) and not inside any `.app` bundle. The Node path comes from `stableNodePath`. | Baking a path the pool deletes; a LaunchAgent that executes the app bundle, which the app's update check treats as a blocker. |
| G-5 | Workers started by the spike daemon inherit the instance's `CLAUDE_CONFIG_DIR` and `MISSION_HOME` (already spec 9.4). | Workers reporting to the wrong daemon. |
| G-6 | `mctl uninstall` removes only manifest entries; `--purge` removes only the instance folder. | Deleting anything the app or another instance owns. |

## Install steps (spike stage)

1. **Make a stable checkout.** Create a normal, non-pooled worktree of `feat/headless-mode-spike`, for example `~/code/mission-control-spike`. Pooled worktrees are rejected by G-4.
2. `npm install && npm run build` in that checkout.
3. `npm run mctl -- --instance spike setup`. It writes the instance state folder and `instance.json`, loads the two suffixed LaunchAgents from this checkout's `dist/`, copies the plugin and installs it into the instance's Claude config folder, and records the manifest. Nothing outside the instance folder, the two plists and the checkout is written.
4. `npm run mctl -- --instance spike doctor`. Every line must be green: instance daemon reachable, handoff capability, plugin installed in the instance config only, no spike path in the default `~/.claude/settings.json`, default labels untouched.
5. `npm run mctl -- --instance spike claude`. First start asks for a Claude sign-in (separate config folder). The launcher question appears with no typing.
6. Remove: `npm run mctl -- --instance spike uninstall --purge`.

The desktop app can be open or closed during all of this. Its daemon, hooks, MCP server, skills and status line are never read or changed.

## How each of the 13 conflicts is handled

| Conflict (see report) | Spike stage | Graduation |
|---|---|---|
| C1 default setup refuses while the app runs | Default setup not offered at all (G-2). Named instance runs beside the app. | Attach mode (decision pending) |
| C2 second daemon and Foreman LaunchAgents | Suffixed labels, separate state lock | Service only when no owner exists |
| C3 spec 9.2 removes the app's hooks and MCP | **Rule deleted.** No default-config edits. | Extend the owned entries, never remove |
| C4 duplicate hooks, host Node | Plugin hook only in the instance config folder; host Node is acceptable for a developer sandbox | Extend the owned hook, owned runtime |
| C5 second MCP server of the same name | Different server name `mc-spike`, plugin-scoped | Use the owned server |
| C6 status line sidecar collision | Instance does not wrap `statusLine` at all unless asked, and then with its own sidecar inside the instance folder | Segment inside the owned wrapper |
| C7 new scripts block app updates | Nothing spike-owned is registered in the default config, so the updater never sees one; the Node-mode scripts run from a source checkout, not the bundle | Add `mctl` and any new satellite to `OPERATOR_SATELLITES` |
| C8 no way to install `mctl` on a desktop machine | Out of scope for the spike: source checkout only | Owned satellite plus opt-in shim |
| C9 skills delivered two ways | Plugin skills only, nothing in `~/.claude/skills` | Move to `skills/` and the reconciler |
| C10 plugin copy goes stale after app update | The spike runs from its own checkout, not the app | Not applicable once merged into owned hooks |
| C11 uninstall removes foreign things | Manifest plus G-6 | Same |
| C12 baked path from a pooled checkout | G-4 | Same |
| C13 service executes the app bundle | G-4 forbids `.app` paths | Same |

## Graduation: from spike names to the product

Graduation is a later, separate plan and release. It does not start until all gates are met.

**Gates**

1. Spikes S-04, S-05, S-06 answered, plus new S-07 (does the user-scope MCP server see `CLAUDE_CODE_SESSION_ID`?) and S-08 (can a reconciler-installed skill be invoked by its `mission-*` name, and does the Skills master switch hide it?).
2. Every `AC-` row passes on the tip of `feat/headless-mode-spike`, including the isolation rows below.
3. One week of real use in the `spike` instance beside the running desktop app with no unexplained daemon, hook or port errors.
4. The four decisions are made: default-instance attach, hook delivery, skills delivery, `mctl` distribution.

**Rename map (spike to final)**

| Spike | Final |
|---|---|
| instance `spike`, labels `.spike` | default instance (attach) or `install-service` label |
| plugin `mission-control-spike` with MCP `mc-spike` | owned user-scope `mission-control` server (handoff tools already in it) |
| `handoff-spike-hook.mjs` | behaviour inside the owned `satellites/hook.mjs`, daemon-driven output |
| plugin skills `handoff`, `checkin` | `skills/handoff`, `skills/checkin` linked as `mission-handoff`, `mission-checkin` |
| `/mission-control-spike:mc` | `/mission-handoff` |
| `npm run mctl` | `dist/satellites/mctl.mjs` with Setup row and opt-in shim, listed in `OPERATOR_SATELLITES` |

**Cut-over order:** daemon attach, then hook behaviour, then skills, then `mctl`, each behind the doctor checks, with the spike instance kept until the product path passes the same checks.

## Acceptance criteria added by this plan

These rows join `acceptance.md` (Delivery and Instances groups). The test files are new.

| ID | Test file | Criterion |
|---|---|---|
| AC-ISO-01 | test/handoff-isolation.test.ts | With a temp `HOME` that holds fake default `~/.claude/settings.json`, `~/.claude.json`, `~/.claude/skills/mission-*` links, default LaunchAgents and a fake app state folder, `setup`, `claude` launch preparation and `uninstall --purge` for `--instance spike` leave every default file byte-identical, and the injected runner never sees a default or legacy label. (Replaces and extends AC-SET-05 and AC-INT-02.) |
| AC-ISO-02 | test/handoff-isolation.test.ts | The spike daemon started with `MISSION_HOME` unset, or set to the default state folder, exits non-zero before opening any database, and a default state folder at schema 34 stays at 34. |
| AC-ISO-03 | test/handoff-setup.test.ts | `mctl setup`, `uninstall`, `daemon` and `claude` without a named instance exit 2 with a message that names `--instance`, and write nothing. |
| AC-ISO-04 | test/handoff-plugin.test.ts | The built plugin names are exactly those in the Names table. The hook command string is not matched by `isMissionHookCommand`, no skill directory the spike creates starts with `mission-` or `fleet-`, and the MCP server name is not `mission-control`. |
| AC-ISO-05 | test/handoff-hook.test.ts | The plugin hook is a no-op and prints nothing when `MISSION_HOME` is unset or is not under `~/.mission-control-instances/`; it never contacts port 7317. |
| AC-ISO-06 | test/handoff-setup.test.ts | `setup` refuses a `runtimeRoot` inside a pooled checkout and any path inside an `.app` bundle, and bakes the Node path from `stableNodePath`. |
| AC-ISO-07 | test/handoff-isolation.test.ts | Two daemons with different `MISSION_HOME` and ports (one standing in for the app) run at once and both answer health; neither writes to the other's folder. |
| AC-ISO-08 | test/handoff-setup.test.ts | `uninstall` removes exactly the paths and registrations in the manifest and nothing else; a file added by hand in the instance folder survives a non-purge uninstall. |
| AC-ISO-09 | test/handoff-setup.test.ts | After setup, `claude plugin list` under the default config does not show the spike plugin, and the instance config folder does not contain any Mission hook entry in its `settings.json`. |
| AC-ISO-10 | test/handoff-docs.test.ts | `docs/headless-mode.md` contains the Names table and the graduation gates, and states that the spike never edits the default config. |

## What changes in the approved documents

| Document | Change |
|---|---|
| spec 9.2 | Delete the default-instance rules (daemon.lock refusal, duplicate removal). Add G-1 to G-6, the manifest, the `spike` name list, and the stable-checkout rule. Default-instance setup is not offered during the spike. |
| spec 9.1, 9.3 | `mctl claude` and `setup` require a named instance; the plugin and status line paths are instance-local. |
| spec 6 | The plugin hook is a no-op outside an instance folder (G-3); the hook script is named `handoff-spike-hook.mjs`. |
| spec 7 | Plugin and marketplace names are the spike names; `/mc` is `/mission-control-spike:mc`. |
| acceptance | Replace AC-SET-06 and AC-SET-08; add AC-ISO-01 to 10; AC-SET-05 and AC-INT-02 are subsumed by AC-ISO-01. |
| phases | Phase 6 becomes instance-only setup with guards G-1 to G-6; phase 3 and 4 use the spike names; phase 7 runs the isolation rows and writes the Names table in docs. The four graduation decisions stay open and are not scheduled. |

## Not established

- Nothing was run beside a live desktop app. The isolation claims rest on reading the code (`isMissionHookCommand`, `SKILL_DIR_PREFIXES`, the app's installer scope and the update check) and on spike S-02.
- Whether the plugin marketplace name and plugin name may contain `mission-control` as a prefix without clashing with another installed plugin was not checked.
- Whether `install-service.mjs` supervises a Foreman was not read; the spike writes its own two labels either way.
