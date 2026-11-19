# Phase 10 (WP6b): mctl run, claude, daemon

## Outcome
`mctl run` starts and watches tasks, `mctl claude` opens Claude with `/mission-dispatch` as its first prompt, and `mctl daemon` manages the daemon (F6, F3).

## Entry and dependencies
Phases 8 and 4. Merge gated by spike S3 for the `claude` form.

## Scope and non-goals
Spec 7.13. Owns `src/cli/commands/run.ts, claude.ts, daemon.ts`. Non-goals: the tmux workspace (phase 12), `attach`, `config set` (v1.1).

## Repository findings
All child processes go through the executable registry (rule 3.8).

## Steps
`run` with `--kind`, `--after-work`, `--shelve`, `--dry-run`, `--depends-on`, `--json`, `--watch` exit codes; `claude` positional prompt; `mctl` never answers, approves, cancels or reorders a task a home session started (D8).

## Tests and verification
`home-dispatch-cli.test.ts` with fake runners; suite, typecheck, lint.

## Merge and exit
Flag off: exits 2 with the run-setup message.

## Downstream handoff
Phase 12 extends `claude` with the workspace.

## Cross-phase audit
No shared files with phase 11 except the registry from phase 1.
