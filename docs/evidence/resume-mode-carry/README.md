# Continue in terminal carries the permission mode

Evidence for the fix to the reported bug: an Agent SDK session continued in a terminal
reopened in the CLI's default mode, and the operator had to re-set it (manual back to
auto) by hand. The resume argv now re-asserts the session's stored mode -
`--permission-mode` for Claude, the sandbox/approval/reviewer posture for Codex - and
`e2e/specs/continue-in-terminal-mode.spec.ts` walks the whole path in a browser: the mode
chip on the card, the "resume this conversation in" chooser, the daemon's handoff, and the
exact command the chosen terminal backend was told to run.

## Artifacts

- [`pre-fix-red-transcript.txt`](pre-fix-red-transcript.txt) - the spec run against a
  build with the fix removed, written before the fix was restored. Both harnesses fail at
  the carried-mode assertion, and the received strings are the bug verbatim: the spawned
  command ends at the conversation id, with no mode flags -
  `'fake-claude' '--resume' '<id>'` and `'fake-codex' 'resume' '<id>'`. This is the
  "write the failing spec first" half: the same spec, red on the pre-fix daemon.
- [`transcript.txt`](transcript.txt) - the green run's verbatim stdout. Each `OBSERVED`
  line prints only after its assertions held, and the last one per harness quotes the full
  recorded terminal command, mode flags included.
- [`claude-menu-open.png`](claude-menu-open.png) / [`codex-menu-open.png`](codex-menu-open.png) -
  the asserted browser state: the card's mode chip (`auto` / `approve`) beside the open
  "resume this conversation in" chooser with the cmux row available. The frames are taken
  between the spec's own assertions, so they show a state the run already verified.
- [`cli-flags.md`](cli-flags.md) - the real CLIs' own documentation of the flags the argv
  re-asserts, captured verbatim from installed binaries (claude 2.1.222, codex-cli
  0.145.0), including the binary-level evidence that `approvals_reviewer` is a genuine
  top-level Codex config key. This is what backs the "measured, not guessed" claims in
  `src/server/harness/index.ts` and `src/server/harness/codex/sdk.ts`.

## Regenerate

The green transcript and both frames:

```sh
set -o pipefail   # or the pipe below reports tee's success, not Playwright's
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/continue-in-terminal-mode.spec.ts \
  --workers=1 --reporter=list \
  | tee docs/evidence/resume-mode-carry/transcript.txt
```

`npm run build` first - the suite drives `dist/`, not `src/`. The red transcript
regenerates the same way against a checkout without the fix (it was captured by stashing
the five fix files, rebuilding, and running the identical spec). The CLI blocks in
`cli-flags.md` each carry the command that produced them.
