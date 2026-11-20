# Phase 2: CLI, mod and pane skeleton, and fakes (WP1b)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18.

**1. Outcome.** The `mctl` command registry, the mod and pane skeleton with its build, and the shared fakes exist, so every later phase can build and test in parallel against stubs.

**2. Entry and dependencies.** Direct prerequisite: P1 (schemas, routes, flag).

**3. Scope.** `src/cli/index.ts`, `src/cli/commands/index.ts` (registry with a stub per command); `src/cli/setup-steps/index.ts` (the ordered step list with a stub per step, including `agents` and `codex`); `src/mod/register.ts`, `host.ts` (`ModHost` including pane calls), `src/mod/types/index.d.ts` (`PluginState`), `src/mod/flows/` stubs that say `not implemented`, `src/mod/pane/` stubs per tab; `npm run build:mod` producing `dist/mod/mission-control` and a folder marketplace; `package.json` scripts and `bin`; `test/helpers/home-dispatch-fakes.ts` (fake daemon serving inbox, residents and transcript shapes; fake `ModHost` recording every dialog, notice, toast, status, band, pane open and view, press and model-bound write). Non-goals: any real command, flow, pane or install behavior.

**4. Findings.** `main` has no `src/cli/` or `src/mod/`. The mod is a plugin whose only component is a hooks module (spec 7.10); `plugin.json` carries the app's version and a `modApi` integer. Native-addon rename-publish rule applies to later staging, not here.

**5. Steps.** Read spec 7.10, 7.13, 7.14, 8.1. Create the registry and step list with stubs. Create the adapter-free pure-function layout (`flows/`, `pane/`) behind `ModHost`. Add the build script and marketplace file. Write the fakes from P1's schemas. Add a smoke assertion that the build output has the expected shape.

**6. Data and API.** No new routes. Stub shapes must match P1 exactly.

**7. Tests.** Typecheck, lint, `npm test`; a test that the fake daemon and fake host satisfy P1's schemas; `npm run build:mod` output check.

**8. Merge and exit.** `npm run build:mod` works; every stub says `not implemented`; fakes are importable by later phases; flag-off behavior unchanged.

**9. Handoff.** P3 to P7 start from these stubs. Later phases replace stubs and never change a stub's shape. P8 owns `register.ts` and `host.ts` afterward; P14 owns setup-step bodies except `agents` (P15) and `codex` (P7).

**10. Cross-phase audit.** Matches P1's schemas; no file is also owned by P1. The pane skeleton is consumed by P12, the fakes by every later phase.
