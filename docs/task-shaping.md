# Task shaping

Task shaping asks operator-configured programs for context about a task. Each program is a
**shaper**: a **gatherer** at stage `gather` reads the task's repositories, and a **selector**
at stage `select` chooses guidance for the task. How Mission Control reaches a shaper is its
**transport**. Mission Control ships the mechanism and no shaper of its own content.

**What this build does.** You register a `command` shaper, or the built-in
[`repository-files` gatherer](#the-built-in-gatherer), in **Settings > Task shaping** or through
the API, and dry-run it against a repository. Mission Control calls it at the stage it is
registered for, validates and caps what it returns, and reports the section it would add to a
worker's first prompt and an outcome for each shaper. A `command` shaper can serve either
stage, `gather` or `select`. `repository-files` serves `gather` only, and a definition that
places it at `select` is refused. Nothing is called at dispatch: no worker
receives shaped context yet.

**What comes later.** Calling shapers at dispatch, so that the section reaches the worker, and
the other surfaces arrive in later phases. The sections marked for later below describe them.

Task shaping is a preview behind the `task-shaping` flag in **Settings > Feature flags**. With
the flag off, the shaping API answers 404, Settings has no Task shaping category, no window is
sent the config, and nothing reads the stored shapers.

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
  reason. A reply that is not degraded keeps its `notes` as its reason too, such as the files a
  gatherer skipped, without marking the run degraded.
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
| `unavailable` | The shaper could not be reached: a missing command, no worktree, or a transport this build does not offer yet |

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
  `discovered` and `references` are empty until the folder and the remote transports land.
- **`PUT /api/shaping`** takes one intent and returns `{ config }`:
  - `{ "kind": "upsert", "shaper": {...} }` creates or replaces a registered shaper. Either
    way it is stored off, as an explicit `false` in `overrides`: a choice to run it applies to the definition the operator reviewed,
    so a replacement is switched on again with `enable` after it has been dry-run.
  - `{ "kind": "remove", "id": "...", "expect"?: "..." }`. When a shaper in the folder has the
    same id, the registration was shadowing it, and removing the registration stores that id off
    in its place in the order, so the folder shaper runs only once it is switched on.
  - `{ "kind": "enable", "id": "...", "enabled": true, "expect"?: "..." }` stores the operator's choice.
  - `{ "kind": "move", "id": "...", "after": "..." | null }` places a registered shaper right
    after another registered shaper of its stage, or first for `null`. It is applied to the order
    as stored when it arrives, so moves from two windows both stick, and repeating one changes
    nothing. Stored ids that belong to no row keep their slots. When the move would pass the
    order's bound of 128 ids, stored ids that name no registered or discovered shaper are left
    out, the oldest kept, and otherwise it is refused with `order_full`.
  - `{ "kind": "reorder", "order": ["...", "..."] }` sets the run order within each stage.
  - `{ "kind": "settings", "caller": { "user": "..." }, "limits": {...} }` changes the declared
    caller identity and the budgets.

  `expect` is the `shapingEntryRevision` of the entry as the sender showed it: 16 hex digits
  over its view, from `src/shared/shaping.ts`. When it is sent and the stored entry has changed
  since, the intent answers 409 `shaper_changed` and nothing is stored, so a click never removes
  or switches on a replacement another window wrote in the meantime. Any other refused intent
  answers 400 with `{ error, reason }`.
- **`POST /api/shaping/test`** takes `{ id, repository, prompt?, kind?, expect? }`, where `expect`
  is refused with 409 `shaper_changed` as above, and `repository` is
  an absolute path inside a local Git checkout, and runs that one shaper through the shaping
  engine, whatever its stored choice. A path that is not inside a checkout, such as a mistyped
  one that names an ordinary folder, answers 400 `unknown_repository` and runs nothing. A
  gatherer runs at the path given. The repository is named after the checkout, or after the
  repository that owns it when the path is a linked worktree. It answers
  `{ summary, section, entries }`: each shaper's outcome, reason, duration and version, whether
  a credential value was removed from its reply (`redacted`, set by the remote transports in
  Phase 5), the section that would be injected, and each entry in it. The summary's optional
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

**Settings > Task shaping** sits under Sessions, after Tasks, and is there only while the
`task-shaping` flag is on. Switching the flag in any window adds or removes the category in
every open window, in the rail, settings search and the palette alike, with no reload; a
window already open on its link shows the panel the moment the flag turns on. Every change
below applies at once in every open window, one write at a time. A refused write rolls back and
shows the daemon's reason beside the control that sent it.

- **The list.** One row per registered shaper, grouped by stage in run order: its label, id,
  transport and everything it runs or calls, an MCP shaper's tool and context delivery
  included, with an on or off switch read by the same rule a launch uses. The switch, Remove
  and Dry run carry the revision of the definition the row shows, so the daemon refuses any of
  them once another window has replaced that shaper. A row that names environment variables lists them, each marked set or not set
  once the daemon reports it, never with a value. An entry this build cannot run is listed last,
  under **Not supported by this build**, with its reason. It can be removed, and switched off if
  an older build left it on, but not switched on, moved or dry-run.
- **Import manifest.** Paste a manifest or choose its file. It is read with the daemon's own
  schema, and before anything is saved the dialog shows its stage, the exact command and
  arguments or the URL and headers, every environment variable it names, and what it is given.
  A remote shaper's list is what it is sent: the prompt, the task context, repository names, a
  gatherer's facts and summary, the launch's trace context and its own header references. The
  repositories' local paths and every other credential are left out, but the text that is sent
  goes as written: a prompt, title, fact or summary that contains a path, file contents or a
  secret sends that too. Text longer than four times a stored definition's 16 KiB is refused
  before it is read or parsed. **Save
  switched off** stores it off, whatever its manifest says and whatever was stored for its id
  before, so it runs only once you switch it on. A manifest that breaks the credential rule, or
  names a `./` command a registered shaper cannot resolve, is refused with its reason and
  nothing is saved.
- **Order.** The arrows move a shaper earlier or later within its stage. Each sends a `move`
  intent, which the daemon applies to the order as stored, so another window's move in the
  meantime is kept and a shaper the list does not draw keeps its slot. When the order is full,
  the daemon decides what may make room, and the row says so if nothing can.
- **Dry run.** Pick a repository Mission Control knows, or type a checkout's path, add a prompt
  if the shaper needs one, and run it. It runs whether or not it is switched on, saves nothing,
  and shows the outcome, the duration, the version and each entry it would add. Closing the
  dialog stops the run. If another window replaces or removes the shaper while the dialog is
  open, the dialog says so and will not run.
- **Remove** asks once more, then deletes the shaper's stored definition and its on or off
  choice. The confirmation closes if another window replaces the shaper first. When a shaper in
  the folder has the same id, the confirmation says it stays switched off.
- **Caller identity** is the text a shaper receives as `{caller.user}`: declared, unverified
  and not a secret. **Step deadline** (at most 60 s) and **Context budget** (at most 64 KiB) are
  `limits.deadlineMs` and `limits.totalBytes`. **Save** writes only the fields typed in this
  window, so a change another window made to the others is kept, and **Reset** puts back the
  saved values. A save the daemon does not answer within 15 seconds stops being waited on: the
  panel says so and shows the daemon's current settings.

The panel reads the config from the event stream's `shaping_config` frame and its snapshot
field ([Event stream](event-stream.md#task-shaping)), and writes through the three routes
above. Its settings are the `shaping` settings backup domain.

## The shaper folder

Arrives with discovery of `shapers/` under the state home.

## Remote shapers

Arrives with the `mcp` and `http` transports. Their config shapes are already accepted: an `mcp`
shaper names its `server`, its `tool` and a `contextDelivery` of `folded` or `argument`, and an
`http` shaper names its `url` and `headers`. Header values may reference `{caller.user}`,
`{caller.agent}`, `{caller.conversation}` and `{env:NAME}`. A credential is always a
reference: a header named `authorization`, `proxy-authorization` or `cookie`, or whose name
contains `token`, `secret`, `key`, `password`, `auth` or `credential`, without case, that is
not empty holds `{env:NAME}` references and nothing literal. `Authorization` and `Proxy-Authorization` may put
`Bearer`, `Basic`, `Token` or `Digest` before it (`Bearer {env:ACME_TOKEN}`). Any other
leading word is refused as part of the secret. A URL carries no user name, password or query
string. A definition with literal secret text is
refused, so it is never stored or backed up. Until that phase lands, such a shaper's outcome
is `unavailable`.

## The built-in gatherer

`repository-files` ships inside Mission Control, so an operator can have named files added as
context without writing a program. It is a gatherer: it runs at the `gather` stage only, so a
definition that places it at `select` is refused. It is called once per attached repository,
in that repository's worktree, and reads only what its options name. It never lists the
worktree, follows a link out of it, or opens a file it was not told to.

```sh
curl -s -X PUT http://127.0.0.1:7317/api/shaping \
  -H 'content-type: application/json' \
  -d '{"kind":"upsert","shaper":{"id":"repo-files","label":"Repository files","stage":"gather",
       "transport":{"type":"builtin","builtin":"repository-files","options":{
         "include":[{"path":"AGENTS.md"},{"path":"docs/architecture.md","maxBytes":8192}],
         "summary":"docs/summary.md",
         "facts":".mission/facts.json"}}}}'
```

Like every registered shaper it is stored switched off. Dry-run it, then switch it on.

- **`include`.** Up to 16 paths, each with a `maxBytes` of at most 16 KiB, the default. Each
  file read becomes one context entry whose id and title are its path, marked `truncated` when
  it was cut. Entries share the shaper's and the run's budget like any other shaper's. An entry's
  id is at most 512 characters, so a longer path is skipped unread with a note.
- **`summary`.** One path, cut to 4 KiB and returned as the repository's `summary`. A cut summary
  marks the reply `truncated`, and so does an include or summary cut to nothing.
- **`facts`.** One path to a JSON object whose values are strings or lists of strings, at most
  64 KiB in all, such as
  `{ "language": "python", "framework": ["django"] }`. It is returned as the repository's
  `facts`. It holds at most 64 names of 1 to 128 characters each. A value is one string, or a
  list of at most 64 strings, and every string, in a list or not, is at most 1024 characters.
  A file that is not such an object is skipped with a note, and no facts are returned.

The summary and facts are handed to the selectors in their requests. They are not added to the
section by themselves. A path is relative to the worktree, and every repository attached to a
task is read at the same paths in its own worktree, so two worktrees give two entries.

### How a file is read

Every check is made on the file that is read, never on a path looked up beforehand, because a
worktree file can be replaced while shaping runs.

1. **Path.** A path that is absolute or has a `..` segment is refused. Its real path, with
   every link resolved, must lie inside the worktree's real path, so a link to another file
   inside the worktree is followed and a link out of it is not. Anything that is not a regular
   file, such as a directory or a named pipe, is skipped without being opened.
2. **Open.** The real path is opened without following a final link, and non-blocking, so a
   named pipe swapped in meanwhile, or a device whose driver honours non-blocking opens, cannot
   make the open wait for a writer. Non-blocking does not bound every open: one on a hung
   network filesystem can still wait, and the checks below run only once it returns.
3. **Identity.** The opened file must be a regular file of at most 4 MiB, and the real path,
   looked up again, must still be free of links, inside the worktree, and name the same file as
   the one opened. A file moved or hard-linked into the worktree is a worktree file.
4. **Read.** At most the file's cap plus five bytes is read from the opened file, so one that
   grows meanwhile is still cut off. The five bytes are three for a byte order mark, which is
   dropped before the cap applies so it never counts against it, and two to see whether a line
   ends just past the cap. The cap applies to the text returned: invalid UTF-8 is replaced, and
   the text is cut at the last line boundary, LF or CRLF, within the cap.

These checks prove that no file outside the worktree is read while the worktree's directories
are not being rearranged during the read. A process running as you that swaps a directory on
the path in a tight race between the open and the identity check can still get an outside file
read. That process could read the file itself, so it is outside the threat model.

### Skipped files

A file that cannot be used is skipped, and each skip becomes one short sentence naming its path
and reason, such as `Skipped "docs/architecture.md" (missing).` or
`Skipped the summary "docs/summary.md" (empty).` Every skip is kept: past the reply's 16 notes,
consecutive sentences share a note. The sentences become the shaper's reason, which the record
holds to 500 characters. A skip is not a failure: the outcome stays `ok`, the run is not
degraded, and the launch is never affected.

| Reason | When |
| --- | --- |
| `missing` | No file at that path |
| `outside-worktree` | The path is absolute, has a `..` segment or resolves outside the worktree, or the opened file is not the one inside it |
| `not-a-regular-file` | A directory, a named pipe, a device or a socket, or a link swapped in after the lookup |
| `too-large` | Larger than 4 MiB |
| `unreadable` | The operator cannot read it |
| `empty` | The whole file is nothing but white space once decoded |

A file that is cut to nothing is not `empty`: a longer file whose first bytes, up to its cap,
are only white space, or a short one whose replacement characters outgrow its cap so no whole
line fits. It is skipped with a sentence that says so, and a facts file like it still
reports that it is larger than 64 KiB once decoded. An incomplete UTF-8 sequence at the very end of a file
is replaced like any other invalid byte, so a facts file with trailing garbage is not valid
JSON. Only one at a cut, where the read stopped inside the file, is dropped.

A facts file that is not valid JSON, not a flat object of strings or string lists, or larger
than 64 KiB is skipped with a sentence that says so. A worktree that is not on this machine
makes the call `unavailable`. The call's signal is checked before every filesystem call, so a
call stopped at the step's deadline starts no further lookup, open or read.

The gatherer runs in the daemon, on Node's shared pool of file-I/O threads, and a call already
running on a hung network mount cannot be cancelled. So every `repository-files` call in the
daemon shares one gate, with one filesystem call in flight at a time: a stalled worktree can hold
at most one of the pool's threads, and other daemon file work keeps the rest. A call waiting for
the gate holds no thread and gives up at its deadline.
