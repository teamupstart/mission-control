# Workflow settings: the Check commands repository picker

Browser evidence that the Check commands repository field is the shared `RepoCombobox` -
the same picker the dispatch form uses - and that the **Allowed repositories** row directly
above it was deliberately left alone.

Captured at 1280 × 1180 (`deviceScaleFactor: 2`) against a real daemon on an isolated
`MISSION_HOME` and port, driven over CDP in a headless Chrome with its own profile. The
repository list is a live `GET /api/repos` scan of the operator's workspace roots: **202
repositories**. Two of them were put on the Workflow allowlist first
(`zendesk/secret-service-v2-api`, `upstart-interview`) so the ordering claim is visible
rather than asserted.

## One frame, three claims

![Workflow settings with the Check commands repository picker open: the Allowed repositories
row above still a plain text input, the Check commands field empty on its own full-width
line, and its dropdown listing the two allowlisted repositories ahead of the workspace
scan](02-check-picker-open.png)

Everything the change is about is in this single capture.

**The Check commands field is empty by default.** It is focused here - the dropdown is
open - and still shows its placeholder, `/path/to/repository (or a subdirectory)`. Nothing
is pre-filled: measured `value === ""`. The placeholder keeps naming a subdirectory because
the list offers repository roots while the monorepo override is a path below one.

**It offers the repository list.** 202 options, with the two allowlisted repositories
leading and the workspace scan following:

```
/Users/jordanmance/workspace/zendesk/secret-service-v2-api   <- allowlisted
/Users/jordanmance/workspace/upstart-interview               <- allowlisted
/Users/jordanmance/workspace/ai-harness
/Users/jordanmance/workspace/ai-harness-nmo
...
```

A check only ever *runs* in an allowlisted repository, so those are the useful answers and
they lead (`checkRepoOptions`). The allowlist also holds resolved roots from anywhere on
disk while `/api/repos` scans the workspace roots only, so folding the two lists together is
what keeps a repository allowlisted from outside those roots offerable at all.

**The Allowed repositories row above is unchanged.** Its add box is still the plain
`/path/to/repository` text input beside **Add repository** - measured `role === null` and no
`combobox` wrapper - because that button grants Live delivery, so a picker there is a consent
decision rather than a convenience one. `workflow-settings-panel.test.ts` pins that scope.

## Why the field takes a line of its own

Measured in this capture: the picker's input is **760 px** and its dropdown is **760 px**,
left-aligned to it, 4 px below. The dropdown is sized from its input, and repository paths
differ at the *end* - every path under one workspace root shares its first 28 characters -
so on the original shared line, at that row's 180 px floor, **202 of 202 options ellipsized
at the same character**: a menu of identical-looking rows. Given its own line the count is
**1 of 202**, a 90-character nested path that still has its hover tooltip.

Sizing the dropdown to its content instead was tried and reverted: it fixed this row by
making the menu overhang the dispatch modal's right edge, which `RepoCombobox` cannot know
the bounds of. Both the component doc comment and
`.wf-settings-check-add > .combobox` in `styles.css` record that.

## Typing filters, and free text survives

![The same field with "avl" typed, narrowing 202 repositories to the three avl-hoops
checkouts](03-check-picker-filtered.png)

`avl` narrows to the three `avl-hoops` checkouts. Typing a path the list cannot match - a
subdirectory such as `avl-hoops/packages/web` - closes the dropdown and keeps the text, and
submitting it stored the subdirectory rather than the repository root, so the documented
monorepo override still works through the picker.

## The row at rest

![The Check commands row unfocused: the repository field full-width on its own line, with
the slot select, command box and Add command button on the line below](01-check-row-closed.png)

Unfocused, the picker is indistinguishable from the text box it replaced, which is what the
other four callers look like too. The slot select, command box and **Add command** wrap to
the line below.
