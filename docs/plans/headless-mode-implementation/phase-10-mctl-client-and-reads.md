# Phase 10: mctl client and read commands (WP6a)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, 7.13.

**1. Outcome.** `mctl` can read the daemon: `get`, `describe`, `logs` (including `-f`), `status` and `config`, with the same token and rules as the mod, and it never answers, approves, cancels or sends.

**2. Entry and dependencies.** Direct prerequisite: P4 (inbox and config shapes). `logs` needs P9's transcript routes. Until P9 lands, the real routes are P1's stubs and answer 501, so `mctl logs` and `mctl logs -f` print `the transcript routes are not available in this build yet` and exit 1, with no retry loop. Once P9 lands they work with no change to `mctl`.

**3. Scope.** The commands `mctl get`, `mctl describe`, `mctl logs` (including `mctl logs -f`), `mctl status` and `mctl config`: `src/cli/client.ts`, `src/cli/commands/get.ts`, `describe.ts`, `logs.ts`, `status.ts`, `config.ts`. Non-goals: `run`, `claude`, `daemon` (P13), `setup` and `doctor` (P14).

**4. Findings.** `main` has no `src/cli/`; P2 supplies the registry. An `mctl` caller is a `cli` caller: it may read any home-dispatched task of its repository, or of every repository for the inbox read with `repo=*` (spec 7.7), and nothing else (spec 7.23). `mctl logs -f` follows the stream route and exits when the task ends. The client reads the token through the shared path helper.

**5. Steps.** Read spec 7.13. Implement the client with the `cli` surface header, then each read command against the inbox, config and transcript shapes. Print refusal text as written.

**6. Data and API.** No new routes. Flags and output formats are documented in the command help. `mctl get tasks` and `status` read `GET /dispatch/inbox` (with `repo=*` for `--all`), `config` reads `GET /dispatch/config`, and `logs` reads the transcript and stream routes of P9.

**7. Tests.** Each command against the fake daemon; refusal cases; `logs` and `logs -f` against a daemon whose transcript routes answer 501 (the not-available message, exit 1, no retry); `logs -f` reconnect and exit; no command can send or answer.

**8. Merge and exit.** All read commands work against the fake; against the 501 stub `mctl logs` and `mctl logs -f` print the not-available message and exit 1; flag off, `mctl` reports the feature off.

**9. Handoff.** P13 and P14 reuse `src/cli/client.ts`. Do not change its function signatures without a `contract:` note.

**10. Cross-phase audit.** `client.ts` owned only here; P13 and P14 import it. No overlap with P4.
