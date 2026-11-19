# Phase 14 (WP9): docs

## Outcome
`docs/headless-mode.md` documents the alpha feature and the other docs link to it (F11).

## Entry and dependencies
Phases 11 and 13 so every user-facing package is in.

## Scope and non-goals
Spec section 5 and 7.19. Owns `docs/`. Non-goals: code changes.

## Repository findings
A docs link checker exists; `docs/security.md` records the accepted limits (unproven typed answers, fallback start is a skill rule, shared machine token).

## Steps
Explain alpha and the flag, setup, the menu and switching it off, check-in, answers and plan approval, `mctl`, follow and subagents, what the turn log stores, security limits; link from the docs listed in 7.19. Plain English, no em dashes.

## Tests and verification
Docs link checker, `home-dispatch-docs.test.ts`.

## Merge and exit
Docs match the merged implementation.

## Downstream handoff
Phase 15 verifies docs link checks in the full sweep.

## Cross-phase audit
Other phases list needed doc changes in their pull requests rather than editing `docs/`.
