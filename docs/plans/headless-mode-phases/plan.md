# Headless mode: implementation phases

This folder holds the phased implementation of the approved headless mode plan. It exists beside, not inside, `docs/plans/headless-mode/` so the approved source files are not re-saved for every phase edit.

Approved source (main bundle revision 5: spike delivery on a single branch, installed only as the `spike` instance under spike names):

- `docs/plans/headless-mode/plan.md` - design and decisions
- `docs/plans/headless-mode/spec.md` - build spec
- `docs/plans/headless-mode/acceptance.md` - acceptance criteria and tests
- `docs/plans/headless-mode-install/plan.md` - why the install is isolated and how it graduates

**This is a spike and alpha code. Every phase commits to one upstream branch, `feat/headless-mode-spike`. No phase opens its own branch or pull request. Nothing a phase builds reads or writes the desktop app's state, Claude config or launchd labels.** See "Delivery" and "Install isolation" in `phased-plan.md`.

Read `phased-plan.md` for the split, dependency graph and cross-phase contracts, then the `phase-N-*.md` file for your phase. The source files win if anything here disagrees with them.
