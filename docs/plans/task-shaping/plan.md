# Task shaping: pluggable shapers

## Goal

Before a worker starts, Mission Control asks operator-configured programs for context about
the task and adds what they return to the worker's first prompt. Mission Control ships the
mechanism and no company content. A guidance server, a repository fact reader or a local
script each arrive as one configured entry, called a **shaper**.

The mechanism is designed the way the feature-flag registry was: one browser-safe data
registry, one schema-validated `app_config` key, pure shared logic, a small daemon module, an
intent-based write route, one event, a Settings panel and a documented lifecycle. It ships
with no shaper configured, and an installation with none behaves exactly as it does today.

The operator's prompt is never rewritten. Shaping only adds a section after it.

## Constraints already decided

These came from the on-site decisions recorded in the Common Room spec "MC context plugin
interface" and were not reopened.

| # | Constraint |
| --- | --- |
| C1 | Mission Control is open source. No company-specific repositories, MCP servers or content in its code. Company behaviour arrives as shapers. |
| C2 | Shaping runs after Mission Control has collected all task input (prompt, kind, repositories, harness, after-work step) and before dispatch. The order is: gather context, select guidance, route skills, `composeTurnOne`, dispatch. Shapers receive the complete collected input, not only the prompt. |
| C3 | A visible "Shaping context" step of a few seconds at dispatch is fine. When a shaper is degraded, fails or times out, Mission Control dispatches anyway and shows `degraded`. It never blocks and never asks first. |
| C4 | Everything sits behind one flag in the feature-flag registry and follows its three-pull-request lifecycle. |
| C5 | Dashboard, `mctl` and headless dispatch are served by the same path, because they share `composeTurnOne`. |

## Decisions adopted

The operator submitted these on the first review of this plan, on 2026-11-19. D4a was a
follow-up question that D4's answer raised.

| # | Decision | Choice |
| --- | --- | --- |
| D1 | Names | The Shaper scheme: shaper, gatherer, selector, router, transport |
| D2 | Transports in v1 | `command`, `mcp`, `http` and `builtin`. No third-party in-process modules. |
| D3 | First slice | Both stages over the `command` transport, with `degraded` visible |
| D4 | Install and discovery | Both: shapers registered in Settings or through the API and stored in `app_config`, and a manifest folder that the daemon scans |
| D4a | A shaper found in the folder | Enabled as soon as it is discovered |
| D5 | Skill routing (FR-04 `route_skills`) | The same mechanism, as its own stage `route` with its own result |
| D6 | Caller identity and credentials | A declared identity setting plus config references |
| D7 | Where `degraded` shows | A marker wherever the task shows, a viewer of what the session received, and the task read model |
| D8 | Time budget | 5 s per call, 10 s for the whole step |
| D9 | Context budget | 16 KiB per shaper, 32 KiB in total |
| D10 | FR-06 lesson promotion adapter | Shares the transports, references and config pattern, with its own registry and contract |
| D11 | The generic call site | Built by this plan. The reference implementer only registers shapers. This replaces the call-site ownership recorded in FR-02 question 8. |
| Follow-up | After this plan | A phased implementation plan, with one scheduled task per phase |

The operator added these on 2026-11-20, after FR-04 published `route_skills`. Phase 7 builds
them, except D17, which Phases 1 and 5 own.

| # | Decision | Choice |
| --- | --- | --- |
| D12 | How a routed skill reaches a worker (FR-04 question 2) | A "Skills for this task" section in turn one, and Mission Control itself prompts the skills routed for after the work. Built now, as Phase 7. |
| D13 | Guidance ids for the router (FR-04 question 6) | Passed as `context.guidance`, on every transport |
| D14 | A routed skill and a repository task skill for one kind (FR-04 question 4) | The repository's skill wins |
| D15 | Which routed skill names are announced | A skill from Mission Control's catalog, checked. Any other name as given, marked not verified. |
| D16 | When the after-work prompt is sent | When the after-work step starts, or when Foreman judges the work complete on a task with no after-work workflow, after Foreman's wrap-up. Once per launch. |
| D17 | Telling attached repositories apart | Each has a `slot`, and `context.target` names the one a call is about |
| Proof | That routing took effect | The route record, and a browser test with a fake router and a fake agent |

## Design

### Names

The feature is **task shaping**, and the dispatch step reads "Shaping context". The pluggable
unit is a **shaper**: a **gatherer** at stage `gather`, a **selector** at stage `select`,
a **router** at stage `route`. How Mission Control reaches one is its **transport**.
What it returns are context entries. The flag id is `task-shaping`.

### The model

- A **stage** is a fixed, ordered step that Mission Control defines: `gather`, then `select`,
  then `route`.
- A **shaper** is one configured entry: an id, a label, the stage it serves, the transport
  that reaches it, its limits and its scope.
- A **transport** is how Mission Control reaches a shaper: `command`, `mcp`, `http` or `builtin`.

```mermaid
flowchart LR
  A[Task input collected: prompt, kind, repositories, harness, after-work step] --> B[Worktrees provisioned]
  B --> C[Standing instructions and plan inputs]
  C --> S1[Gather: repository gatherers]
  S1 --> S2[Select: guidance selectors]
  S2 --> S3[Route: skill routers]
  S3 --> L[Select lessons, later: FR-06 step, not a shaper]
  L --> D[composeTurnOne]
  D --> E[Worker launched]
  S1 -. failure or timeout: continue, degraded .-> D
  S2 -. failure or timeout: continue, degraded .-> D
  S3 -. failure or timeout: continue, degraded .-> D
```

Today the flow goes from "Standing instructions and plan inputs" straight to `composeTurnOne`.
The three shaping boxes are new. A stage starts when the one before it has settled. Shapers
in one stage run in parallel, and each is called once per attached repository, also in
parallel. Nothing in the three boxes can stop the launch. The lessons box is not shaping
and is not built by this plan. It is FR-06's later step, drawn to show its one place, after
the last shaping stage. "Lesson selection at dispatch (FR-06)" describes it.

### One contract

Mission Control builds one request for every shaper and reads one result shape back from
gatherers and selectors, on every transport. A router answers in its own shape, under Skill
routing. `command` and `http` shapers are sent the request as it is, and a `builtin`
receives it in-process. The `mcp` transport maps it onto a tool's arguments, as Transports
sets out. The select stage is the FR-02 `get_guidance` contract plus fields an implementation
may ignore.

Request, one per attached repository:

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
    "repositories": [{ "slot": "repo-01", "name": "billing-api", "role": "primary", "branch": "task/retry", "baseSha": "abc123" }],
    "target": "repo-01",
    "caller": { "user": "declared-user", "agent": "claude", "conversation": "t_123" }
  },
  "limits": { "maxBytes": 16384, "deadlineMs": 5000 }
}
```

Result:

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

Rules:

- `task` is the operator's prompt and nothing else. Title, kind, harness, runtime, after-work
  step, labels, priority and the whole repository list are in `context`. Together they are
  C2's "complete collected input", and every shaper receives all of it on every transport. No
  setting withholds any of it. The `mcp` transport, whose tool may take only FR-02's three
  arguments, has its own rule for carrying it, under Transports.
- Each `context.repositories` entry has its `slot`: `repo-01` for the primary, then `repo-02`
  onward in attachment order. `context.target` is the slot of the repository this call is
  about, so a shaper can tell two attached worktrees of one repository apart on every
  transport (D17).
- Local paths go to local shapers only. `command` and `builtin` shapers receive `repo.path`
  and the paths in `context.repositories`. An `mcp` tool's `repo` argument never carries a
  path: a server started as a local process that needs one runs in `argument` mode, where
  `context.repositories` carries it. A remote shaper never gets a local path.
- `repo.facts` and `repo.summary` are absent in a gather request, because producing them is
  the gatherer's job, and present in a select request when a gatherer supplied them.
- The result key is `guidance` at the gather and select stages, so those shapers answer in
  one shape and an existing `get_guidance` tool is a valid selector unchanged. A gatherer's entries are
  repository context. Its `repo.facts` and `repo.summary` are handed to the selectors and are
  not injected by themselves.
- `version` in the request is an optional content pin from the shaper's config. `version` in
  the result is recorded with the launch.
- The result is validated with one Zod schema. Unknown fields are ignored, and a shaper must
  ignore request fields it does not know. That is the compatibility rule for `protocol: 1`.
- Anything other than a valid result (a non-zero exit, an HTTP error, an MCP tool error, a
  timeout, output that is not JSON or does not match the schema) is an outcome with a reason,
  never an exception. Dispatch continues.
- All text a shaper returns is untrusted data. It is delimited and labelled in the prompt,
  capped and recorded.

Mapping to FR-02 `get_guidance(task, repo{name, facts?, summary?}, version?) -> {version,
guidance[], truncated, degraded}`: the names and shapes are identical. Mission Control adds
`protocol`, `stage`, `context` and `limits` to the request, and reads `title`, `repo` and
`notes` from the result when present. FR-02's caps match the defaults here: 16 KiB per body,
a 4 KiB summary, 10 results. How many arguments an `mcp` selector is called with depends on
its `contextDelivery` mode: exactly FR-02's three in `folded` mode, with the rest of the input
inside `task`, and four in `argument` mode, the fourth being `context`.

### Stages

**Gather.** A gatherer is called once per attached repository, the primary first and then the
others in manifest order. A `command` gatherer runs with the worktree as its working directory.
It returns context entries, facts and a summary, any of which may be absent. When several
gatherers return facts for one repository, facts merge by name and the later shaper in the
list wins. The summary comes from the last gatherer that returns one. Mission Control cuts a
summary at a line boundary to stay within 4 KiB, because FR-02 rejects a longer one.

**Select.** A selector is called once per attached repository with that repository's merged
facts and summary. Entries are de-duplicated per repository: the same entry `id` from the
same shaper for the same repository is injected once, and so is an identical body from two
shapers for that repository. The same path read from two worktrees stays two entries.

**Route.** A router is called once per attached repository, after the selectors have settled,
and returns skills instead of entries. See Skill routing.

### Transports

| Transport | What it is | Runs | Strengths | Costs |
| --- | --- | --- | --- | --- |
| `command` | An executable and its arguments. Request JSON on stdin, result JSON on stdout. | Locally, one short-lived process per call | Any language. Wraps anything. The simplest to write and test. Works offline. | Process start time. Runs with the operator's privileges. |
| `mcp` | One tool call on an MCP server, started as a local process or reached over streamable HTTP | Local or remote | The reference `get_guidance` tool is exactly this, so a company with an MCP server writes no adapter. | The largest transport to build. A handshake per shaping run. |
| `http` | `POST` the request, read the result | Remote, or a local service | Fits a service with no MCP layer | Network egress, so it needs the egress guards |
| `builtin` | An implementation that ships inside Mission Control | In the daemon | No install. For generic, configurable defaults. | Only for code that belongs in this repository |

How they share one contract: a transport only moves bytes. It takes the validated request
and returns raw data. The engine owns everything else in one place: which shapers apply,
deadlines, validation against the stage's result schema, caps, de-duplication, the `degraded`
mapping and the record. A new transport cannot change those semantics.

- **`command`.** Config is `{ command, args, env }`. `command` is an absolute path, a name
  resolved once through `ExecutableLocator`, or for a discovered shaper a `./` path inside
  its own folder. There is no shell. `env` names the environment variables to pass through.
  The child otherwise gets the scrubbed child environment. A gatherer runs in the repository
  worktree and a selector in an empty directory. Output is capped at 256 KiB, and a timeout
  kills the process group.
- **`mcp`.** Config is `{ server, tool, contextDelivery }`. `server` is
  `{ type: "stdio", command, args, env }` or `{ type: "http", url, headers }`. The
  arguments the tool is called with depend on `contextDelivery`. Either way the transport
  delivers the complete collected input, and there is no mode that omits it. Every message
  from the server is capped at 256 KiB while it is received, as an `http` body is, so an
  oversized reply is `failed` before it is parsed.
  - `folded` (default). The tool is called with exactly three arguments,
    `{ task, repo: { name, facts?, summary? }, version? }`. That is the FR-02 `get_guidance`
    input, so an existing tool is called unchanged. `task` is the operator's prompt followed
    by one fixed, labelled block that states every field of the request's `context` except
    local paths: the task id, title, kind, harness and runtime, the after-work step with its
    workflow id, labels, priority, the caller, the slot of the repository the call is about, and
    each attached repository with its slot, role, branch and base commit. One pure function
    renders it from the `context` object, and a
    test that walks the context schema fails when a field has no line in the block. This is
    the folding FR-02 section 5a proposes, applied to the whole input instead of three fields.
  - `argument`. The tool is called with four arguments,
    `{ task, repo: { name, facts?, summary? }, version?, context }`. `task` is the prompt
    alone, and `context` is the request's whole `context` object. This is not the FR-02 call.
    It is for a server whose tool declares a `context` argument.

  In both, `repo` is the repository the call is about, with the facts and summary a gatherer
  produced. A local server is started once per shaping run and closed when the run ends.
- **`http`.** Config is `{ url, headers }`. HTTPS only, except to loopback. Redirects are not
  followed off the origin. The response body is capped at 256 KiB.
- **`builtin`.** Config is `{ builtin, options }`. v1 ships one, `repository-files`.
- **Trace context.** When the launch a shaping run belongs to has a W3C trace context, every
  shaper call carries it, so a shaper's own spans join that session's trace. It is the
  context Mission Control already gives the session's agent, from `sessionTraceContext` in
  `src/server/telemetry/session-trace.ts`. With none, nothing is added. `http` and
  streamable-HTTP `mcp` calls carry the `traceparent` header, and `tracestate` when the
  context has one. A `command` shaper, and an `mcp` server started as a local process, get
  `TRACEPARENT` and `TRACESTATE` in their environment, the variables agents already get, and
  never a value inherited from the daemon. Every `mcp` `tools/call` also carries the two
  values in `params._meta`. A `builtin` runs in the daemon and needs no carrier. A
  configured header or variable named `traceparent` or `tracestate`, compared without case,
  is always removed first, with or without a launch context, so only the launch's own
  values are ever sent. A trace value is not a
  credential and not a reference, so it is never redacted. Nothing about it is configured
  per shaper or per company.

The block that `folded` appends to the prompt, for a task with two repositories:

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

### Registry, config and wire

The feature-flag pattern, applied to shapers.

| Feature flags | Task shaping |
| --- | --- |
| `feature-flag-registry.ts`: data only | `src/shared/shaping-registry.ts`: data only. `SHAPING_STAGES` (ordered), `SHAPING_TRANSPORTS`, `SHAPING_BUILTINS` and their retired-id tuples. Append-only. |
| `feature-flags.ts`: schemas, derived id type, pure functions | `src/shared/shaping.ts`: request, result, shaper and config schemas, derived id types, and pure `resolveShapers`, `applyShapingIntent`, `allocateBudget`, `composeShapingSection`, `summariseShaping` |
| `app_config.featureFlags`, bounded, no migration | `app_config.shaping`: `{ caller, limits, shapers[], overrides, order }`, at most 32 shapers, with its own settings backup domain |
| `featureEnabled`, `requireFeature`, `onFeatureFlagsChanged` | `src/server/shaping/`: `shapeTask` (the only caller of transports), `getShapingConfig`, `applyShapingIntent`, `onShapingConfigChanged` |
| `GET` and `PUT /api/feature-flags` with an intent union | `GET` and `PUT /api/shaping` with an intent union: `upsert`, `remove`, `enable`, `reorder`, `settings` |
| `feature_flags` event and snapshot field | `shaping_config` event and snapshot field, both sent only while the flag is on. Per-task results travel on `task_upsert`. |
| Unknown ids ignored on read, preserved on write | A stored shaper whose stage or transport this build does not know is kept on every write, never resolved or called, and listed as unsupported. The parsing rule is under "Stored shapers this build does not understand". |
| A stored choice wins over the default | A stored on or off for a shaper id wins over its manifest, for registered and discovered shapers alike |
| Daemon and dashboard share one resolver | `resolveShapers(config, discovered, taskInput)` decides which shapers apply |

A shaper, as stored and as written in a manifest:

```json
{
  "id": "acme-guidance",
  "label": "Acme guidance",
  "stage": "select",
  "protocol": 1,
  "transport": {
    "type": "mcp",
    "server": {
      "type": "http",
      "url": "https://context.acme.example/mcp",
      "headers": { "x-acme-user-id": "{caller.user}", "authorization": "Bearer {env:ACME_CONTEXT_TOKEN}" }
    },
    "tool": "get_guidance"
  },
  "kinds": ["ship", "bugfix", "plan"],
  "repositories": [],
  "timeoutMs": 5000,
  "maxBytes": 16384,
  "version": null
}
```

`kinds` and `repositories` are optional filters. Empty means every kind that launches through
`composeTurnOne`, and every repository. Two more routes sit behind the flag:
`POST /api/shaping/test` runs one shaper against a repository the operator picks and returns
the outcome, the latency and what would be injected. `GET /api/tasks/:id/shaping` returns one
task's record and delivered text.

### Stored shapers this build does not understand

An installation can move between builds, so the stored list is read in two layers, the way
flag overrides are keyed by string and not by the id union.

1. **The envelope.** The config stores each entry as a `StoredShaperSchema`: `id`, `label`,
   `stage` and `transport.type` are bounded strings, and every other field is kept as it is,
   as bounded JSON of at most 16 KiB per entry. A stage or transport id this build has never
   heard of is valid in the envelope, so one such entry cannot invalidate the config or any
   other shaper.
2. **The definition.** Each envelope is then checked against the strict `ShaperSchema`, whose
   `stage` is one of `SHAPING_STAGES` and whose `transport` is the discriminated union over
   `SHAPING_TRANSPORTS`. `classifyShaper` returns a known shaper when the entry passes. When
   it does not, the entry is **unsupported**, with the reason.

- **Reading.** Only known shapers are resolved and called. An unsupported entry is listed in
  Settings as unsupported, with its reason. Outside the daemon it is only its id, its label
  and a reason that names the failing field, never a value. The API, the snapshot and the
  event never carry its raw envelope, which may hold anything an older build or a restored
  backup wrote, a literal credential included.
- **Writing.** `upsert` accepts only a definition that passes the strict schema, so a build
  creates and edits only shapers it understands, and answers 400 otherwise. Every intent
  rewrites the list from the envelopes, so every other entry, unsupported ones and their
  unknown fields included, is carried through unchanged. `remove` works on any id, and so
  does switching an entry off. Switching an unsupported entry on is refused. An `upsert`
  also stores off for its id in the same write, so writing a definition never switches it
  on, and a stored on left by a discovered shaper with that id does not carry over to the
  registered definition that now shadows it.
- **Manifests in the folder** are never written by Mission Control, so there is nothing to
  preserve. One whose stage or transport is unknown fails the strict schema and is listed as
  invalid, with that reason.

### Installing and discovering shapers

There are two ways in (D4) and one list.

**Registered.** In **Settings > Task shaping**, or with `PUT /api/shaping`. The shaper is
stored in `app_config.shaping` and is off until the operator enables it, because every
`upsert` stores off for its id. A manifest can be
imported: Settings shows exactly which command will run or which URL will be called and what
is sent to it, and stores it.

**Discovered.** A folder under the state home, `shapers/<id>/shaper.json`, with any program
it runs beside it. The manifest has the same shape as a stored shaper. A discovered shaper is
**enabled as soon as it is discovered** (D4a). Its manifest may ask to start switched off, with
`"enabled": false`. A choice the operator stores in Settings, on or off, always wins over the
manifest. That is the one precedence rule, and `resolveShapers` is the only place it lives:

| Shaper | No stored choice | Stored on | Stored off |
| --- | --- | --- | --- |
| Registered | Off | Runs | Off |
| Discovered, manifest silent or `"enabled": true` | Runs | Runs | Off |
| Discovered, manifest `"enabled": false` | Off | Runs | Off |

The table decides only whether an eligible shaper is switched on. An unsupported, invalid,
refused or shadowed entry never runs, whatever is stored for its id.

- **When the folder is read.** At daemon start, when Settings opens, and at the start of
  every shaping run. A folder dropped in by setup tooling therefore takes effect at the next
  dispatch, with no restart and no click. There is no file watcher. A scan reads at most 32
  folders and manifests of at most 16 KiB, the same cap as a stored entry. It reads and
  hashes every manifest on every scan, so a replaced file is always noticed, whatever its
  size or timestamps. Only parsing is skipped, when the hash is unchanged.
- **One list.** Settings shows both kinds in one ordered list, each marked Registered or
  Found on disk, with the path of a discovered one. The order is stored. A newly discovered
  shaper joins at the end of its stage.
- **Ids are unique across both.** A registered shaper wins a clash. The discovered one is
  listed as shadowed and is not run.
- **An invalid manifest** is listed with its problem and never run.
- **File ownership.** The folder and its manifest must belong to the daemon's user and must
  not be writable by group or others. So must a program the manifest runs from inside the
  folder, and every directory between the folder and that program. Otherwise the shaper is
  listed as refused.
- **Isolation.** An explicit `MISSION_HOME` owns its own `shapers/` folder, so tests and the
  browser suite never see the operator's.
- **Audit.** Every launch records, for each shaper, whether it was registered or discovered
  and the SHA-256 of its definition. The viewer shows exactly which definition ran.
- **The flag gates all of it.** With `task-shaping` off, nothing is scanned or run.

### Trust and sandboxing

- **Who can add a shaper.** The operator, through an authenticated settings write, and
  anything that can write the shapers folder. By decision D4a that folder carries the
  operator's authority. Worker agents run as the operator's OS user, so the folder is not a
  boundary against a worker or any other local process. What Mission Control provides is
  visibility and a switch: every discovered shaper is listed with its path, every launch
  records which definition ran, a stored off always wins, and the flag gates everything. A
  repository's own files never register a shaper.
- **What a local shaper can do.** A `command` shaper, and an `mcp` server started locally, run
  with the operator's privileges, the same trust as an operator-authored Workflow command.
  v1 adds no operating-system sandbox, and the docs say so. Mission Control controls the rest:
  argv without a shell, a scrubbed environment plus only the variables the shaper names, a
  bounded working directory, bounded output and a hard timeout.
- **What a remote shaper receives.** The prompt, the task context above, repository names,
  and the facts and summary a gatherer produced, plus the launch's trace context when it has
  one. No local paths, no other file contents, and
  no tokens other than the header references in its config. Settings states this list beside
  every remote shaper.
- **Egress.** The rule resident MCP servers already follow, through the same helpers: HTTPS
  only, except plain HTTP to a loopback address. A header that carries a credential reference
  is therefore never sent over plain HTTP to another host. It may be sent to loopback, as it
  may for a resident MCP server, because that request never leaves the machine. Redirects
  stay on the origin. No cookies.
- **What comes back.** Returned text goes into a worker's prompt, so it is treated as
  untrusted content: it sits in its own labelled section, which says it cannot relax
  authorization, plan or workflow rules, it is capped, and the operator can read exactly what
  was injected.
- **Child processes.** The `command` transport is one new operator-command entry in the
  boundary registry of `test/executable-contracts.test.ts`.

### Time budget

- Each call has a timeout: the shaper's `timeoutMs` (default 5 s, at most 30 s) or the time
  left in the step, whichever is smaller.
- The whole step has a deadline, `limits.deadlineMs` (default 10 s, at most 60 s). Each
  stage runs its calls in parallel and the stages share the deadline, so the worst case is
  the deadline. A later stage has the time the earlier ones left.
- When the deadline passes, calls still running are abandoned and recorded as `timed_out`.
  Entries from shapers that already answered are kept.
- A task cancelled during shaping stops there. The existing settled check runs after the step.
- Results are not cached in v1. Every dispatch, including a retry, shapes again.

### Context budget and truncation

- One entry is at most 16 KiB. One shaper contributes at most its `maxBytes` (default 16 KiB).
  The whole section is at most `limits.totalBytes` (default 32 KiB, at most 64 KiB). On a
  delivery path with a byte ceiling, such as a launch argument, it is also at most what the
  rest of turn one leaves under that ceiling, and for a launch argument also at most what the
  launch's other arguments and its environment leave under the platform's combined limit,
  so shaping never makes a task that launches today fail to launch. What does not fit is cut and recorded, as below.
- The budget is filled in one order: stage order, then the list order, then the order the
  shaper returned. An entry that does not fit is cut at the last line boundary that does,
  followed by `[truncated: N bytes omitted]`. An entry with less than 1 KiB left is dropped.
  Both are recorded.
- Truncation is not degradation. A truncated launch shows a neutral "truncated" note.
  `degraded` is reserved for a shaper that failed or said it was degraded.
- There is one budget and one allocator. `limits.totalBytes` bounds everything this pipeline
  adds to turn one, and `allocateBudget`, one pure function, fills it in pipeline order:
  gather, select, then the routed skills, and last the repository lessons that FR-06 selects
  in its own step after shaping. While a router applies, 3 KiB is set aside for the skills
  before entries are allocated, so guidance cannot crowd them out. "Lesson selection at dispatch (FR-06)"
  states that step's place and its share.

### Caller identity and credentials

Mission Control does not hold secrets for shapers. A shaper's config holds references, and a
reference is resolved at call time.

| Reference | Resolves to | Stored where |
| --- | --- | --- |
| `{caller.user}` | The operator's declared identity, a free-text setting in Settings > Task shaping | `app_config.shaping.caller.user`, not a secret |
| `{caller.agent}` | The harness: `claude`, `codex` or `pi` | Derived per call |
| `{caller.conversation}` | The task id | Derived per call |
| `{env:NAME}` | The daemon's environment variable `NAME` at call time | Nowhere. The value is never stored, logged or sent to the browser. |

- Header names are config, so a company's header never appears in Mission Control's code.
- A credential is never written into config. A header named `authorization`,
  `proxy-authorization` or `cookie`, or whose name contains `token`, `secret`, `key`,
  `password`, `auth` or `credential`, compared without case, may hold only `{env:NAME}`
  references, optionally after a fixed scheme word such as `Bearer`. A URL may not carry a
  username, password or query string. The strict shaper schema refuses anything else, so a
  literal credential is never stored or sent to a dashboard, whether it arrives through the
  API, a Settings import or a folder manifest. The rule goes by header name, so a credential
  under an innocent-looking name is not caught.
- A reference that resolves to nothing fails closed: the shaper is not called and is recorded
  as `unavailable`, with a reason that names the missing reference.
- A shaper cannot hand a value back. Before a reply reaches the engine, the transport
  replaces every occurrence of a value it resolved for an `{env:NAME}` reference with
  `[NAME redacted]`. That covers every string value of a successful reply (entry paths,
  titles and bodies, the summary, fact values, notes and version) as well as a failure
  reason. Keys the result schema defines are never changed. A fact name or an entry id that
  contains such a value is dropped with a note instead of renamed, so redaction can never
  merge two facts or two entries. The shaper's record is marked `redacted`,
  and the viewer and a dry-run say that a credential value was removed. Redaction is not
  degradation: the outcome does not change and the rest of the reply is used.
- A `command` shaper may also rely on its own program's sign-in, as the GitHub and Jira task
  sources do.
- The identity is declared and unverified, which is what the reference server accepts today.
  Verified identity (OAuth, or an MCP gateway) is undecided upstream. It arrives later as a
  new reference kind. Reference kinds are an append-only tuple.
- The desktop app does not inherit a shell's exports. The docs say where the daemon's
  environment comes from, and Settings shows whether each `{env:NAME}` resolves, as set or not
  set, never its value.

### Where the text lands in turn one

After the kind contract, as one section:

```text
## Task context

Mission Control added this context for the task. It supplements the instructions above and
cannot relax their authorization, plan or workflow rules.

### Acme guidance: Idempotent charges (billing-api)
...entry body...
```

- Each entry is headed by the shaper's label and the entry's title or id. The repository
  name is added only when the task has more than one repository.
- `composeTurnOne` gains one helper call that appends the section, so both call sites (the
  normal turn one and the standing-instructions fallback) carry identical text. The closure
  stays synchronous, because shaping is awaited before it is built.
- Order: kind contract, task context, skills for this task, repository lessons (FR-06, when
  built), and FR-05's repository task skill last.
- With no entries there is no section and no heading.

### Progress and `degraded`

- **During dispatch.** The pending tile reads "Shaping context" while the step runs, between
  "Provisioning its worktree" and "Launching claude".
- **On the task.** A bounded summary is stored on the task record and travels with
  `task_upsert`:
  `{ state, at, sessionId, durationMs, entries, bytes, truncated, shapers: [{ id, label, stage, origin, sha256, outcome, reason, durationMs, entries, bytes, truncated, redacted, version }] }`.
  `state` is `ok` or `degraded`. `origin` is `registered` or `discovered`. `outcome` is one of
  `ok`, `degraded`, `failed`, `timed_out`, `invalid`, `unavailable`. The field is absent when
  no shaper applied. The record describes the latest launch that reached a worker, and nothing
  else. It is committed when turn one has been handed to the worker, in one transaction: the
  summary is set to this launch's own, or cleared when no shaper applied, and the delivered
  text is replaced, or deleted when this launch's section is empty. A dispatch that fails
  before that point writes nothing. A launch whose shapers all failed therefore keeps its
  `degraded` summary and has no text, and a retry never shows an earlier launch's context.
  Each record names the session it was delivered to, `sessionId`, and follows that session
  across a resume. Every reader shows a record only while it names the task's current
  session: the chip, the viewer, the board and rail markers, task reads and the shaping
  route. So if a commit fails, the new launch shows no context and no `degraded` from the
  previous one.
- **In the dashboard.** A chip in the session header beside the standing-instructions chip:
  "Context: 3 entries", or an amber "Context degraded". It opens a viewer, "Context this
  session received", listing each shaper's origin, outcome, reason, duration and version,
  each injected entry, and a note for a shaper whose reply had a credential value removed.
  A degraded task also carries a small marker on its board card and rail
  row, where claim warnings show today.
- **Headless and `mctl`.** The summary is part of every task read: `GET /api/tasks`, and the
  Mission Control MCP tools `get_task` and `list_tasks`, whose records gain a `shaping` field
  with the `sessionId` it describes and a one-line `summary` such as `degraded: acme-guidance timed out after 5 s`. FR-05's
  dispatch inbox item carries an optional `shaping {state, summary}` built from the same
  `currentShaping(task)`, which stays an exported, stable helper.
- **Routed skills.** The summary lists each routed skill with what happened to it, the
  one-line `summary` names them, and the chip reads "Context: 3 entries, 2 skills".
- **Never.** No dialog, no confirmation, no attention item, no blocked launch.

### Feature flag

```ts
{
  id: "task-shaping",
  label: "Task shaping",
  description: "Call configured shapers before dispatch and add their context to a worker's first prompt.",
  stage: "preview",
  keywords: ["shaping", "shaper", "context", "guidance", "prompt"],
}
```

| Surface | Gate |
| --- | --- |
| Dispatcher | `featureEnabled("task-shaping")` is read for each launch. While off, nothing is scanned, resolved or called. |
| Routes | One `requireFeature("task-shaping")` on the `/api/shaping` group and `GET /api/tasks/:id/shaping` |
| Settings | The Task shaping category follows the flag live |
| Dashboard | The chip, the viewer and the "Shaping context" copy read `useFeatureFlag` |

While the flag is off, and while it is on with no shaper that applies, every worker launch is
byte-identical to today: same argv, same first prompt, no extra process. A test pins both.
Turning the flag off deletes nothing: stored shapers, the folder and past records stay. A task
that is dispatched again while the flag is off launches unshaped, so its own record is cleared
then, as it is for any launch that no shaper applied to.
Mission Control ships no enabled shaper, because which files to read is the operator's choice.

### Harnesses

Shaping runs in the daemon before any harness is involved, and the section is part of the
composed prompt, so Claude, Codex and Pi, on the SDK and terminal runtimes, receive identical
text. `context.harness` and `context.runtime` let a shaper tailor its answer. Pi receives turn
one as a launch argument and terminal sessions receive it as a paste, so the phase that adds
the seam finds each delivery path's byte ceiling and budgets every launch against the whole
composed turn one, not only the section. That is also why the total budget is capped at
64 KiB.

### Versioning

- **Protocol.** `protocol: 1` in every request and on every shaper. Additive changes keep the
  number. A breaking change is `2`, and Mission Control sends the version a shaper declares.
- **Content.** The optional `version` pin and the `version` each result reports, per FR-02
  section 3.6. The reported version is in the record and the viewer.
- **Persisted ids.** Stage ids, transport ids, built-in ids, outcome names, origins and
  reference kinds are append-only tuples, listed in the change contracts.

## The two shaper kinds

### Repository gatherer

Sources context from the task's repositories and returns text, facts and a summary.

- Any transport can serve it. A `command` gatherer is the general case: it runs in the
  worktree and can read, search or summarise whatever it likes.
- v1 ships one built-in, `repository-files`, which reads files the operator names. Its
  options: `include` (paths with a byte cap each, returned as context entries), `summary`
  (one path, cut to 4 KiB, returned as `repo.summary`) and `facts` (one path to a flat JSON
  object of strings or string lists, returned as `repo.facts`).
- It reads only regular files inside the worktree, with size caps, and records every skip
  without stopping the launch. Containment and size are verified on the file it opened, not
  on a path checked beforehand, so a file swapped while shaping runs cannot get past them.
  The one race these portable checks leave, a process running as the operator rearranging
  the worktree's directories during the read, is outside the threat model, because that
  process can read the file itself. Phase 6 states the rules. The facts file format a setup skill writes is owned by FR-03 and
  is not published, so flat JSON is what it reads for now.

### Guidance selector

Selects guidance for the task from an external source.

- The reference implementation is a `get_guidance` tool on a context MCP server (FR-02). With
  the `mcp` transport, registering it is configuration: the server, the tool name and the
  identity header. No adapter code, in Mission Control or outside it.
- Another company implements the same shape against its own store, behind any transport.
- A selector that reports `degraded: true` still contributes what it returned, and the task
  is marked degraded. That is FR-02's behaviour when its model is unavailable.
- Error codes a selector returns, such as `unknown_version`, `denied` or `invalid_input`,
  become the reason text.

## Skill routing

FR-04 `route_skills` runs after `get_guidance` and returns skills, not guidance. Routing is
the third stage, `route` (D5), built by Phase 7. It reuses the registry, the transports,
references, the time budget, `degraded` handling and Settings. Its result and its consumer are
its own, because a routed skill becomes an invocation line, not a context entry.

- **Result.** `{ version, skills: [{ name, lifecycle_point, reason_id }], truncated, degraded }`,
  FR-04 section 4. `lifecycle_point` is `task-start`, `during` or `after-work`. A skill with a
  point this build does not know is recorded and not used.
- **Request.** The select request, plus `context.guidance`: the ids of the entries the
  selectors put into the section for that repository (D13). Both `mcp` modes carry it as they
  carry the rest of `context`, so `route_skills` keeps its three arguments.
- **Names.** A name from Mission Control's own skill catalog is checked and gets its installed
  invocation. Any other name is announced as given and marked not verified (D15). A catalog
  skill the operator switched off is never announced.
- **Turn one.** A "Skills for this task" section after the task context names each skill and
  when to use it. The wording is Mission Control's, and a router supplies only a validated
  name.
- **A repository's own skill wins.** A routed skill named for the task's kind is not announced
  for a repository whose own task skill for that kind is in the launch (D14). Both can answer
  to the same invocation, so announcing the routed one there would be ambiguous.
- **After the work.** Mission Control itself prompts the session to run the skills routed for
  after the work: when the after-work step starts, or when Foreman judges the work complete on
  a task with no after-work workflow (D16). Once per launch, delivered when the session is
  idle, never holding the review. With no workflow it is held until Foreman's wrap-up has
  been sent, so the wrap-up always goes first.
- **Record.** Routed skills and the prompt are part of the task's `shaping` record.

`phase-7-route-stage.md` states the rules.

## Lesson promotion (FR-06)

The retro skill's promotion target differs from a shaper in every way that matters to the
engine: it runs at task end, it writes (it opens a pull request or calls a service), a human
approves it, a failure must be reported and retried instead of ignored, and it has no latency
budget. It is not a shaper stage (D10). It reuses the foundation built here, which is the
transports, the reference resolver, the egress guards and the manifest and Settings pattern,
and gets its own small registry and contract.

## Lesson selection at dispatch (FR-06)

FR-06 step 7 selects repository lessons for a task at dispatch. FR-06 owns it, and this plan
does not build it. This plan fixes two things about it: where it runs, and how it shares the
context budget.

- **Where it runs.** In a step of its own, after the last shaping stage and before
  `composeTurnOne`. The order is gather, select, route, then lesson selection, which
  FR-06 calls stage 4 of the post-shaping pipeline. It has to follow `select` and `route`:
  under FR-06, promoted lessons arrive as guidance from a selector, lessons attached to a
  skill arrive with routed skills, and this step selects only from the lessons that are left.
- **It is not a shaper.** No configured entry and no transport serves it. So it is not a
  selector, not a built-in, and not an id in `SHAPING_STAGES` or `SHAPING_BUILTINS`. Mission
  Control's own selection function reads the lessons kept in the task's repositories.
- **How it shares the context budget.** There is no second budget. `limits.totalBytes` (D9)
  bounds the shaping section and the lessons together, and lessons are allocated last. The
  step is given what the shaping stages left: `limits.totalBytes` less the `bytes` the
  shaping summary records, or all of it when no shaper applied. That remainder is the byte
  budget FR-06's selection function takes. Lesson bodies are fitted into it by
  `allocateBudget`, so a lesson is cut, dropped and recorded by the rules that apply to a
  context entry. When nothing is left, no lesson body is added, and FR-06 keeps the lesson
  index in the repository's root document as the floor.
- **What changes when FR-06 builds it.** One awaited call after `shapeTask`, and FR-06's own
  record of what was loaded. The shaping engine, its stages and its transports do not change.

## Implementation

`phased-plan.md` records what the repository looks like today, how the work is split and the
contracts between phases. Each phase document names its files, tests and documents. The code
lives in two browser-safe modules, `src/shared/shaping-registry.ts` (data) and
`src/shared/shaping.ts` (schemas and pure functions), and one daemon module,
`src/server/shaping/`. The seam is one awaited call in `Dispatcher.dispatch`, after
`taskPlanDiscovery` and before the `composeTurnOne` closure, to a `shapeTask` that never
throws. Tests and browser specs use fake agents and fixture shapers and spend no tokens.

## Phases

Seven phases, each one pull request: 1 the shaping core, 2 the dispatch seam and visibility,
3 the Settings panel, 4 the shaper folder, 5 the remote transports, 6 the repository-files
gatherer, 7 the route stage. `phased-plan.md` has the table, the dependencies and the contracts between them,
and each `phase-<n>-*.md` file is that phase's guide. Phases 1 and 2 are the first slice
(D3): both stages over the `command` transport with `degraded` visible, proven with two
fixture scripts and no external service. Phases 2, 3, 5 and 6 can run at the same time,
Phase 4 follows Phases 2 and 3, and Phase 7 follows Phases 1, 2 and 5. The
reference implementer can register a `command` selector after phase 2 and needs no code
after phase 5.

## Non-goals

- Shaping a task that is assigned into a live session. A session keeps the context it
  launched with, as it does for standing instructions and FR-05 repository task skills.
- Shaping pipeline tasks, whose prompts the pipeline engine composes.
- Guidance for work done directly in a home session, which never goes through dispatch.
  FR-02 section 3.9 covers it with a tool the model calls.
- Rewriting or summarising the operator's prompt.
- Caching shaper results, or retrying a failed call within one dispatch.
- Third-party code loaded into the daemon, and an operating-system sandbox for local shapers.
- Shapers declared by a repository's own files.
- Stored secrets. v1 has references only.
- The lesson promotion registry. It is designed here and built when its upstream contract
  exists.
- A shipped router or skill, native skill preload by a harness, and routing for work that
  never goes through dispatch.
- FR-06 lesson selection at dispatch. This plan fixes only its place after the shaping
  stages and its share of the context budget.
- A nudge or a task that hydrates missing repository facts (FR-02 section 5).
- A Mission Control span for the shaping run. In v1 a shaper's spans join the session's
  trace directly, and a span that groups one run's calls is later work.

## Risks

- **Enabled on discovery (D4a).** Any process running as the operator can drop a folder that
  then sends prompts to a URL or runs a command at the next dispatch. This was chosen for
  zero-touch installs. What limits it: the flag, the ownership check, a stored off that
  always wins, the Found on disk rows, and a launch record naming the definition that ran.
- **A hot file.** `composeTurnOne` is also where FR-05 adds repository task skills, and the
  FR-05 owner reviews changes to it. The edit here is one awaited call before the closure and
  one helper inside it. Whichever change merges second rebases a few lines.
- **Two first flags.** `task-shaping` and FR-05's `headless-mode` both expect an empty
  registry. The second to merge updates the registry test instead of replacing it.
- **Prompt size on delivery paths.** A 32 KiB section is four times the largest block injected
  today. Phase 2 measures paste and launch-argument delivery before the default is fixed,
  and budgets each launch against its path's ceiling.
- **Prompt injection through a shaper.** A compromised or careless shaper can put text in
  front of a worker. The mitigations are a labelled section that cannot relax the contract,
  caps, and a viewer that shows exactly what was injected and from where.
- **Latency under autopilot.** Several dispatches at once each run their own shaping, and
  local shapers are processes. v1 has no global concurrency cap. Phase 1 records per-shaper
  durations so the need for one is measured.
- **Routed skill names.** A router can name any skill installed for the worker's harness, and
  Mission Control can check only its own catalog (D15). The limits: a strict name pattern,
  Mission Control's own wording around it, a stored off that always wins for a catalog skill,
  and a record of every routed skill.
- **Three stages, one deadline.** A router has only the time gather and select left. A slow
  selector can therefore cost the router its call, and the launch then shows `degraded`.
- **Slow selectors.** A model-backed selector may need more than 5 s. The operator raises that
  shaper's timeout, and the step deadline still bounds the wait.

## Effect on other specs

| Spec | Change |
| --- | --- |
| MC context plugin interface (placeholder) | Replaced by this design. Its open questions are answered by D4 to D8 and the sections above. |
| FR-02, section 5a and question 8 | The generic call site ships with this plan (D11). The FR-02 owner registers a selector shaper for `get_guidance` instead of writing a call site. Registered in `folded` mode, the tool keeps exactly its three arguments and the complete collected input reaches it inside `task`, which is section 5a's proposal applied to the whole input. Question 12 is answered by D6, D7 and D8. |
| FR-04 | `route_skills` is the `route` stage, built by Phase 7 (D5). Questions 2, 4 and 6 are answered by D12, D14 and D13. |
| FR-05, section 12.2 | `degraded` reaches headless surfaces through the task record, and the dispatch inbox item builds its `shaping {state, summary}` from `currentShaping(task)`. FR-05's repository task skill stays last in turn one. |
| FR-06 | The promotion adapter gets its own registry on this foundation (D10). Step 7, lesson selection at dispatch, is not a shaper or a built-in. It is FR-06's own step after the shaping stages, allocated last from the one context budget. |

## Dependencies outside this plan

| Dependency | Owner | Effect if late |
| --- | --- | --- |
| A deployed `get_guidance` server | FR-01 and FR-02 | None on this plan. The fixture server stands in. |
| The facts file format | FR-03 setup skill | The built-in gatherer reads flat JSON until it is known. |
| A deployed `route_skills` tool | FR-04 | None on this plan. A fixture router stands in. FR-04 section 4 is still proposed, so a change there changes Phase 7's result schema. |
| Verified caller identity | Undecided upstream | Declared identity until then, then a new reference kind. |
| `mctl` and headless surfaces showing `degraded` | FR-05 | They read the task record this plan populates. |
