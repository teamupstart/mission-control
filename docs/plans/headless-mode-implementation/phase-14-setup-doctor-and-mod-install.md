# Phase 14: Setup, doctor and mod install (WP7)

Source: `plan.md` (6.5), `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, 7.10a, 7.14.

**1. Outcome.** `mctl setup` and `mctl doctor` make a machine ready: they find `claude`, check that mods can load, stage the mod, install it, and install the Foreman LaunchAgent, with each failure named and its fix printed.

**2. Entry and dependencies.** Direct prerequisites: P8 (mod to stage) and P10 (client). Soft spikes S5, S14, S17, S18, S20, recorded in Commonroom; S17 and S20 also confirm the plan-local checks below before merge.

**3. Scope.** `src/cli/commands/setup.ts`, `doctor.ts`; every file in `src/cli/setup-steps/` except `agents.ts` (P15) and `codex.ts` (P7); `src/cli/claude-cli.ts` (one detection function: `MISSION_CLAUDE_BIN`, `PATH`, then known places, accepted only if `claude --version` runs and `claude plugin --help` lists `marketplace`); `src/server/mod-stage.ts`; `scripts/install-service.mjs`; the "Mods can load" step, with `src/server/environment/claude-mods.ts` and a `MANAGED_MOD_KEYS` allowlist beside `MANAGED_ENV_KEYS` in `src/server/environment/claude-managed.ts`; and `test/home-dispatch-claude-mods.test.ts`. Non-goals: agents step, Codex step, packaging (P16).

**4. Findings.** The mod ships only inside Mission Control (D44): staged at `{stateDir}/mod/` by writing a sibling folder and renaming, never copying onto the published path (CLAUDE.md native-addon rule). Install is `claude plugin marketplace add {stateDir}/mod` then `claude plugin install mission-control@mission-control --scope user`, each only when `claude plugin list` does not show it. No `claude` found means skip the mod step, finish the rest, exit 1 (D45). The mods checks come from local plan `8065dbe0-950a-4572-b358-8e5b5489e69b` revision 2, not the spec: cite the check names `mods-version`, `mods-user-switch`, `mods-managed-policy`, `mods-sideload-policy`, `mods-stale-env`, `mods-traffic`, `mods-can-load`, `mod-enabled`, `mod-current`, `mod-calls` and the severities in plan 6.5. Use warn where S17 or S20 has not confirmed a fact.

**5. Steps.** Read spec 7.10a, 7.14 and plan 6.5. Implement detection, staging by rename, the checks (read-only probes, no tokens, setup never changes a switch except the mod's own enabled state), install, the version probe and stale-build reinstall, the LaunchAgent (print, bootout, wait, bootstrap; L18), and the doctor report. Version probe: after staging, compare the version `claude plugin list` shows for `mission-control@mission-control` with the staged `plugin.json` version. If they differ, run `claude plugin uninstall mission-control@mission-control`, re-add the marketplace if it is not listed, install again, and re-check in a fresh `claude` invocation. Never use `claude plugin update` (D47). If the reinstall fails, keep the old install, print the cause, finish the other steps and exit 1; doctor reports `mod-current` failed with the fix `run mctl setup`. `--off` no longer unbinds tmux.

**6. Data and API.** Nothing on the dashboard calls the probes. No new daemon routes.

**7. Tests.** Every check against planted settings in a temporary home and a fixture managed root with a fake `claude` runner, planted files unchanged afterwards; staging by rename; detection order; install idempotence; exit codes; an upgrade test where the fake `claude` runner lists an older installed version, setup reinstalls, and the re-check shows the staged version; and the failure path where the reinstall fails and the old install is kept.

**8. Merge and exit.** Setup and doctor run on a clean machine against fakes, and a restaged build is picked up (stale version detected, reinstalled, verified in a fresh invocation); smoke runs `claude plugin validate` when `claude` is installed.

**9. Handoff.** P16 packages what P14 stages; P15 and P7 add their own steps to the list; P17 documents troubleshooting.

**10. Cross-phase audit.** `scripts/install-service.mjs` owned here only. The mods checks are owned here and not duplicated in P8 except the `mod-calls` smoke check.
