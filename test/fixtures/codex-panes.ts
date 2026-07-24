// VERBATIM `tmux capture-pane` output from a real Codex session (codex-cli 0.144.1) -
// not hand-written approximations of a TUI we don't own. Same rule as `claude-panes.ts`:
// recapture here, once, when Codex's chrome moves.
//
// These exist because the question "does Codex render dialogs we can read?" had never been
// ASKED. `annotatePaneState` filtered to `agent === "claude"`, so the parser was never once
// pointed at a Codex pane, and a code comment asserting Codex "doesn't render these dialogs"
// went unchallenged. It is wrong: Codex renders the same numbered, single-cursor menus, and
// the only token that differs is the cursor glyph - U+203A here against Claude's U+276F.
// Every one of these captures parses correctly once the harness supplies its own glyph.

/**
 * Codex's command-approval prompt - the load-bearing case, and the exact analogue of the
 * Claude permission prompt `optionRowMiss` documents: an approve row, an approve-and-remember
 * row whose label carries the whole command, and a decline row. A session parked here is the
 * most definitively blocked thing on the board.
 */
export const CODEX_COMMAND_APPROVAL = `
╭─────────────────────────────────────────────────╮
│ ✨ Update available! 0.144.1 -> 0.144.6         │
│ Run npm install -g @openai/codex to update.     │
│                                                 │
│ See full release notes:                         │
│ https://github.com/openai/codex/releases/latest │
╰─────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.144.1)                       │
│                                                  │
│ model:     gpt-5.6-sol   /model to change        │
│ directory: /private/tmp/…/scratchpad/codex-probe │
╰──────────────────────────────────────────────────╯

  Tip: Our most capable model yet. GPT-5.6 Sol can tackle complex code changes, dig into research, produce polished documents, and take on your most ambitious work. Sol is highly capable at lower
  reasoning efforts—try starting lower, then turn it up for harder jobs.


› Run the shell command: curl -sS https://example.com -o /dev/null ; echo done


• I’ll run that exact command and report its output.

• Ran curl -sS https://example.com -o /dev/null ; echo done
  └ curl: (6) Could not resolve host: example.com
    done

• Running curl -sS https://example.com -o /dev/null ; echo done


  Would you like to run the following command?

  Environment: local

  Reason: Allow this curl command to access example.com outside the restricted network sandbox?

  $ curl -sS https://example.com -o /dev/null ; echo done

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`curl -sS https://example.com -o /dev/null\` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
`;

/**
 * Codex's directory-trust prompt, the analogue of Claude's folder-trust check. Kept because
 * its question WRAPS across lines, which is what `readPrompt`/`joinBlock` exist for - an
 * end-anchored scan finds no `?` at all here.
 */
export const CODEX_TRUST_DIALOG = `
> You are in /private/tmp/claude-501/-Users-jordanmance--treehouse-ai-harness-c7356c-8-ai-harness/6ceab9d6-d97c-4f2d-a75c-76d94fe08a0e/scratchpad/codex-probe

  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection. Trusting the directory allows project-local config, hooks, and exec policies
  to load.

› 1. Yes, continue
  2. No, quit

  Press enter to continue
`;

/**
 * Codex's update prompt. Three rows, no question mark anywhere above them, so this is the
 * fixture that exercises `readPrompt`'s fallback to the adjacent block.
 */
export const CODEX_UPDATE_PROMPT = `
  ✨ Update available! 0.144.1 -> 0.144.6

  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs \`npm install -g @openai/codex\`)
  2. Skip
  3. Skip until next version

  Press enter to continue
`;

/** Codex 0.145.0's `/permissions` picker, with Guardian Approval enabled. */
export const CODEX_PERMISSIONS_PICKER = `
  Update Model Permissions

› 1. Ask for approval (current)  Codex can read and edit files in the current
                                 workspace, and run commands.
  2. Approve for me              Only ask for actions detected as potentially
                                 unsafe.
  3. Full Access                 Codex can edit files outside this workspace
                                 and access the internet without asking.
  4. Read Only                   Codex can read files in the current workspace.

  Press enter to confirm or esc to go back
`;

/** The second gate Codex shows after choosing Full Access. */
export const CODEX_FULL_ACCESS_CONFIRMATION = `
  Enable full access?

› 1. Yes, continue anyway  Apply full access for this session
  2. Cancel                Go back without enabling full access

  Press enter to confirm or esc to go back
`;
