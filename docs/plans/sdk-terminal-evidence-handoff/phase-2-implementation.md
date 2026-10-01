# Phase 2 implementation notes

The implementation preserves the task, native conversation and active immutable workflow
bindings through one durable runtime transfer. It reuses Phase 1's prepared resume and
resource lease. Later phases and the separate Backlog UI feature are unchanged.

## Decisions and deviations from the proposed route

- Delivery already marked `sending` refuses preparation before SDK stop. The existing sender
  must establish its outcome first. This is the guide's allowed refusal path, avoiding a new
  drain or acknowledgement protocol. Uncertain packets remain uncertain.
- Evidence reads already holding the WorkflowManager capture lock finish before source stop.
  New captures wait for ownership and reread the binding. Captures acquire their lock before
  yielding when no transfer exists, so the reservation cannot miss a read entering that lock.
  The ownership wait is bounded to 30 seconds. Timeout or orderly shutdown retains the same
  submission as `capture_interrupted`; an explicit retry can resume that reservation without
  spending another round or replaying a delivery. Its subscription is released on every exit.
- Multiplexer resource IDs contain reusable session names. Adoption therefore requires the
  Phase 1 claimed wrapper's PID/start-time ancestry as well as any observed resource match.
  Exact emulator inventory IDs remain sufficient; handleless emulator discovery requires
  the claimed wrapper's lifetime. An unavailable proof leaves recovery pending.
- A keyless resume hook can establish native identity before OS discovery. Its occurrence is
  retained in the transfer row. It cannot bind a candidate until exact launch proof passes;
  hook identity or checkout alone never authorizes adoption.
- Pending ReviewManager questions also move in the adoption transaction. Answers recorded
  during the gap retain their original history and use the existing idempotent detached
  continuation path once the committed successor is available.
- Adoption and source rollback re-enter the existing workflow recovery policy for that
  conversation. Only packets that policy already permits can reach the normal consent and
  pane gates. This releases unsent live work after the hold without retrying uncertain,
  refused or historical deliveries, or sending Preview packets.
- A transferred task retains its original workflow binding decision even when that decision
  has no active binding. The normal dispatch binder cannot revive a paused binding or select
  the catalog's newer version after transfer. This guard uses the adopted transfer's task,
  successor and saved dispatch timestamp, so branch/status updates within that attempt cannot
  change the decision. A new dispatch attempt can bind normally. Adoption itself still checks
  the full ownership snapshot before committing.
- A pending launch returns the compatible success fields with a nullable `sessionId` and
  structured transfer summary. The 30-second HTTP wait does not settle a task or dispose a
  lease. Sitrep owns bounded recovery presentation independently of the source card.
  Successful actions refresh their displayed page, including page zero, when notifications
  are missed. A newer SSE snapshot supersedes an earlier action's fetched page.
  Before clearing a missing selected source, the browser queries its latest durable transfer
  and follows a present adopted successor. This recovers selection after missed adoption
  events without putting resolved history into fleet snapshots. New selection cancels the
  prior lookup; unreadable outcomes retain selection for the next snapshot to reconcile.
- Definite failure commits before owner settlement, and startup repeats only still-matching
  owner settlement. This closes the crash gap without another cleanup path. Source episode,
  task attempt and captured binding checks protect newer work from late resolution.
  Missing source episodes compare as null on both sides, so failed taskless transfers can
  settle pending questions without bypassing the guard for a newer episode.
- The source-stop intent is persisted after task detachment, immediately before calling stop.
  An interruption before that boundary restores both task pointers and aborts the unused
  transfer in one transaction after revoking its lease and rechecking ownership. This also
  covers taskless bindings. Before stop intent, the coordinator records the driver's exact
  PID and start time from a complete process inventory. Missing, unreadable or changing
  identity refuses the handoff while restoring the usable source. Claude reports its child
  through the vendor's supported spawn hook, Codex names its app-server child, and Pi names
  the daemon that hosts its in-process runtime. These are private observation identities,
  never signal targets. Restart can prove that lifetime ended even if the SDK row still says
  `running`, then settle through the existing owners once the terminal lease proves absence.
  A rejected stop uses that same lifetime proof before settling. A missing driver handle or
  a final SDK row can describe an ended event stream with a still-live child, so neither
  overrides the saved lifetime on immediate failure, recheck or restart.
  Failed-stop rollback also requires a positively live matching lifetime and matching handle
  after stop was entered; an extant handle alone cannot restore ownership to a dead child.
  The SDK supervisor now persists its observed child lifetime separately from status, clears
  it when a handle is replaced, and retains it when the stream ends. Exited SDK resumes use
  that durable proof before launching. The additive nullable column leaves older rows
  explicitly unknown. Missing proof, a live child or unavailable inventory creates visible
  recovery without launching; a later positive exit settles the unused attempt without replay.
  A live lifetime, an unavailable inventory or an older record without proof stays held;
  recovery never repeats stop or launch. This extends the proposed process proof to SDK
  drivers because Claude does not expose a subprocess PID through its bound event.

## Cross-phase boundaries

The new table contains ownership expectations and a Phase 1 lease locator, never credentials
or a second credential collector. Registry remains the sole session owner and uses its
existing eviction path. The adoption transaction composes synchronous Registry, WorkflowStore
and ReviewManager writes, then publishes their projections after commit.
The coordinator verifies that WorkflowStore shares the daemon connection before any handoff.
Independent injected workflow stores read transfer guards and history through their own
connection, but cannot participate in a multi-owner commit on a different connection.
Transcript anchors filter the committed predecessor chain before applying their result limit.

Active sibling bindings keep repository-specific checkout fields. Prepared destinations are
the only workflow delivery fields retargeted. Frozen submissions, evidence bytes, staged
generation, coverage, criteria, workflow versions and delivered attribution remain unchanged.
Worktree-return obligations are not created by handoff or transfer failure.

Old databases acquire the additive table and indexes without backfilling guessed ownership.
Unknown transfer states retain their guard. Downgrade while a transfer is pending remains
unsupported. See [session lifecycle](../../session-lifecycle.md) for the operational model.

## Verification and publication handoff

The phase's focused, compatibility, build, smoke and browser commands are retained in
[the implementation guide](phase-2-durable-runtime-transfer.md#8-verification-browser-proof-and-documentation).
New tests cover real owner interactions, transactional rollback, every persisted launch
boundary, exact process lifetimes, capture overlap, request continuation, delivery policy and
an actual built MCP client running under the production wrapper with fake agents.

Browser evidence covers the selected and default Continue controls, the same running task
and older pinned review, evidence staging after daemon restart, Board presentation, recovery
after source removal, and safe explicit resolution. Evidence files remain gitignored and are
registered with Mission Control for the reviewing Persona.

The task's initial completion handoff owns publication: this implementation turn does not
commit, push or create a pull request. The later workflow publication should include these
decisions and the registered verification evidence in its reviewable pull request.
