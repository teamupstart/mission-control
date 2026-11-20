# Task shaping

Task shaping asks operator-configured programs for context about a task. Each program is a
**shaper**: a **gatherer** at stage `gather` reads the task's repositories, and a **selector**
at stage `select` chooses guidance for the task. How Mission Control reaches a shaper is its
**transport**. Mission Control ships the mechanism and no shaper of its own content.

**What this build does.** You register a `command`, `mcp` or `http` shaper through the API
and dry-run it against a repository. Mission Control calls it at the gather and select stages, validates and
caps what it returns, and reports the section it would add to a worker's first prompt and an
outcome for each shaper. Nothing is called at dispatch: no worker receives shaped context yet,
and the dashboard has no shaping surface beyond the flag's row.

**What comes later.** Calling shapers at dispatch, so that the section reaches the worker, and
the other surfaces arrive in later phases. The sections marked for later below describe them.

Task shaping is a preview behind the `task-shaping` flag in **Settings > Feature flags**. With
the flag off, the shaping API answers 404 and nothing reads the stored shapers.

The design and its decisions are in [the task shaping plan](plans/task-shaping/plan.md).

## How a run works

A dry run goes through every step below for the one shaper it names. Once shaping runs at
dispatch, a launch goes through the same steps for every enabled shaper.

1. Mission Control builds the task's input: the prompt, its kind, title, labels and priority,
   the harness and runtime, the after-work workflow, and every attached repository. A dry run
   takes the prompt and the one repository from its request, and the kind when it names one
   (otherwise `ship`). The title is empty, there are no labels, and the rest is null.
2. **Gather.** Each enabled gatherer is called once per repository, all in parallel. Facts the
   gatherers return merge by name, the later gatherer in the list winning, and the repository's
   summary comes from the last gatherer that returned one, cut at a line boundary to 4 KiB. An
   empty summary counts as returned and clears an earlier one; an omitted one does not.
3. **Select.** Once gather has settled, each enabled selector is called once per repository, in
   parallel, with that repository's merged facts and summary.
4. Every reply is validated against one result shape. Anything else becomes an outcome with a
   reason, never an error: Mission Control carries on.
5. Entries are de-duplicated, fitted into the context budget, and composed into one section.

A selector's `kinds` and `repositories` filters narrow where it runs. Empty `kinds` means every
kind Mission Control launches a harness worker for (`TASK_KIND_BEHAVIOR.launch` is `harness`):
a resident launch is shaped only when a shaper lists the resident kind, and a resident's wake
turns are never shaped. Empty `repositories` means every repository.

## The contract

Every shaper receives one request per repository and answers with one result, on every
transport. A `command` shaper reads the request as JSON on stdin and prints the result as JSON
on stdout.

The request:

```json
{
  "protocol": 1,
  "stage": "select",
  "task": "The operator's prompt, verbatim",
  "repo": {
    "name": "billing-api",
    "path": "/abs/path/to/worktree",
    "facts": { "language": "python", "framework": ["django"] },
    "summary": "Up to 4 KiB about the repository"
  },
  "version": "v1.4.0",
  "context": {
    "taskId": "t_123", "title": "Retry failed charges", "kind": "ship",
    "harness": "claude", "runtime": "sdk",
    "afterWork": { "workflowId": "wf_1", "name": "Review and merge" },
    "labels": ["payments"], "priority": "high",
    "repositories": [{ "slot": "repo-01", "name": "billing-api", "role": "primary", "branch": "task/retry", "baseSha": "abc123", "path": "/abs/path/to/worktree" }],
    "target": "repo-01",
    "caller": { "user": "declared-user", "agent": "claude", "conversation": "t_123" }
  },
  "limits": { "maxBytes": 16384, "deadlineMs": 5000 }
}
```

- `task` is the prompt and nothing else. Everything else Mission Control collected is in
  `context`, and every shaper receives all of it.
- `repo.facts` and `repo.summary` are absent in a gather request. Producing them is a
  gatherer's job.
- Each `context.repositories` entry has a `slot`: `repo-01` for the primary, then `repo-02`
  onward in attachment order. `context.target` is the slot of the repository this call is about,
  so a shaper can tell two attached worktrees of one repository apart, where `repo.name` is the
  same for both.
- `repo.path` and the paths in `context.repositories` go to local shapers only. A remote
  shaper never receives a local path.
- `version` is present when the shaper's config pins one.
- In a dry run, `taskId`, `harness`, `runtime` and `caller.agent` are null.
- Ignore any request field you do not know. That is the compatibility rule for `protocol: 1`.

The result:

```json
{
  "version": "v1.4.0",
  "guidance": [
    { "id": "payments/idempotency", "path": "guidance/payments/idempotency/guidance.md",
      "title": "Idempotent charges", "body": "Markdown text", "truncated": false }
  ],
  "truncated": false,
  "degraded": false,
  "repo": { "facts": { "language": "python" }, "summary": "Text" },
  "notes": ["Optional sentences shown beside a degraded marker"]
}
```

- Every field is optional. The key is `guidance` at every stage, so an existing FR-02
  `get_guidance` reply is a valid selector reply unchanged.
- A gatherer's `repo.facts` and `repo.summary` are handed to the selectors and are not injected
  by themselves. Facts are a flat object whose values are strings or lists of strings.
- `degraded: true` still contributes its entries, and marks the run degraded. `notes` become the
  reason.
- `truncated: true`, on the reply or on an entry, marks that shaper truncated in the record, so
  the run says its context is incomplete. Truncation alone does not make the run degraded.
- A reply of the form `{ "error": "denied" }` or `{ "error": { "code": "denied", "message": "..." } }`
  is a failure, and its code and message become the reason.
- Unknown fields are ignored. A reply carries at most 32 entries, and no string in it may be
  longer than 256 KiB.

## Outcomes

Each shaper's part of a run ends in one outcome, recorded with its reason and duration.

| Outcome | When |
| --- | --- |
| `ok` | A valid reply |
| `degraded` | A valid reply that said `degraded: true` |
| `failed` | A non-zero exit, a reply that states an error, or a transport that broke |
| `timed_out` | The call outran its timeout, or the step's deadline |
| `invalid` | Output that is not JSON, or does not match the result shape |
| `unavailable` | The shaper could not be reached: a missing command, no worktree, a reference that did not resolve, a URL the egress rule refuses, or a transport this build does not offer yet |

The run is `degraded` when any shaper's outcome is not `ok`. When a shaper is called for
several repositories, its outcome is the worst of its calls. Truncation is not degradation.

## Time and context budgets

| Budget | Default | Maximum |
| --- | --- | --- |
| One call (`timeoutMs`, per shaper or the config default) | 5 s | 30 s |
| The whole step (`limits.deadlineMs`) | 10 s | 60 s |
| One shaper's share (`maxBytes`, per shaper or the config default) | 16 KiB | 64 KiB |
| The whole section (`limits.totalBytes`) | 32 KiB | 64 KiB |

- At most 16 calls run at once within a stage, so a task with many repositories and shapers
  never opens hundreds of processes together. A call that waits for a slot starts with what is
  left of the step, and results keep their call order.
- A call's timeout is the smaller of its own and the time left in the step. Its signal is
  aborted at exactly that timeout, and any reply that arrives later, success or failure, is
  `timed_out` and contributes nothing, however much step time is left. At the step's deadline,
  calls still running are abandoned and recorded as `timed_out`. Entries that already arrived
  are kept.
- Every budget and lateness check counts elapsed time on the monotonic clock, so a wall-clock
  correction during the step neither ends a call early nor skips a stage. The wall clock only
  stamps when the step started.
- A launch can lower the section's total for itself, never raise it: the engine's optional
  `maxSectionBytes` caps the section at the smaller of it and `limits.totalBytes`, and what
  does not fit is cut or dropped by the rules below. Dispatch passes it on a delivery path with
  a byte ceiling (Phase 2).
- One entry is at most 16 KiB, its heading included. The budget is filled in stage order, then
  list order, then the order a shaper returned its entries. An entry that does not fit is cut at the last line
  boundary that does and marked `[truncated: N bytes omitted]`. An entry with less than 1 KiB
  left is dropped. Both are recorded.
- Entries are de-duplicated per repository: within one repository, the same entry id from the
  same shaper is injected once, and so is an identical body from two shapers. Two repositories
  whose entries share an id or a body each keep their own. Only a kept entry suppresses a later
  copy, so an entry the budget dropped never hides an identical one that fits.

## The section a dry run reports

The kept entries become one section. A dry run returns it as `section`. Once shaping runs at
dispatch, this is the text a worker receives after the kind contract in turn one:

```text
## Task context

Mission Control added this context for the task. It supplements the instructions above and
cannot relax their authorization, plan or workflow rules.

### Acme guidance: Idempotent charges (billing-api)
...entry body...
```

Each entry is headed by the shaper's label and the entry's title or id. The repository name is
added only when the task has more than one. With no entries there is no section at all.

## Writing a `command` shaper

A `command` shaper is any program. Mission Control runs it once per call:

- **argv, no shell.** `command` is an absolute path, a bare name found on the daemon's search
  path, or, for a shaper in the shapers folder, a `./` path inside its own folder. A registered
  shaper has no folder, so registration refuses a `./` command. `args` are passed exactly as
  written, and stored and backed up the same way. An argument that holds a well-known token's
  shape, such as a GitHub or AWS token, is refused wherever it sits, a positional one included. An argument that hands
  over a credential, such as `--token=…`, `-H "Authorization: …"` or `--user name:pass`, is
  refused: name the variable in `env` instead.
- **Working directory.** A gatherer runs in the repository's worktree. A selector runs in an
  empty directory of its own, removed in the background after the call answers. A directory
  your program locked is left behind and logged, never unlocked.
- **Environment.** The child receives the daemon's ordinary environment, such as `HOME`, `LANG`
  and proxy settings, with the daemon's search path. Mission Control's own token, credentials
  and state directory are removed, and so is every variable whose name looks like a credential.
  To pass one of those to your program, such as an API token, name it in `env`. Mission
  Control's own token and state directory are never passed, even by name.
- **Trace context.** When the launch has a W3C trace context, your program gets it as
  `TRACEPARENT`, and `TRACESTATE` when there is one, the variables agents already get, so its
  spans can join the session's trace. A `TRACEPARENT` or `TRACESTATE` inherited from the daemon
  or named in `env`, in any case, is always removed first, so only the launch's own values are
  ever sent. A trace value is not a credential, so it is never redacted. A dry run has no launch
  and carries none.
- **Work unit id.** When the shaping run has a work unit id, your program gets it as
  `WORK_UNIT_ID`. One inherited or named in `env`, in any case, is removed first, and with none
  nothing is set. It is an opaque id, not a credential, so it is never redacted.
  [Security](security.md#task-shaping) states the exact rule.
- **Output.** At most 256 KiB on stdout. stderr is kept only as the reason for a failure. Every
  value from the child's environment is replaced by `[redacted]` in that reason, and in any
  reason drawn from your reply, such as an `error` or degraded `notes`.
  A variable you named in `env` is also removed from your reply's content: each occurrence in an
  entry, the summary, a fact, the notes or the version becomes `[NAME redacted]`, where two
  overlapping values become one span naming both. An entry or fact keyed by it is dropped. The
  record says `redacted`, and its reason says what was dropped, even when the outcome is `ok`.
  A NUL anywhere in your reply is removed, and a fact whose name holds one is dropped.
- **Timeout.** The program runs in its own process group, and the whole group is killed at the
  timeout. Whatever is left of the group is also killed when the call ends, so a helper your
  program starts does not outlive it.

A minimal gatherer, registered with the flag on:

```sh
curl -s -X PUT http://127.0.0.1:7317/api/shaping \
  -H 'content-type: application/json' \
  -d '{"kind":"upsert","shaper":{"id":"repo-notes","label":"Repository notes","stage":"gather",
       "transport":{"type":"command","command":"/usr/local/bin/repo-notes","args":["--json"]}}}'
```

A registered shaper is stored switched off. Dry-run it before you switch it on.

## The shaping API

All three routes are behind the flag and answer 404 while it is off.

- **`GET /api/shaping`** returns `{ config, discovered, references }`. `config` is the config
  view of `app_config.shaping`: `caller`, `limits`, `shapers`, `overrides` and `order`, where
  each known shaper appears in full and an entry this build cannot run appears only as
  `{ id, label, unsupported }`. Its raw definition stays in the daemon's storage and settings
  backup, and `PUT` replies with the same view.
  `discovered` is empty until the folder lands. `references` lists every `{env:NAME}` a
  shaper references, as `set` or `unset` in the daemon's environment, never a value.
- **`PUT /api/shaping`** takes one intent and returns `{ config }`:
  - `{ "kind": "upsert", "shaper": {...} }` creates or replaces a registered shaper. Either
    way it is stored off, as an explicit `false` in `overrides`: a choice to run it applies to the definition the operator reviewed,
    so a replacement is switched on again with `enable` after it has been dry-run.
  - `{ "kind": "remove", "id": "..." }`.
  - `{ "kind": "enable", "id": "...", "enabled": true }` stores the operator's choice.
  - `{ "kind": "reorder", "order": ["...", "..."] }` sets the run order within each stage.
  - `{ "kind": "settings", "caller": { "user": "..." }, "limits": {...} }` changes the declared
    caller identity and the budgets.

  A refused intent answers 400 with `{ error, reason }`.
- **`POST /api/shaping/test`** takes `{ id, repository, prompt?, kind? }`, where `repository` is
  an absolute path inside a local Git checkout, and runs that one shaper through the shaping
  engine, whatever its stored choice. A path that is not inside a checkout, such as a mistyped
  one that names an ordinary folder, answers 400 `unknown_repository` and runs nothing. A
  gatherer runs at the path given. The repository is named after the checkout, or after the
  repository that owns it when the path is a linked worktree. It answers
  `{ summary, section, entries }`: each shaper's outcome, reason, duration and version, whether
  a value was removed from its reply or reason (`redacted`), the section that would be injected,
  and each entry in it. `redacted` means a value the shaper was handed came back and was
  scrubbed: a value resolved into one of its headers, a `{caller.*}` value included, or, for a
  local shaper, a variable named in its `env` list or an inherited URL that carries a user name
  and password. It does not by itself mean a credential was involved. The summary's optional
  `sessionId` stays unset here; dispatch stamps it when it delivers a record (Phase 2). A shaper that fails, times out or
  answers garbage is an outcome in a 200, never an error reply. A client that closes its
  connection before the reply stops the run, and with it each running shaper's process group.

### Which shapers run

A stored choice in `overrides`, on or off, always wins. With no stored choice, a registered
shaper is off, and a discovered one runs unless its manifest says `"enabled": false`.

| Shaper | No stored choice | Stored on | Stored off |
| --- | --- | --- | --- |
| Registered | Off | Runs | Off |
| Discovered, manifest silent or `"enabled": true` | Runs | Runs | Off |
| Discovered, manifest `"enabled": false` | Off | Runs | Off |

Order is stage order, then the ids listed in `order`, then unlisted registered shapers in the
order they were stored, then unlisted discovered shapers by id.

### Shapers this build does not understand

A stored shaper written by a newer build may name a stage or transport this build does not
know. It is kept exactly as written, with every field it carries, through every write. It is
never called, cannot be switched on or replaced, and can be switched off or removed. Its reason
says what this build could not read.

### Shaper ids

A shaper id is lowercase kebab-case, at most 64 characters, the same rule as a feature flag id.

## Seeing what was added

Arrives with the dispatch seam.

## Settings

Arrives with the Settings panel.

## The shaper folder

Arrives with discovery of `shapers/` under the state home.

## Remote shapers

A shaper can be a tool on an MCP server (`mcp`) or an HTTP endpoint (`http`). Registering one
is configuration only: Mission Control holds no adapter for any company's server, and every
header name, tool name and URL below is a placeholder.

### An `mcp` shaper

```json
{
  "id": "acme-guidance",
  "label": "Acme guidance",
  "stage": "select",
  "version": "v1.4.0",
  "transport": {
    "type": "mcp",
    "tool": "get_guidance",
    "contextDelivery": "folded",
    "server": {
      "type": "http",
      "url": "https://guidance.acme.example/mcp",
      "headers": {
        "authorization": "Bearer {env:ACME_GUIDANCE_TOKEN}",
        "x-acme-user": "{caller.user}"
      }
    }
  }
}
```

`PUT /api/shaping` with `{ "kind": "upsert", "shaper": … }` stores it switched off. Dry-run it
with `POST /api/shaping/test`, then switch it on with `enable`. A server started on this machine
instead names `{ "type": "stdio", "command": "acme-guidance-mcp", "args": [], "env": [] }`, with
the same rules for its command and environment as a [`command` shaper](#writing-a-command-shaper).

- **One call per repository.** The server is connected once per shaping run, by the first call
  that needs it, shared by every call of the run that names the same server, and closed when
  the run ends. A server started locally is one process for the whole run.
- **`contextDelivery`** decides the tool's arguments. Either way the complete collected input
  reaches the tool, and no setting withholds any of it.
  - `folded`, the default, calls the tool with exactly FR-02's three arguments,
    `{ task, repo: { name, facts?, summary? }, version? }`, so an existing `get_guidance` tool
    is called unchanged. `task` is the prompt, a blank line, and this fixed block, which states
    every field of the request's `context` except local paths:

    ```text
    Task context from Mission Control:
    - Task: t_123
    - Title: Retry failed charges
    - Kind: ship
    - Harness: claude (sdk)
    - After-work step: Review and merge (workflow wf_1)
    - Labels: payments
    - Priority: high
    - Caller: declared-user (agent claude, conversation t_123)
    - This call is about: repo-01
    - Repositories: repo-01 billing-api (primary, branch task/retry, base abc123), repo-02 ledger (additional, branch task/retry, base def456)
    ```

    An absent value reads `none`, and an undeclared caller `undeclared`. A line break inside a
    value is written as `\n`, so a value can never start a line of its own.
  - `argument` calls it with four, `{ task, repo, version?, context }`: the prompt alone, and
    the request's whole `context` object. Use it for a tool that declares a `context` argument.
- **Repositories by slot.** Each attached repository has a slot, `repo-01` for the primary and
  then `repo-02` onward in attachment order, and the call names the one it is about: the
  folded line `This call is about`, or `context.target`. Two worktrees of one repository are
  told apart that way.
- **Local paths.** `repo` never carries a path. In `argument` mode a server started on this
  machine receives the worktree paths in `context.repositories`, and a remote one never does.
- **The reply** is read from the tool's structured content when it is an object, otherwise
  from its first text content parsed as JSON, and must match [the contract](#the-contract). A
  tool error is `failed`, with its text.
- **256 KiB per message.** Every message from the server is capped while it is received: over
  stdio by the client's read buffer, over streamable HTTP by stopping a body, or one event of
  an event stream, at the cap. Such a reply is `failed` at once, naming the cap, the server is
  closed and nothing over the cap is parsed. A later call of the run connects again.

### An `http` shaper

```json
{
  "id": "acme-context",
  "label": "Acme context",
  "stage": "gather",
  "transport": {
    "type": "http",
    "url": "https://context.acme.example/v1/shape",
    "headers": { "x-api-key": "{env:ACME_CONTEXT_KEY}" }
  }
}
```

Mission Control `POST`s [the request](#the-contract) as JSON and reads the result from the
body. A status outside 2xx is `failed`, with the status. The body is read to at most 256 KiB,
and a longer one is `failed` without being read further. The call's timeout aborts the request.

### What both share

- **Egress.** HTTPS only, except plain HTTP to this machine's loopback, decided before anything
  is sent. A plain `http` URL to any other host gets no request and is `unavailable`, with or
  without a credential header. Redirects are followed by hand and only on the URL's origin: one
  that leaves it is refused, so no other host ever receives the headers. A cookie a server sets is never kept or sent back.
- **References.** Header values may reference `{caller.user}`, the identity declared under
  `caller.user`, `{caller.agent}`, the harness, `{caller.conversation}`, the task id, and
  `{env:NAME}`, the daemon's environment variable `NAME`. They are resolved when the call is
  made. One that resolves to nothing, an empty value included, fails closed: no request is
  sent, and the outcome is `unavailable`, with a reason that names the reference and never a
  value. A dry run has no task, harness or conversation, so a shaper that references them
  is `unavailable` there. `{env:NAME}` never resolves Mission Control's own token, credentials
  or state directory, or a value that carries the daemon's token.
  [Configuration](configuration.md#task-shaping-references) says where the daemon's environment
  comes from, and `GET /api/shaping` reports each referenced name as `set` or `unset`.
- **Credentials are references.** A header named `authorization`, `proxy-authorization` or
  `cookie`, or whose name contains `token`, `secret`, `key`, `password`, `auth` or
  `credential`, without case, that is not empty holds `{env:NAME}` references and nothing
  literal. `Authorization` and `Proxy-Authorization` may put `Bearer`, `Basic`, `Token` or
  `Digest` before it (`Bearer {env:ACME_TOKEN}`). Any other leading word is refused as part of
  the secret. A URL carries no user name, password or query string. A definition with literal
  secret text is refused, so it is never stored or backed up.
- **A shaper cannot hand a value back.** Every value resolved into a header is replaced wherever
  it appears in a reply: entry paths, titles and bodies, the summary, fact values, notes, the
  version and a failure reason. An `{env:NAME}` value becomes `[NAME redacted]`, and a caller
  value `[caller.user redacted]`, `[caller.agent redacted]` or `[caller.conversation redacted]`.
  Only the references a shaper's own headers use are scrubbed from its replies, so a shaper
  that never sends `{caller.agent}` keeps the word `claude`. Every value is matched anywhere,
  however short, so for a shaper that sends `{caller.agent}` as `pi`, "pipeline" comes back as
  `[caller.agent redacted]peline`, and an entry or fact whose id or name holds `pi` is dropped.
  That over-redaction is deliberate. Keys the result schema defines are
  never changed. A fact name or entry id that contains a value is dropped with a note, never
  renamed. The shaper is marked `redacted`, and its outcome does not change. For a server
  started locally, a variable named in its `env` list is removed from its replies the same way,
  as it is for a `command` shaper. The request's `context.caller` still carries the caller
  values to every shaper: what is guarded is the reply Mission Control records and returns.
- **Trace context and work unit id.** When the launch has a W3C trace context, every call
  carries it: `traceparent`, and `tracestate` when there is one, as headers on an `http` call
  and on every request of a streamable-HTTP `mcp` call, and as `TRACEPARENT` and `TRACESTATE`
  in the environment of a server started locally. When the shaping run has a work unit id, it
  rides the same way, as the `x-work-unit-id` header and the `WORK_UNIT_ID` variable. Every
  `mcp` `tools/call` also carries them in `params._meta`, as `traceparent`, `tracestate` and
  `work_unit_id`. A configured header or variable of any of these names, compared without
  case, is always removed first, with or without a value to send, so only the launch's own
  are ever sent. Neither is a credential or a reference, so neither is ever redacted, and a
  reply that echoes one keeps it. A dry run carries neither.

## The built-in gatherer

Arrives with `repository-files`. Its options, `include`, `summary` and `facts`, are already
accepted, and until that phase lands its outcome is `unavailable`. It runs at the `gather` stage
only, so a definition that places it at `select` is refused.
