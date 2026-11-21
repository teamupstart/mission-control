# Phase 2: CLI, mod and pane skeleton, and fakes (WP1b)

> **Status: merged on main.** Built; no work remains in this phase. See `phased-plan.md` section 1.

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18.

**1. Outcome.** The `mctl` command registry, the mod and pane skeleton with its build, and the shared fakes exist, so every later phase can build and test in parallel against stubs.

**2. Entry and dependencies.** Direct prerequisite: P1 (schemas, routes, flag).

**3. Scope.** `src/cli/index.ts`, `src/cli/commands/index.ts` (registry with a stub per command); `src/cli/setup-steps/index.ts` (the ordered step list, which imports one stub file per step, `agents.ts` and `codex.ts` included, each exporting `implemented: false` and taking `{ live: boolean }`); `src/mod/register.ts`, `host.ts` (`ModHost` including pane calls), `src/mod/types/index.d.ts` (`PluginState`), `src/mod/flows/` stubs that say `not implemented`, `src/mod/pane/` stubs per tab; `npm run build:mod` producing `dist/mod/mission-control` and a folder marketplace; `package.json` scripts and `bin`; `test/helpers/home-dispatch-fakes.ts` (fake daemon serving a schema-valid canned reply for every `/dispatch/*` route from P1's schemas (each later phase overrides only the responses it fills, in its own fixture file `test/helpers/home-dispatch-fakes-<area>.ts` registered with one line in P2's response table); fake `ModHost` recording every dialog, notice, toast, status, band, pane open and view, press and model-bound write). Non-goals: any real command, flow, pane or install behavior. The fakes also include a fake `claude` binary whose `--version` and `plugin` subcommands (`list`, `marketplace add`, `install`, `uninstall`, `validate`, `test`) are scriptable with a settable installed version; P13 uses it as it stands, P14 extends it and P16 reuses it. The fake `claude` also records the argv and cwd of every launch, so P13 can assert a plain launch with no prompt.

**4. Findings.** `main` has no `src/cli/` or `src/mod/`. The mod is a plugin whose only component is a hooks module (spec 7.10); `plugin.json` carries the app's version and a `modApi` integer. Native-addon rename-publish rule applies to later staging, not here.

**5. Steps.** Read spec 7.10, 7.13, 7.14, 8.1. Create the registry and step list with stubs. Create the adapter-free pure-function layout (`flows/`, `pane/`) behind `ModHost`. Add the build script and marketplace file. Write the fakes from P1's schemas. Add a smoke assertion that the build output has the expected shape.

**6. Data and API.** No new routes. Stub shapes must match P1 exactly.

**7. Tests.** Typecheck, lint, `npm test`; a test that the fake daemon and fake host satisfy P1's schemas; `npm run build:mod` output check.

**8. Merge and exit.** `npm run build:mod` works; every stub says `not implemented` and every setup-step stub exports `implemented: false`, which its owning phase sets to true by replacing the stub; `npm run build` runs `build:mod`, so `dist/mod` exists for the smoke check; fakes are importable by later phases; flag-off behavior unchanged.

**9. Handoff.** P3 to P7 start from these stubs. Later phases replace stubs and never change a stub's shape. Stub owners: `mctl get`, `describe`, `logs`, `status`, `config` P10; `mctl run`, `claude`, `daemon` P13; `mctl setup`, `doctor` and the setup-step bodies P14, except the `agents` step P15 and the `codex` step P7; mod `flows/*` P11; mod `pane/*` P12. P8 owns `register.ts`, `host.ts` and `types/index.d.ts` afterward; P14 owns setup-step bodies except `agents` (P15) and `codex` (P7). `src/cli/setup-steps/index.ts` is not edited after P2 except by P14; P7 and P15 replace only their own step file. Later phases register their fixtures with one line in P2's fake-daemon response table; whichever merges second rebases, and the merge is mechanical.

**10. Cross-phase audit.** Matches P1's schemas; no file is also owned by P1. The pane skeleton is consumed by P12, the fakes by every later phase.
