# The real CLIs document the flags the resume argv re-asserts

Captured verbatim from the installed binaries on 2026-08-05. Regenerate any block by
running the command above it. This file exists because the resume specs in
`src/server/harness/index.ts` claim these shapes were measured rather than guessed,
and a claim in a code comment is not evidence - this output is.

## Claude: `--permission-mode` rides with `--resume`

```console
$ claude --version
2.1.222 (Claude Code)
$ claude --help | grep -A3 -- "--permission-mode"
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
```

The CLI spells the default mode `manual`; the dashboard's `default` maps to it through
the same `launchArgs` renderer the dispatch path uses (`src/shared/harness-capabilities.ts`).

## Codex: `resume` takes `--sandbox` and `--ask-for-approval` directly

```console
$ codex --version
codex-cli 0.145.0
$ codex resume --help | grep -A4 -- "-s, --sandbox"
  -s, --sandbox <SANDBOX_MODE>
          Select the sandbox policy to use when executing model-generated shell commands
          
          [possible values: read-only, workspace-write, danger-full-access]

$ codex resume --help | grep -A9 -- "-a, --ask-for-approval"
  -a, --ask-for-approval <APPROVAL_POLICY>
          Configure when the model requires human approval before executing a command

          Possible values:
          - untrusted:  Only run "trusted" commands (e.g. ls, cat, sed) without asking for user
            approval. Will escalate to the user if the model proposes a command that is not in the
            "trusted" set
          - on-request: The model decides when to ask the user for approval
          - never:      Never ask for user approval Execution failures are immediately returned to
            the model
```

## Codex: `approvals_reviewer` is a real top-level config key

No dedicated flag exists for the approvals reviewer, so the resume argv carries it as a
`-c` override. That the key exists - beside `approval_policy` and `sandbox_mode` in the
binary's own `ConfigToml` struct - is visible in the installed binary:

```console
$ NATIVE=$(find "$(dirname "$(dirname "$(readlink -f "$(command -v codex)")")")" -type f -path "*/vendor/*/bin/codex" | head -1)
$ echo "$NATIVE"
/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex
$ strings -a "$NATIVE" | grep -c "approvals_reviewer"
37
$ strings -a "$NATIVE" | grep -o "approval_policyapprovals_reviewerauto_review" | head -1
approval_policyapprovals_reviewerauto_review
```

(Adjacent struct-field names concatenate in the binary's string table, so that exact
match existing at all is the point - `approvals_reviewer` sits between `approval_policy`
and its `auto_review` value in the `ConfigToml` schema. It is also the rollout
`turn_context` field `src/server/harness/codex/rollout.ts` already reads the mode back
from, so the write side and the read side name the same key.)
