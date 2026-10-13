# Task type, always visible

Rendered mockups: [`mockups.html`](mockups.html).

## Problem

The conversation header names a task's kind only when it is not `ship`. `taskPillParts`
(`src/shared/task.ts`) treats `ship` as the silent default, and the kind that does print is a
small blue chip in the PATH and BRANCH band, the same colour for every kind. Board cards never
show a kind. So a `ship` task, the most common kind, shows its kind nowhere.

## Change

- Always show the kind on a task session, `ship` included.
- Give each of the six kinds (`TASK_KINDS`) its own icon and colour, declared once beside
  `TASK_KIND_INFO`, so a seventh kind does not compile until it has both.
- Remove the kind word from the PATH and BRANCH band's task chip. The chip stays for a task
  title, an outcome link or a schedule origin.
- Draw the kind in one new place in the conversation header (options A to D) and one new
  place on the board card (options 1 to 4).
- Add both to Settings > Display, through the existing `lib/board-card.ts` display registry.

## Conversation header options

| Option | Placement | Cost |
| --- | --- | --- |
| A. Eyebrow over the title | Icon, `SHIP TASK`, and the kind's purpose above the session name | About 14px of height |
| B. Badge leading the title | Filled colour-coded badge inline before the session name | 50 to 80px of title width |
| C. Kind tile and accent edge | 48px icon-and-word tile replaces the agent dot, which rides its corner; kind-coloured left edge | Biggest visual change |
| D. Anchor on the tab strip | Labelled kind chip as the first item of the tab strip | Competes with the tab strip's fit ladder |

## Board card options

| Option | Placement | Cost |
| --- | --- | --- |
| 1. Chip beside the name | Icon and word chip in the tile head, after the agent dot | 45 to 70px of name width |
| 2. Tab on the top edge | Folder-style tab sitting on the card's top border | About 8px more gap between cards |
| 3. Kind band across the top | Tinted band with icon, kind and purpose | About 20px of height per card |
| 4. Kind medallion | Round icon medallion replaces the agent dot; word on hover | Icon-only on the card |

## Decisions

Chosen by the operator from the mockups:

- **Conversation header:** B, the badge leading the title (`taskKindHeader: "badge"`).
- **Board card:** 2, the tab on the top edge (`taskKindCard: "tab"`).
- **Settings:** a style picker per surface offering all four styles plus Off, under
  Settings > Display > Session display > Task type. The chosen styles are the defaults.
- **Follow-up:** implemented in the same task, not phased.

Every style ships, so the other three per surface remain available. The kind's colour lives on
`TASK_KIND_INFO.accent`; its glyph lives in `TaskKindMark`. Both are `Record<TaskKind, ...>`, so a
new kind does not compile without them. The backlog card's `.bl-kind-*` colours are unchanged.
