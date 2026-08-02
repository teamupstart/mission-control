# Skipped workflow status visual evidence

These captures mount the production `WorkflowLadder` against deterministic workflow-run
fixtures. Each image holds the pointer over the stage-level **Skipped** status so the status
color and its explanation are visible in the same frame.

## `01-inspector-repair-skipped-tooltip.png`

An Inspector-only repair round. Valid authored stages that passed in the prior full workflow
round are **Skipped** in green. The open tooltip says that the prior pass is why the stage is
bypassed and that only Inspector is being rechecked.

## `02-unconfigured-skipped-tooltip.png`

A normal workflow round where neither check has a configured command. The check stage and
its members are **Skipped** in amber. The open tooltip explains that no commands are configured,
so the color does not imply that the checks passed.

## Reproduce

From the repository root:

```sh
npx electron scripts/workflow-skipped-status-evidence.cjs
```

The capture script asserts the visible label, semantic tone class, and exact open-tooltip text
before writing either PNG.
