# Backlog multi-select and bulk edit

## Goal

Select several backlog tasks at once, by shift-click or by dragging, then change their
fixed-choice fields together. Freeform fields (title, intent) and repositories stay
one task at a time.

Bulk-editable fields, all already accepted by `UpdateTaskSchema`:

| Field | Bulk semantics |
| --- | --- |
| Priority | set one value, or clear |
| Labels | add some, remove some; labels not named are left alone |
| Autopilot (`enabled`) | on or off |
| Kind | set one backlog-capable kind (`BACKLOG_TASK_KINDS`) |
| Agent | set one harness |
| Model | set one model for the harness, or back to the default |
| Effort | set one level, or back to the default; refused per task where the harness lacks it |
| After work (`workflowId`) | dispatch default, none, or one published workflow |
| Dependencies | add prerequisites, remove prerequisites; never the task itself |

## Selection model (shared by every option)

- Click still opens the task. `Cmd`/`Ctrl`-click toggles one card. `Shift`-click selects
  the range from the last clicked card, in the column's order.
- Dragging from empty column space (a gap between cards, or below the last card) draws a
  marquee. A drag that starts on a card still reorders or assigns it, so existing drag
  behaviour is unchanged.
- Selected cards carry a checkbox in the corner. It also shows on hover and on focus, and
  `Space` on the focused checkbox toggles its card. `Esc` inside the column clears the
  selection, and `Cmd`/`Ctrl`-`A` inside the column selects all.

## Decisions

The human chose these on 2026-09-25, from the Mission Control dashboard's plan-decision form
for this plan, after reviewing [mockups.html](mockups.html). Mission Control stored the answer
as plan-decisions review `46524df6-aeea-466a-b56a-382e0de89925`, which reads `answered` and
`resolved_by = human` at 14:56 UTC. Their answers to the four questions it asked:

- Mockup: **A. Selection bar and bulk-edit dialog**, with the free-text addition "allow tasks
  to also be deleted when selected instead of only edited."
- Surface: **Board Backlog column only.**
- Write path: **New atomic bulk-update route.**
- Next step: **Implement the chosen mockup in this task.**

What that means for the build:

- **Presentation: A**, the selection bar and bulk-edit dialog, with **bulk delete** added to
  the selection bar. Delete asks once, in the bar.
- **Surface: the Board's Backlog column only.** The Line's Backlog drawer is unchanged.
- **Write path: a new atomic bulk-update route.** Bulk delete gets its own route. It checks
  every task before removing any, but it can't be atomic, because a removed task's resources
  are reclaimed outside SQLite.

## The three presentations

See [mockups.html](mockups.html).

- **A. Selection bar and a bulk-edit dialog.** A bar docks in the column. It opens a dialog
  where each field defaults to "leave as is", mixed values say so, and only changed rows
  are written, all at once.
- **B. Column header becomes a command strip.** Field chips in the header. Each popover
  applies its value to the whole selection immediately, with Undo in a toast.
- **C. Side inspector with a change preview.** A panel beside the board, with a per-task
  before and after table, including the tasks a change would skip.

## Write path

`POST /api/tasks/bulk-update` validates every task's patch against the same rules
`TaskManager.update` applies today, then writes them all in one transaction and emits one
`task_upsert` per changed task. A refusal names the task that caused it and writes nothing.
It also refuses a prerequisite that is itself in the selection, and a task whose row changed
while the others were being checked.

`POST /api/tasks/bulk-delete` checks that every task exists and is still in the backlog, then
removes them one by one and reports any that still fail.
