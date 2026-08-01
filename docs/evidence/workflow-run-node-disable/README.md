# Per-run disable toggle on the Runs monitor

Visual evidence for the per-run judge/stage disable feature, captured from the real Runs
monitor: a built daemon (`node dist/server/index.mjs`) on an isolated `MISSION_HOME` with a
seeded `waiting_for_session` run, driven by a headless Chrome over CDP issuing genuine
clicks on the rendered page. Every state change below travelled the full path: click ->
`POST /api/workflow-runs/:id/set-nodes-disabled` -> SQLite -> SSE summary bump -> detail
refetch -> re-render.

The seeded round: Quality reviewer passed, Security reviewer failed (the round returned to
Session), and Docs steward sits behind the failed all-pass join, never activated.

## pipeline-before.png

Nothing disabled. Security reviewer reads **Changes requested**, Stage 1 reads **Failed**,
Docs steward reads **Not started**.

## pipeline-reached-outcome-kept.png

After clicking the **Security reviewer** row. The row turns red with the ⊘ mark and
`aria-pressed="true"` - the gate is switched off for every round that has not reached it -
but its chip still reads **Changes requested** and Stage 1 still reads **Failed**: an
outcome the viewed round already recorded is never repainted as skipped.

## pipeline-disabled-not-reached.png

After also clicking the **Docs steward** stage. The round never reached that gate, so it
shows the disable's own claim: red treatment, ⊘ on the stage header and the member row,
a red **Disabled** chip, and the stage fold **Did not run**.

Clicking each control again re-enabled both (chips returned to **Changes requested** /
**Not started**, `disabledNodeIds` back to `[]`), and the daemon's timeline recorded
`node_disabled` / `node_enabled` events naming each gate.
