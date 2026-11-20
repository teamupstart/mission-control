# Task shaping

Task shaping asks operator-configured programs for context about a task. Each program is a
**shaper**: a **gatherer** at stage `gather` reads the task's repositories, and a **selector**
at stage `select` chooses guidance for the task. How Mission Control reaches a shaper is its
**transport**. Mission Control ships the mechanism and no shaper of its own content.

**What this build does.** You register a `command` shaper through the API and dry-run it
against a repository. Mission Control calls it at the gather and select stages, validates and
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
   summary comes from the last gatherer that returned one, cut at a line boundary to 4 KiB.
3. **Select.** Once gather has settled, each enabled selector is called once per repository, in
   parallel, with that repository's merged facts and summary.
4. Every reply is validated against one result shape. Anything else becomes an outcome with a
   reason, never an error: Mission Control carries on.
5. Entries are de-duplicated, fitted into the context budget, and composed into one section.

A selector's `kinds` and `repositories` filters narrow where it runs. Empty means every kind
and every repository.

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
    "repositories": [{ "name": "billing-api", "role": "primary", "branch": "task/retry", "baseSha": "abc123", "path": "/abs/path/to/worktree" }],
    "caller": { "user": "declared-user", "agent": "claude", "conversation": "t_123" }
  },
  "limits": { "maxBytes": 16384, "deadlineMs": 5000 }
}
```

- `task` is the prompt and nothing else. Everything else Mission Control collected is in
  `context`, and every shaper receives all of it.
- `repo.facts` and `repo.summary` are absent in a gather request. Producing them is a
  gatherer's job.
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

- A call's timeout is the smaller of its own and the time left in the step. Its signal is
  aborted at exactly that timeout, and any reply that arrives later, success or failure, is
  `timed_out` and contributes nothing, however much step time is left. At the step's deadline,
  calls still running are abandoned and recorded as `timed_out`. Entries that already arrived
  are kept.
- One entry is at most 16 KiB, its heading included. The budget is filled in stage order, then
  list order, then the order a shaper returned its entries. An entry that does not fit is cut at the last line
  boundary that does and marked `[truncated: N bytes omitted]`. An entry with less than 1 KiB
  left is dropped. Both are recorded.
- The same entry id from the same shaper is injected once, and so is an identical body from two
  shapers.

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
  path, or, for a shaper in the shapers folder, a `./` path inside its own folder. `args` are
  passed exactly as written, and stored and backed up the same way. An argument that hands
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
  [Security](security.md#task-shaping) states the exact rule.
- **Output.** At most 256 KiB on stdout. stderr is kept only as the reason for a failure. Every
  value from the child's environment is replaced by `[redacted]` in that reason, and in any
  reason drawn from your reply, such as an `error` or degraded `notes`.
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

- **`GET /api/shaping`** returns `{ config, discovered, references }`. `config` is the stored
  `app_config.shaping` value: `caller`, `limits`, `shapers`, `overrides` and `order`.
  `discovered` and `references` are empty until the folder and the remote transports land.
- **`PUT /api/shaping`** takes one intent and returns `{ config }`:
  - `{ "kind": "upsert", "shaper": {...} }` creates or replaces a registered shaper. A new one
    is stored off.
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
  `{ summary, section, entries }`: each shaper's outcome, reason, duration and version, the
  section that would be injected, and each entry in it. A shaper that fails, times out or
  answers garbage is an outcome in a 200, never an error reply.

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

Arrives with the `mcp` and `http` transports. Their config shapes are already accepted: an `mcp`
shaper names its `server`, its `tool` and a `contextDelivery` of `folded` or `argument`, and an
`http` shaper names its `url` and `headers`. Header values may reference `{caller.user}`,
`{caller.agent}`, `{caller.conversation}` and `{env:NAME}`. A credential is always a
reference: a header such as `authorization` or `x-api-key` that is not empty holds an
`{env:NAME}` reference and nothing literal. `Authorization` and `Proxy-Authorization` may put
`Bearer`, `Basic`, `Token` or `Digest` before it (`Bearer {env:ACME_TOKEN}`). Any other
leading word is refused as part of the secret. A URL carries no user name,
password or credential-shaped query parameter. A definition with literal secret text is
refused, so it is never stored or backed up. Until that phase lands, such a shaper's outcome
is `unavailable`.

## The built-in gatherer

Arrives with `repository-files`. Its options, `include`, `summary` and `facts`, are already
accepted, and until that phase lands its outcome is `unavailable`.
