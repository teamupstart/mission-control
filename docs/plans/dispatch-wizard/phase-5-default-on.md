# Phase 5 - Guided dispatch on by default, and the documentation

## Outcome

The approved decision lands: <kbd>+</kbd> runs the guided pass for everyone, with <kbd>⇥</kbd>
as the one-key way back to today's form. The documentation describes the new path, its keys and
its preference.

This is the only phase whose merge changes behaviour for someone who never asked for it, which
is why it is last, small, and separately reviewable.

## Entry criteria and dependencies

- Direct prerequisites: **Phase 3** and **Phase 4**. Both, because the default must not turn on
  a pass that is missing its first step or has no findable off switch.
- Inherited contract, and the one that makes this phase small: **the e2e `dashboard` fixture
  pins `guidedDispatch` explicitly** (Phase 2). Without it this phase would be a rewrite of
  roughly 49 specs instead of a one-line change.

## Scope

1. Flip the shipped default.
2. An upgrade-path spec.
3. Documentation.

### Non-goals

- No behaviour change beyond the default. Every key, step and surface is as Phases 2-4 shipped
  them.
- No new preference, no migration, no per-user rollout.

## Repository findings

`UI_CONFIG_DEFAULTS` is a plain object read synchronously by the web bundle at module load
(`src/shared/protocol.ts:1724-1742`), so the flip is one literal. The schema field already
carries `.default(UI_CONFIG_DEFAULTS.guidedDispatch)`, so the two stay consistent by
construction. There is no migration: existing installs already have a `ui` row, and the shallow
merge in `setUiConfig` re-parses through the schema, so an install that never touched the
preference picks the new default up and one that set it explicitly keeps its choice. That is the
correct behaviour in both directions and should be stated in the pull request.

**Roughly 49 e2e specs drive the dispatch modal.** Eleven treat it as their subject; about
thirty-eight open it only to get a session onto the fleet, filling the repo placeholder and
tabbing through native selects. Every one of them would break against a pass that intercepts
keys and dims the form. They do not break, because Phase 2 pinned the preference in the fixture.
**This phase's real job is to prove that pin held.**

Documentation surfaces that describe the current behaviour:

- `docs/dispatch-and-backlog.md:3-4` - "Click **＋ Dispatch** (or press <kbd>+</kbd>), pick a
  repo, describe the task, and the daemon:". This sentence becomes wrong.
- `docs/ui.md:603-680` - the full shortcut table, which documents `+`.
- The README's dispatch description.
- `docs/dispatch-and-backlog.md:142-148` already documents the scout → after-work rule; the
  guided pass reaches the same rule and the prose should say so rather than describing it twice.

## Implementation steps

1. **Flip `UI_CONFIG_DEFAULTS.guidedDispatch` to `true`** in `src/shared/protocol.ts`. Update the
   comment beside it to say it ships on and that <kbd>⇥</kbd> is the escape.

2. **Re-pin the guided specs.** Any spec from Phases 2-4 that turned the preference *on* in-test
   was relying on the shipped default being off. Make each spec state the value it needs
   explicitly, so no spec in the suite depends on the default in either direction.

3. **The upgrade-path spec.** A fresh profile presses <kbd>+</kbd>, gets the guided pass,
   presses <kbd>⇥</kbd>, and lands on a form indistinguishable from today's - same controls, same
   values, task box focused, <kbd>⌘↵</kbd> still dispatching. This is the assertion that the cost
   of the decision is bounded, and it is the one a future reader will want when they wonder
   whether the escape still works.

4. **Documentation**, in the same change:
   - `docs/dispatch-and-backlog.md` - rewrite the opening so <kbd>+</kbd> is described as
     starting the guided pass, document the four steps and their keys **as Phase 4 shipped them**
     (Escape is progressive in the Repo step; digits type there and pick elsewhere), and name
     the preference and both places it can be flipped. Point at the existing scout → after-work
     section rather than restating the rule.
   - `docs/ui.md` - update the shortcut table entry for `+`, and add the in-pass keys.
   - `README.md` - update the dispatch description.
   - Do not hand-edit `CHANGELOG.md`.

## Data, API and compatibility

No migration. Compatibility in both directions is a property of the schema default and the
shallow merge, as above:

| Install state | Behaviour after upgrade |
|---|---|
| Never touched the preference | Picks up the new default: guided |
| Explicitly turned it off | Stays off |
| Explicitly turned it on | Stays on |
| Older daemon, newer bundle | Schema default applies; guided |

## Tests and verification

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`.
- **`npm run test:e2e` in full, not a shard.** This is the phase's central verification: the
  claim that the fixture pin protected the existing suite is only proved by running all of it
  after the default has moved. A green shard proves half of it.
- A manual pass in the built app at the shipped default: all four steps, <kbd>⇥</kbd> from each
  step, <kbd>⌫</kbd> from each step, and the modal header toggle turning it off and back on.

## Merge and exit criteria

- Every command above passes, with the full e2e suite green.
- No spec in the suite depends on the shipped default implicitly.
- A fresh install gets the guided pass on <kbd>+</kbd>; <kbd>⇥</kbd> reaches today's form in one
  key.
- `docs/dispatch-and-backlog.md`, `docs/ui.md` and the README match the shipped behaviour, and no
  longer describe <kbd>+</kbd> as opening the form directly.

## Downstream handoff

The feature is complete at this point. Anything further - rebindable mnemonics, more steps,
per-repo defaults - is a new plan, and the source plan lists those as out of scope.

## Cross-phase audit record

- **Against Phase 1.** Changes exactly the one line Phase 1 reserved for this phase, and nothing
  else in the `UiConfig` chain.
- **Against Phase 2.** Consumes the fixture pin, which is the contract that makes this phase
  small. If that pin is absent when this phase starts, **stop**: the correct fix is to add it as
  its own change, not to rewrite the specs it was meant to protect.
- **Against Phases 3 and 4.** Documents the category path `dispatch/guided` from Phase 3 and the
  corrected Repo-step key behaviour from Phase 4. This is why the phase depends on both: writing
  the documentation before either had landed would document a pass that does not exist.
- Step 2 was added during the final audit. Phases 2-4 write specs that switch the preference on
  against an off default; once the default moves, "on" is no longer the deviation and a spec that
  assumes it is silently tests nothing. Making every spec state its own value is the fix, and it
  belongs here rather than in the earlier phases, which cannot know the flip has happened.
