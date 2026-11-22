# Task shaping

Task shaping asks operator-configured programs for context about a task. Each program is a
**shaper**: a **gatherer** at stage `gather` reads the task's repositories, a **selector**
at stage `select` chooses guidance for the task, and a **router** at stage `route` chooses
skills for it ([Skill routing](#skill-routing)). How Mission Control reaches a shaper is its
**transport**. Mission Control ships the mechanism and no shaper of its own content.

**What this build does.** You register a `command`, `mcp` or `http` shaper, or the built-in
[`repository-files` gatherer](#the-built-in-gatherer), in **Settings > Task shaping** or through
the API, and dry-run it against a repository, or you drop a folder holding its manifest into
[the shaper folder](#the-shaper-folder), where it is switched on as soon as it is found unless
its manifest asks to start off. A `command`, `mcp` or `http` shaper can serve any stage,
`gather`, `select` or `route`. `repository-files` serves `gather` only, and a definition that places it at
`select` is refused. Every dispatch then calls the enabled shapers after its worktrees are
provisioned and before the worker starts, and adds what they return to the worker's first prompt
as a "Task context" section. A backlog task handed over to an agent that is already running
(`TaskManager.assign`, which Foreman's autopilot uses) is shaped the same way, after the handover
resets the agent and before its first turn is typed. The pending tile reads "Shaping context"
while that runs, and the session shows what it received and whether anything was degraded. A
failing or slow shaper never stops the launch.

**What comes later.** The other surfaces arrive in later phases. The sections marked for later
below describe them.

Task shaping is a preview behind the `task-shaping` flag in **Settings > Feature flags**. With
the flag off, the shaping API answers 404, Settings has no Task shaping category, no window is
sent the config, and nothing reads the stored shapers.

The design and its decisions are in [the task shaping plan](plans/task-shaping/plan.md).

## How a run works

A dry run goes through every step below for the one shaper it names. A dispatch goes through
the same steps for every enabled shaper.

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
4. **Route.** Once select has settled, each enabled router is called once per repository, in
   parallel, with the select request plus the ids of the entries the selectors put into the
   section for that repository. It answers with skills, not entries.
5. Every reply is validated against its stage's result shape. Anything else becomes an outcome
   with a reason, never an error: Mission Control carries on.
6. Entries are de-duplicated, fitted into the context budget, and composed into one section,
   followed by "Skills for this task" when a router announced any.

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
| `unavailable` | The shaper could not be reached: a missing command, no worktree, a reference that did not resolve, a URL the egress rule refuses, or a transport this build does not offer yet |

The run is `degraded` when any shaper's outcome is not `ok`. When a shaper is called for
several repositories, its outcome is the worst of its calls. Truncation is not degradation. A
launch is also recorded as degraded when Pi's launch wrapper had to drop the section at exec
(see [Where the section lands](#where-the-section-lands)).

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
  a byte ceiling, as [Where the section lands](#where-the-section-lands) describes.
- One entry is at most 16 KiB, its heading included. The budget is filled in stage order, then
  list order, then the order a shaper returned its entries. An entry that does not fit is cut at the last line
  boundary that does and marked `[truncated: N bytes omitted]`. An entry with less than 1 KiB
  left is dropped. Both are recorded.
- Entries are de-duplicated per repository: within one repository, the same entry id from the
  same shaper is injected once, and so is an identical body from two shapers. Two repositories
  whose entries share an id or a body each keep their own. Only a kept entry suppresses a later
  copy, so an entry the budget dropped never hides an identical one that fits.

## The section a dry run reports

The kept entries become one section. A dry run returns it as `section`. At dispatch, this is
the text a worker receives after the kind contract in turn one:

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

All three routes are behind the flag and answer 404 while it is off. `PUT /api/shaping` and
`POST /api/shaping/test` also answer 403 `forbidden` unless the body is declared
`application/json` and any `Origin` is a loopback `http:` origin, the check other browser-write
routes use, so a page on another site cannot store an intent or run a shaper. The check runs
before the body limit, so such a request is refused as forbidden whatever its size.

- **`GET /api/shaping`** returns `{ config, discovered, folder, references }`. `config` is the config
  view of `app_config.shaping`: `caller`, `limits`, `shapers`, `overrides` and `order`, where
  each known shaper appears in full and an entry this build cannot run appears only as
  `{ id, label, unsupported }`, plus `replaceable: true` when an import under its id replaces
  it, which the daemon allows only for the entry that owns the id, and only when it emptied a
  literal credential in it; a repeat behind the owner never carries it. A daemon older than the flag
  sends neither it nor `revisions`; the import dialog then says the daemon decides, rather than
  predicting a refusal. Its raw definition stays in the daemon's storage and settings
  backup, and `PUT` replies with the same view. The view also carries `revisions`, one opaque
  revision per stored shaper id, which the daemon derives from the stored entry itself, so two
  unsupported entries that show the same id, label and reason still have different revisions.
  A revision is an HMAC-SHA256 under a random key the daemon process holds and never writes
  (`src/server/shaping/revisions.ts`), cut to 16 hex digits, over the id's stored entries and its
  generation. The generation advances whenever what is stored under the id changes, by any writer,
  and on every import or removal of it, so the same definition stored again after a replacement
  never gets its earlier revision back and a write held since then cannot pass. An import that stores
  the same config again still sends every window the new revision. Generations come from one counter
  that only grows, and the daemon keeps them only for the ids stored now. It can be compared but not
  recomputed, so it cannot confirm a guess at a field the view hides, and a daemon restart
  changes every revision: an intent sent across a restart carries one the restarted daemon never
  issued, and is refused with `stale_dashboard`, whose reason asks the operator to reload the page.
  An id has one revision, over every entry stored under it, so a remove, which deletes them all,
  is refused once any of them has changed. A client reads only own, string-valued
  keys of `revisions` (`shapingViewRevision`), so an id such as `constructor` never resolves to
  an inherited property.
  `discovered` is [the shaper folder](#the-shaper-folder) as this request read it: one
  `{ id, path, state, problem, sha256, shaper }` per folder, where `path` is the folder's real
  path, `state` is `ok`, `invalid`, `refused` or `shadowed`, `problem` says why it cannot run,
  `sha256` is the manifest's hash and `shaper` the parsed manifest, null when it did not parse.
  `folder` is `{ path, ignored }`: where the scan looked, and how many entries past its bound of
  32 it left unread. `references` lists every environment name a
  shaper uses, each `{env:NAME}` its headers reference and each variable a `command` shaper or
  a locally started MCP server passes through in `env`, as `set` or `unset` in the daemon's
  environment, never a value. A name is `set` only when a call would send it, so Mission
  Control's own token and state directory, an empty value and a value carrying the daemon's
  token read `unset`. A variable named only in a header the transport replaces, such as
  `Accept`, or in a trace or work unit header, is never needed by a call and is not listed.
- **`PUT /api/shaping`** takes one intent and returns `{ config }`:
  - `{ "kind": "upsert", "shaper": {...} }` creates or replaces a registered shaper. Either
    way it is stored off, as an explicit `false` in `overrides`: a choice to run it applies to the definition the operator reviewed,
    so a replacement is switched on again with `enable` after it has been dry-run.
  - `{ "kind": "remove", "id": "...", "expect"?: "..." }`. When a shaper in the folder has the
    same id, the registration was shadowing it, and removing the registration stores that id off
    in its place in the order, so the folder shaper runs only once it is switched on.
  - `{ "kind": "enable", "id": "...", "enabled": true, "expect"?: "...", "manifest"?: "..." }`
    stores the operator's choice. `manifest` is the SHA-256 of the folder manifest the sender
    showed, which the dashboard sends for a folder shaper: switching on is refused with
    `shaper_changed` once the folder holds another manifest for the id or a registered shaper
    has taken it. Switching off is applied either way. A folder shaper that is not `ok` cannot
    be switched on.
  - `{ "kind": "move", "id": "...", "after": "..." | null }` places a registered shaper right
    after another registered shaper of its stage, or first for `null`. It is applied to the order
    as stored when it arrives, so moves from two windows both stick, and repeating one changes
    nothing. Stored ids that belong to no row keep their slots. When the move would pass the
    order's bound of 128 ids, stored ids that name no registered or discovered shaper are left
    out, the oldest kept, and otherwise it is refused with `order_full`.
  - `{ "kind": "place", "id": "...", "after": "..." | null, "expect": "..." }` is the same move
    bound to the revision shown, which the dashboard sends: once that definition is replaced, into
    another stage included, it is refused with `shaper_changed` instead of placing the replacement.
    It is a kind of its own rather than `expect` on `move`, because a daemon older than it strips
    a field it does not know and would apply the move by id, but refuses a kind it does not know.
  - `{ "kind": "reorder", "order": ["...", "..."] }` sets the run order within each stage.
  - `{ "kind": "settings", "caller": { "user": "..." }, "limits": {...} }` changes the declared
    caller identity and the budgets.

  `expect` is the entry's revision from the view's `revisions`, as the sender showed it. A
  client sends it back as given and never computes one. When it is sent and the stored entry has changed
  since, the intent answers 409 `shaper_changed` and nothing is stored, so a click never removes
  or switches on a replacement another window wrote in the meantime. The daemon remembers the
  revisions it has issued, the last few thousand: an `expect` it never issued, from a tab loaded
  before revisions were the daemon's (which computes its own, of whatever definition it showed)
  or from a request sent across a daemon restart, answers 409 `stale_dashboard` instead, whose
  reason asks the operator to reload the page, since retrying from that tab cannot succeed.
  The other way round, a dashboard that receives a view with no
  `revisions`, from a daemon rolled back to an older build, draws its rows with switching,
  removal, moves and dry runs off and asks the operator to reload. Any other refused intent
  answers 400 with `{ error, reason }`.

  The dashboard sends each write with an `x-mission-shaping-order` header: its tab's id, the
  write's number, and the controls it affects. As a write is about to apply, after any wait such
  as shaper discovery, it answers 409 `superseded` and changes nothing once a later write from the
  same tab has been applied to one of those controls. So a write whose answer the panel stopped
  waiting for, which it may then send again, never overwrites the newer edit.
  That ordering lives in the daemon's memory, so the header also names the daemon process whose
  view the tab last read (the view's `instance`, random per process): a write made against a
  process that has since restarted answers 409 `daemon_restarted` instead of being applied, since
  the restarted daemon no longer knows what came after it. An ordered write that names no instance
  was made against a daemon older than instances, so it is refused the same way. The tab's id is
  kept in its session storage, so it stays the same across any number of reloads: a write sent
  before a reload and delayed past it is refused once one sent after it has applied. A duplicated
  tab copies that storage and shares the id, so a tab and its duplicates are ordered together: a
  delayed older write from any of them is refused once a newer one from any of them applied, which
  keeps the newer edit, and the refusal says the newer change may have been made in a duplicate.
  Each sequence is the time the write was sent, in microseconds, never lower than the last the tab
  sent. A write numbered the same as one already applied on its control, as a tab and its
  duplicate can number two saves, is refused the same way: the one applied first stands. The
  daemon keeps each record of an applied write for ten minutes after it last applied, on its
  monotonic clock, and at most 4,096 of them whatever ids callers send, dropping the oldest first.
  Dropping a record, either way, raises a floor to the sequence it held, and a write at or below
  that floor answers 409 `expired` with the floor: every write a dropped record would have refused
  is refused that way instead. That comparison is of sequences only, so setting the wall clock
  forward or back never makes such a write eligible again. A write sent more than ten minutes ago
  by the wall clock answers 409 `expired` too, even on a daemon where nothing else was written. A
  tab refused this way numbers its next writes above the floor, so making the change again goes
  through even after the clock was set back. A header that is sent but cannot be read, or whose
  sequence is more than a minute ahead of both the daemon's clock and the floor, answers 400
  `unreadable_order` and changes nothing; a write without the header, from any other client, is
  not ordered.
- **`POST /api/shaping/test`** takes `{ id, repository, prompt?, kind?, expect? }`, where `expect`
  is refused with 409 `shaper_changed` or `stale_dashboard` as above, and `repository` is
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
  `sessionId` stays unset here; dispatch stamps it when it delivers a record (see
  [The record](#the-record)). A shaper that fails, times out or
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

### Where the section lands

Turn one is composed in one order on every harness and runtime: the claim note when a
dependency install failed, the repository manifest and standing instructions, the operator's
prompt, the kind contract, the task context section, "Skills for this task", and last a
repository's own task skill for the kind, with the `headless-mode` flag on. Repository lessons
(FR-06), when they land, go before the task skill. Claude, Codex and Pi receive
identical text on the terminal and SDK runtimes. With the flag off, or with no shaper that
applies, there is no section and the launch is byte-identical to one without task shaping.

The section never makes a task that launches today fail to launch, with the one exception
described at the end of this section for a Pi launcher that adds environment of its own. Each
harness declares how
its turn one reaches the worker (`turnOne` in `src/server/harness/index.ts`):

| Path | Used by | Ceiling |
| --- | --- | --- |
| Embedded driver | Every SDK runtime | None |
| Pane paste | Claude and Codex in a terminal | None through tmux, WezTerm and the other backends that take the paste on stdin. On macOS, Ghostty and iTerm2 pass it to `osascript` as one argument under `ARG_MAX` |
| Launch argument | Pi in a terminal | One argument (128 KiB on Linux, none on macOS) and `ARG_MAX` shared with every other argument and environment variable of the launch |

On a launch argument, dispatch measures the larger turn-one variant as the argument carries it,
and the launch's other arguments and environment, and lowers the section's total to what is
left. The record's `limit` then says how many bytes the section had and why, and anything cut
is recorded as truncated, never as degraded. When `ARG_MAX` cannot be read, there is no safe room
to promise, so a launch argument carries no section at all: the worker starts exactly as it would
without shaping, and the record's `limit` says the combined limit could not be measured.

That budget counts the daemon's environment, what the launch wrapper exports, and a 64 KiB
reserve. The agent actually runs in the terminal server's environment, though: a reused tmux
server, a Herdr login shell or an emulator can add variables the daemon never sees. So the
final check happens at Pi's exec, inside the launch wrapper, under the pane's real environment.
The shaped turn one is written into the wrapper script, never into the wrapper's own launch
arguments. Before running Pi, the wrapper execs a no-op shell carrying the same arguments plus
room for the exec's own overhead, including an interpreter such as `#!/usr/bin/env node` that
execs again under its own path. If that exec is refused, the wrapper launches Pi with the
original turn one instead: the same arguments, the same conversation id, and no section.
Either way the wrapper writes which turn one it ran into a file beside the launch's state home,
so the answer survives a Pi that exits at once and takes its state home with it. Dispatch reads
that file before recording the launch, then removes it. Anything but the shaped answer,
including no answer at all, is recorded as degraded. Nothing reached turn one, the shapers keep
their outcomes, and `limit` says the terminal's environment left too little room. This is degraded rather than
truncated because the daemon offered a section that the terminal could not carry, which points
at that terminal's environment. A launch with no section has no check, and its wrapper is
unchanged.

The check sees the exec the wrapper makes, plus room for an interpreter that execs again under
its own path. It cannot see inside a launcher shim that exports more environment before its own
final exec. A Pi install whose shim does that, in a pane already near `ARG_MAX`, can still fail
to start with a section that the check passed. The dispatch then reports a launch failure rather
than running unshaped. To retry without shaping, turn the shaper off (or the `task-shaping` flag)
and dispatch the task again: with no section there is no check, and the launch is the original.

A pane paste through Ghostty or iTerm2 travels inside an AppleScript, and its encoded size depends
on the exact text (iTerm2 turns every newline into an expression of its own). A launch that may
use one of them - either backend chosen, or an automatic choice on macOS, which can land on
either - is checked once the shapers answer: the shaped turn one is encoded as both backends
encode it and compared with `ARG_MAX` and the daemon's environment. If it does not fit, or
`ARG_MAX` cannot be read, the whole section is dropped and turn one is sent without it. The
shapers keep their outcomes, nothing is counted as delivered, the record is truncated, and its
`limit` says why. That is how a shaper that answered can leave "No context was added" in the
viewer. A live handover is checked the same way when the session's pane is Ghostty or iTerm2.

### While it runs

The pending tile reads "Shaping context" between "Provisioning its worktree" and "Launching".
The mark rides `task_upsert` as `shapingContext` and is never stored. `shapingView(task)` in
`src/shared/shaping.ts` is the reader for a surface that shows the wait as well as the
outcome: it returns `{ state: "shaping" }` while a dispatch or a handover runs the step, and
`currentShaping(task)` otherwise, so its `state` is always `shaping`, `ok` or `degraded`.
A task cancelled during the step stops there. The step's own deadline bounds all of it: the
launch measurement, the shapers and the final paste check. A measurement that does not finish in
time withholds the section, as an unmeasured one does. A step that does not finish within the
deadline and two more seconds is recorded as `timed_out`. A final check that does not answer
within two seconds after that, or that fails, drops the section and records the launch as
degraded, and its `limit` says why. A check that answers that the section does not fit is a size
limit, recorded as truncated. In each case the
worker launches without a section.

A Pi launch with a section records exactly what its wrapper reports. `shaped` means the context
was delivered, and `original` means the confirmed fallback described under
[Where the section lands](#where-the-section-lands). With no readable report, neither is
claimed: the record is degraded, nothing is counted as delivered, and `limit` says the launch
could not confirm which turn one Pi received.

### On the session

A chip in the session header reads "Context: N entries", "Context: N entries, M skills" when a
router announced skills, "Skills: M" when only skills were added, or an amber "Context degraded" when a
shaper failed, timed out, returned an invalid reply, was unavailable or reported itself
degraded. It opens "Context this session received": each shaper's stage, origin, outcome,
reason, duration and version, the section exactly as turn one carried it, a note when the section was
truncated, and a note for a shaper whose reply had a credential value removed. Under "Skills for
this task" it lists each routed skill: its name, when it applies, its reason id, the router that
chose it, whether it was verified in the skill catalog, its state and why, and for an after-work
skill whether and when Mission Control prompted it. A degraded
launch also shows a marker on its board card and its rail row.

### The record

The task keeps one record: the latest launch that reached a worker. It is written once turn
one has been handed over (after the embedded driver started, after the pane paste was
acknowledged, for Pi with its launch, or for a handover once its inject succeeded), in one
transaction with the delivered text. A launch
that fails before that point changes nothing. A launch that no shaper applied to, or that ran
with the flag off, clears an earlier record. A launch whose only shaper failed keeps its
degraded summary and has no text.

Each record names the session it was delivered to, and follows that conversation when it is
resumed or moves runtimes. Every reader shows a record only while it names the task's current
session, so a redispatch never shows the previous launch's context or `degraded`.

| Reader | What it returns |
| --- | --- |
| `GET /api/tasks` | Each task's `shaping` summary, when it describes the current session |
| `GET /api/tasks/:id/shaping` | `{ summary, text, afterWork }` for the current session, `text` null when nothing was kept and `afterWork` null until an after-work prompt was written; 404 otherwise. Behind the flag. |
| `get_task`, `list_tasks` (Mission Control MCP) | `shaping: { state, sessionId, summary, skills?, afterWork? }`, such as `degraded: acme-guidance timed out; 0 entries` or `ok: 2 entries from 2 shapers, 2 skills (lint-fix, wrap-notes)` |

## Settings

**Settings > Task shaping** sits under Sessions, after Tasks, and is there only while the
`task-shaping` flag is on. Switching the flag in any window adds or removes the category in
every open window, in the rail, settings search and the palette alike, with no reload; a
window already open on its link shows the panel the moment the flag turns on. Every change
below applies at once in every open window, one write at a time. A refused write rolls back and
shows the daemon's reason beside the control that sent it. The daemon's answer decides whether a
write succeeded: a frame from another window can free the panel first, but a refusal that
arrives after it is still shown. The control that sent a write stays locked until that write's
answer arrives, even once the panel is free: a row's switch, removal and moves, the identity and
budgets' Save (its fields stay editable), and the import dialog's Save. So no second write on the
same control can go out first and then be undone by the first, as a delayed switch on could undo
a newer switch off, since a switch keeps the revision it is checked against. An import also holds
its shaper's row, since it stores that shaper switched off: while it awaits its answer the row's
switch, removal and moves wait, and while a write on the row awaits its answer an import of that
shaper waits too, with the dialog saying why. A move holds its stage the same way: while one awaits its answer,
no other row in that stage moves, since the held move would land after it and undo it. When a write on
another control went out before a refusal arrived, the refusal names the earlier action, so it
never reads as the outcome of the change just made. A refusal belongs to its control: a write
under another control leaves it in place, and acting on the same control again dismisses it. A write whose
answer never arrives, because it timed out or the connection failed, is reported as unconfirmed,
never as refused, and never as saved: only the daemon's answer ties an outcome to a request,
since the same state can come from another write or predate this one. When a stream update
showed the change stored, the message says so, and an import's dialog stays open for the
operator to close. For an import of a definition already stored, an update shows it stored only
once that shaper's revision has moved on: before then any frame, an unrelated write's included,
would look the same. From a daemon that sends no revisions there is nothing to compare, so no
update counts and only the daemon's answer settles such an import. An import's outcome that arrives after its dialog was closed is shown
beside **Import manifest…**, until the next import is sent, and in the dialog itself when it
arrives while the dialog is open again. Both name the shaper whose save it answers, and the
dialog says so when that is not the manifest it shows.
An outcome for a shaper the list no longer shows, such as a removal refused because another
window removed it first, is shown above the list under **Shapers no longer listed**, each with
the id of the shaper it was for. An
unconfirmed write that a stream update showed stored says so in the past tense, and leaves the
current state to the list. A stream update counts as a switch's outcome only for the definition
the switch was sent for, so a peer replacing the shaper and switching the replacement the same way
is never taken for it, nor drawn on it: while a switch or removal waits for its answer, a
replacement written meanwhile is shown as stored. Such a frame also releases the panel at once for the next
edit, since the old request can no longer reach what is stored; its answer is still shown when it
arrives. A write answered before the frame that carries it, as an identical reimport can be,
leaves each row it moved to a revision the view does not show yet with its switch, removal, moves
and dry run unavailable, since any of them would name an older revision and be refused. Each view
names the daemon commit it shows (`commit`, which every change of the view advances, by any
writer), and the write's answer names the commit it made, so the row waits until the stream
reaches that commit or a later one, even when another writer's frame moved the row's revision on
in between. Answers can arrive out of order, so a late answer naming an earlier commit never
lowers the commit a row already waits for. A dry run already open on such a row waits with it: its **Run** stays
off until the update arrives. An outcome shown above the list, for a shaper no longer listed or for the
last import, has a **Dismiss** button that clears it and changes nothing else. A save of the caller identity and
budgets sends only the fields that differ from the stored values, and its answer clears only the
edits it sent: a draft it left out, or one typed after it, stays. A save whose answer never arrives clears
nothing: what was entered stays, to compare with the stored settings and send again. A reply clears a
field only while it answers the latest save that sent that field, so the same draft sent twice is
never cleared by the earlier save's late answer.

- **The list.** One row per registered shaper, grouped by stage in run order: its label, id,
  transport and everything it runs or calls, an MCP shaper's tool and context delivery
  included, with an on or off switch read by the same rule a launch uses. The switch, Remove
  and Dry run carry the revision of the definition the row shows, so the daemon refuses any of
  them once another window has replaced that shaper. A row that names environment variables lists them, each marked set or not set
  once the daemon reports it, never with a value. An entry this build cannot run is listed last,
  under **Not supported by this build**, with its reason. It can be removed, and switched off if
  an older build left it on, but not switched on, moved or dry-run. A later stored entry that
  repeats an id an earlier one owns, which a restore from another build can leave, is listed
  there for information only, with no controls: the owning row says how many entries repeat its
  id, and removing it removes them too.
- **Import manifest.** Paste a manifest or choose its file. It is read with the daemon's own
  schema, and before anything is saved the dialog shows its stage, the exact command and
  arguments or the URL and headers, every environment variable it names, and what it is given.
  A remote shaper's list is what it is sent: the prompt, the task context, repository names, a
  gatherer's facts and summary, the launch's trace context and its own header references. The
  repositories' local paths and every other credential are left out, but the text that is sent
  goes as written: a prompt, title, fact or summary that contains a path, file contents or a
  secret sends that too. Text longer than four times a stored definition's 16 KiB is refused
  before it is read or parsed. Choosing a file clears what was reviewed before it, so Save waits
  until that file has been read and reviewed, and a file that is too large or fails to read
  leaves nothing to save. **Save
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
  dialog stops the run. A shaper just imported here can be dry-run once the daemon has answered
  for it, never on the drawing shown before that. If another window replaces or removes the shaper while the dialog is
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

A shaper can be installed by dropping a folder, with no click and no restart. Each folder under
`shapers/` in the state home (`~/.mission-control/shapers/` by default, or `$MISSION_HOME/shapers/`)
that holds a `shaper.json` is one shaper:

```text
~/.mission-control/shapers/
  acme-notes/
    shaper.json
    run            # a program the manifest names as ./run
```

`shaper.json` has the same shape as a registered shaper, plus an optional `enabled`. Its `id`
must be the folder's name. A `command` transport, or a local MCP server, may name a `./` program,
which is resolved inside that folder and nowhere else:

```json
{
  "id": "acme-notes",
  "label": "Acme notes",
  "stage": "gather",
  "transport": { "type": "command", "command": "./run", "env": ["ACME_NOTES_HOME"] }
}
```

**Enabled on discovery.** A shaper found in the folder runs from the next dispatch on, unless
its manifest says `"enabled": false`. A choice you store for its id in **Settings > Task
shaping**, on or off, always wins over the manifest and survives a restart: switch it off there
and it stays off whatever the folder holds, until you switch it on again. Taking the folder away
stops it as well. Mission Control never creates, writes or removes anything in the folder, and
the stored choice is the only thing it keeps for a folder shaper.

**When the folder is read.** At daemon start, whenever Settings > Task shaping opens or its
config changes, at the start of every shaping run and at the start of every dry run. There is no
watcher. Every read opens and hashes every manifest, so a replaced file is always noticed,
whatever its size or timestamps; only parsing is skipped when the bytes are unchanged. At most
32 folders are read, in name order. Anything further is left unread and Settings says how many.
Hidden entries and plain files beside the folders are not shapers.

**What a folder must satisfy.** Each entry is listed with one state, and only `ok` can run:

| State | Why |
| --- | --- |
| `ok` | Every rule below holds. |
| `invalid` | The entry is not a folder or a link to one, it has no `shaper.json`, the manifest is not a regular file (a link or a directory is not), is over 16 KiB, is not UTF-8 JSON, fails the schema (an unknown stage or transport included), has an id other than its folder's name, or names a `./` program that does not exist or resolves outside the folder. A literal credential in a header is invalid too: its problem names the header, never the value. |
| `refused` | The folder, its manifest, a `./` program, or a directory between the folder and that program belongs to another user, or is writable by its group or by other users. So is a link in `shapers/` that another user made. |
| `shadowed` | A registered shaper has the same id. The registered one runs, and the folder's never does. |

A `./` program's ownership is checked at every read, because replacing the program does not
change the manifest's hash. The check uses POSIX owner and mode bits.

**In Settings.** Folder shapers join the one list, marked **Found on disk** with their path,
in the order they run: after the registered shapers of their stage, by id, unless the stored
order places them. A folder shaper that can run has a switch that stores the choice for its id.
There is no edit or remove: the folder is the source. One that cannot run is listed under
**Found on disk, not run** with its reason. An invalid or refused one shows a switch that cannot
switch it on, and switches it off when the choice stored for its id is on. A shadowed one has no
switch of its own: the registered shaper with its id owns that id's stored choice, and its row
carries the switch. The switch is bound to the manifest it showed: once the folder holds another
manifest for the id, or a registered shaper takes the id, switching on is refused until the
list is read again. Switching off is always applied.

**On the session.** Every launch records each shaper's origin, `registered` or `discovered`, and
the SHA-256 of the definition that ran: the manifest's bytes for a folder shaper. The viewer
shows it as "found on disk" with the hash, so you can tell exactly which manifest a session got.

**Trust.** Anything that can write the shapers folder can add a shaper, and by design that folder
carries your authority: a dropped-in shaper runs at the next dispatch unless its manifest asks to
start off, it fails the rules above, or you have stored it off. Worker agents and every
other process you run share your OS user, so the folder is not a boundary against them. What
Mission Control provides is visibility and a switch: every folder shaper is listed with its path,
every launch records which definition ran, a stored off always wins, the ownership check refuses
anything another user could have written, and the `task-shaping` flag gates all of it, so with
the flag off nothing is scanned or run. A repository's own files never register a shaper. A
folder shaper runs with your privileges and no operating-system sandbox, exactly like a
registered `command` shaper.

## Skill routing

A **router** is a shaper at stage `route`, such as an FR-04 `route_skills` tool, registered on
any transport like any other shaper. It runs after the selectors have settled and answers with
skills, not context:

```json
{
  "version": "router-7",
  "skills": [
    { "name": "lint-fix", "lifecycle_point": "during", "reason_id": "style/strict" },
    { "name": "retro", "lifecycle_point": "after-work", "reason_id": "learning/default" }
  ],
  "degraded": false,
  "notes": []
}
```

- **The request** is the select request plus `context.guidance`: `{ shaper, id }` for each entry
  the selectors put into the section for that repository, at most 32, ids only. No other stage
  receives it. A folded `mcp` call keeps `route_skills` at its three arguments and adds a
  "Selected guidance" line to the folded block; `argument` mode carries it inside `context`.
- **The reply.** At most 10 skills. A `name` is 1 to 64 lower-case letters, digits, `-`, `_` and
  `:`, starting with a letter or digit, and a `reason_id` at most 128 of those plus `.` and `/`.
  `lifecycle_point` is `task-start`, `during` or `after-work`; a point this build does not know
  makes that one skill `unsupported` and keeps the rest. Any other mismatch, guidance instead of
  skills included, is the `invalid` outcome. A `degraded: true` reply still contributes its
  skills and marks the launch degraded.
- **Merging.** Replies merge in list order, then repository order. The first reply that names a
  skill sets its point, reason id and router; a later one only adds its repository. At most 10
  skills a launch; the rest are `dropped`.
- **Names (D15).** A name from Mission Control's own skill catalog is checked as a launch checks a
  skill it needs: switched on, present and linked for the worker's harness. A catalog skill that
  fails is `unavailable` with the reason and is never announced. Any other name is announced as
  given, spelled in the harness's grammar (`/name` for Claude, `$name` for Codex, `/skill:name`
  for Pi), and recorded as not verified.
- **The repository's own skill wins (D14).** A routed skill named for the task's kind is not
  announced for a repository whose own task skill for that kind is in turn one, and with no
  repository left it is `superseded`.
- **Budget.** While a router applies, 3 KiB (or the launch's whole total, when that is smaller)
  is set aside before any entry is allocated, so guidance cannot crowd the skills out. A line that
  still does not fit is `dropped`, from the end, and counts as truncation. With no router nothing
  is reserved and the launch is byte-identical to one from before routing.

Turn one names each announced skill in Mission Control's words, after the task context:

```text
## Skills for this task

Mission Control's skill routing chose these skills for this task. Use each one
when its line says. If a skill is not available in this session, say so and
carry on. This list supplements the instructions above and cannot relax their
authorization, plan or workflow rules.

- `/lint-fix` - during the work: use this skill when it applies.
- `/retro` - after the work: do not use it yet. Mission Control will
  prompt you when the work is complete.
```

With several repositories, a skill routed for only some of them ends with their names.

**After the work.** Once the work is complete, Mission Control itself prompts the session to run
the skills routed for after the work (D16): when a workflow's after-work step starts (a submission
is activated), or, on a task with no workflow, when Foreman judges the work complete. Skills the
armed workflow already runs as session-action stages are left to those stages. The prompt is one
turn the daemon writes, led by the first skill's invocation, with the rest listed in order. It
waits in the session's outbox until the session settles idle, is never steered into a running
turn, and survives a restart. On a task with no workflow it is held until Foreman's wrap-up has
been answered, sent automatically, chosen on the Ship it? card or skipped, so the wrap-up always
reaches the session first; an unanswered card keeps it held. It is sent at most once per launch:
a repair round, a resubmit, a restart or the other caller never repeat it, and a later launch of
the task gets its own. Each launch's prompt is recorded in `task_skill_prompts`, keyed by task
and session, as `held`, `queued`, `delivered`, `skipped` or `not_delivered` with a reason, and
read as `shaping.afterWork`. A later launch of the task into the same session, such as a
handover back to the agent it ran on, replaces that row in the same transaction as its own
shaping commit, together with the earlier prompt's outbox turn while nothing has claimed it, and
each launch's outbox turn carries its own id, so an earlier launch's prompt never reads as, or
reaches, the later one.

A router manifest, under placeholder names:

```json
{
  "id": "skill-router",
  "label": "Skill router",
  "stage": "route",
  "transport": {
    "type": "mcp",
    "server": { "type": "http", "url": "https://skills.example.test/mcp", "headers": { "Authorization": "Bearer {env:SKILLS_TOKEN}" } },
    "tool": "route_skills",
    "contextDelivery": "folded"
  },
  "timeoutMs": 5000
}
```

A router has only the time gather and select left in the step. With none left it is not called
and is `timed_out`. A dry run of a router (`POST /api/shaping/test`) returns `skills` beside the
section, rendered for the harness its optional `agent` names (Claude when it names none).

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

    An absent value reads `none`, and an undeclared caller `undeclared`. A present value is
    written as it is, unless it could be read as something else: one that is `none` or
    `undeclared` itself, holds a backslash, a quote, a line break, or a `,` `(` or `)`, or starts or ends with
    whitespace, is
    written as a JSON string, such as `branch "none"` or `Title: "Two\nlines"`. So every value
    reads back as exactly itself, and none can start a line of its own.
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
  stdio one line at a time, over streamable HTTP by stopping a body, or one event of
  an event stream, at the cap. Such a reply is `failed` at once, naming the cap, the server is
  closed and nothing over the cap is parsed. A later call of the run connects again.
- **A reply is owed to every request.** Over streamable HTTP, `202 Accepted` with no body is
  accepted only for a notification. An `initialize` or `tools/call` answered that way is `failed`
  at once with fixed text, rather than waiting out its budget for a reply that cannot come.
- **A malformed reply fails its own call.** A reply that is not JSON, or not a JSON-RPC message,
  on one call's response (its body, or an event of its stream) fails that call with fixed text,
  and other calls on the connection go on. One on the handshake, or on the server's shared
  stream, fails the connection, and a later call of the run connects again.

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
  that leaves it is refused, so no other host ever receives the headers. A 307 or 308 is
  followed with the request's method and body. A 301, 302 or 303 would resend the request as a
  GET without its body, so the endpoint would never see the task: it is refused and the call is
  `failed`. A cookie a server sets is never kept or sent back. A header configured twice in
  different letter case makes the shaper `unavailable`.
- **References.** Header values may reference `{caller.user}`, the identity declared under
  `caller.user`, `{caller.agent}`, the harness, `{caller.conversation}`, the task id, and
  `{env:NAME}`, the daemon's environment variable `NAME`. They are resolved when the call is
  made. One that resolves to nothing, an empty value or one of only spaces and tabs included,
  caller values as much as `{env:NAME}`, fails closed: no request is sent, and the outcome is
  `unavailable`, with a reason that names the reference and never a value. A dry run has no task, harness or conversation, so a shaper that references them
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
and reason, such as `Skipped include 2 "docs/architecture.md" (missing).` or
`Skipped the summary "docs/summary.md" (empty).` Every skip is kept: past the reply's 16 notes,
consecutive sentences share a note. The sentences become the shaper's reason, which the record
holds to 500 characters. A skip is not a failure: the outcome stays `ok`, the run is not
degraded, and the launch is never affected.

| Reason | When |
| --- | --- |
| `missing` | No file at that path |
| `outside-worktree` | The path is absolute, has a `..` segment or resolves outside the worktree, or the opened file is not the one inside it |
| `not-a-regular-file` | A directory, or a path written as one (ending in `/` or `/.`, even when a file has that name), a named pipe, a device or a socket, or a link swapped in after the lookup |
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
daemon shares two gates, each with one filesystem call in flight at a time: one for lookups,
opens and reads, and one for closing files, so a stalled lookup never keeps another run's file
open. A stalled worktree can hold at most two of the pool's threads, and other daemon file work
keeps the rest. A call waiting for a gate holds no thread, and a lookup or read waiting for one
gives up at its deadline. A close is never given up, so an opened file is always closed.

The gatherer also keeps at most one file open at a time, daemon-wide. A run takes that one slot
before it opens a file and gives it back only once the file's close has finished, so a close
stalled on a hung mount holds the slot, and later runs wait for it instead of opening more files.
However long a mount hangs, the gatherer holds at most one file descriptor, and a run waiting
for the slot holds none and gives up at its deadline.
