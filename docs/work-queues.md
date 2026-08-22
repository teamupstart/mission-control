# Work queues (load a session up and walk away)

Foreman above is *reactive* - it answers what a blocked session is asking. A **work queue**
is the proactive half: queue a batch of work for one specific session, and Foreman feeds it
in one item at a time, in the order you authored, checking each one before releasing the
next.

**Claude Code and Codex sessions are supported.** Codex reports pickup and completion through
the hooks Mission Control attaches to dispatched launches, and its rollout reads back as a
conversation for verification. Delivery uses the same harness-neutral pane path as Claude.
Codex renders no collapsed-paste placeholder, so Mission Control sends one Enter and records
that submission as unverified rather than retrying on evidence Codex cannot provide. A Codex
session started without reporting hooks is refused at the composer with instructions to
launch it through Mission Control, rather than accepting a batch it cannot verify.

The **Work queue** is a tab in the shared Console and Board detail. Select a session and
choose **Work queue**, or press <kbd>q</kbd>; pressing <kbd>q</kbd> again returns to the
Conversation tab. The tab carries the open-item count, so a waiting batch remains visible
while you read another part of the detail.

The queue summary remains available for as long as the
session has queued anything at all - not just while work is still waiting. It reports what
the batch is actually doing: **"3 queued"** while items wait, **"3 done"** once they've all
landed, and **"1 done · 2 escalated · 1 stopped"** in the attention tone when some of them
didn't - *escalated* being work Foreman gave up on and handed back, *stopped* being work
that ended without landing at all. A session with no queued work gets a chip too, but only
while a wrap-up question is outstanding: a **"ship it?"** in the attention tone, which is
how the *prompted* trigger's ask stays reachable on a session that has no batch to show.

Only work that actually **verified** is ever counted as done, and that's the point of the
wording rather than a detail of it. Every ending is *finished* in the sense that nothing
will advance it again - landed, escalated and cancelled alike - so a chip that counted
"finished" work would report a clean-looking total over a batch that quietly stalled. An
**exited** session has no action controls, but its queue history still says what the batch
did, which is why it outlives the work and why it does not flatter it.

Press <kbd>q</kbd> or choose another detail tab to put the queue away. The queue's own
sections can still fold long batches without losing their counts.

Inside it: type an intent, press <kbd>Enter</kbd> (or **Add**), repeat - the same contract
as the reply box in the Conversation tab, with <kbd>Shift</kbd><kbd>Enter</kbd> for a newline when
an intent needs more than one line. The box also
takes **dropped or pasted images**: the upload starts on drop, and what's queued is the
uploaded file's *path*, so the agent reads it with its own file tools whenever the item is
finally delivered. **Add** stays disabled while an upload is in flight, and an image with no
words is a valid item. The same gesture works on the transcript reply box and the
dispatch form. Items are drag-reorderable, editable, and removable while they wait -
and **editing** one obeys the same <kbd>Enter</kbd> saves / <kbd>Shift</kbd><kbd>Enter</kbd>
newline contract, because the edit box and the add box are the same textarea to look at and
sit inches apart: the panel has one Enter rule, not two. Then walk away. For each item
Foreman:

1. waits for the session to actually go **idle and settle** (not just look idle);
2. **delivers** the intent as a single bracketed paste (so a multi-line prompt doesn't
   submit halfway through);
3. waits for the agent to finish, then **verifies** the work in a fresh tool-less
   model call - using Claude's Agent SDK transport by default and reading the item's own diff and transcript against the repo's `AGENTS.md`
   / `CLAUDE.md`;
4. if something's genuinely missing, hands the **specific gaps** back to the agent to fix
   and re-checks - escalating to you only once an issue looks beyond it;
5. releases the next item.

When Foreman decides a session is finished it can **wrap it up**. Two independent choices in
the popover: **Trigger on**, one or more moments that count as finished, and **Then**, the
single action to take at whichever one fires.

| Trigger on | Fires when |
|---|---|
| **Queue drain** (on by default) | every item in the session's queue reached a terminal state |
| **Prompted work complete** (on by default) | you typed straight into the pane, the agent worked, and it parked - no queue involved |

Both ship ticked. Drain alone used to be the default, and it quietly excluded the commonest
kind of session there is: one you prompted by hand, which has no queue, never drains, and so
never reached a wrap-up moment at all. For [the repair loop](workflows.md#the-repair-loop-end-to-end) that
meant the completion signal simply did not exist for those sessions, and the loop read as broken
rather than unarmed. What the second trigger costs is bounded by everything below it - **Then**
still defaults to **Ask**, so a wrap-up moment renders a card rather than typing anything, and
direct PR is refused outright unless Foreman is live *and* the repository is
allowlisted.

The prompted trigger doesn't fire on idleness alone, because idle isn't finished. It runs
the same verifier queued items get - a fresh tool-less model call reading the branch diff
against the reconciled durable objective - and acts only on a **complete** verdict; an empty diff
decides itself without a model call. A session that still needs you is left alone, and a
checkout that *has* a work queue belongs to the drain trigger, which wins. It fires once
per completed **work cycle**. Mission Control records work starting and the matching turn
completion as a durable generation, and Foreman consumes that exact generation before it asks,
ships, or claims a Workflow. Repeated ticks and daemon restarts therefore stay quiet on the same
settled completion. The reconciled intent remains an independent staleness guard and the HEAD plus
transcript fingerprint remains proof and claim idempotency; neither one creates a new lifecycle
opportunity. A new prompt without a later completed work cycle does not re-arm completion.

**Straight to PR is latched per human episode, not per work cycle.** The instruction it types
makes the agent commit, push, open a pull request and follow CI, and then park - which completes
a *later* work-cycle generation under completely unchanged human intent. A guard that counted
only generations would therefore re-arm on the very turn the instruction caused and send it
again. So when Foreman hands a session to direct shipping, the same atomic write that consumes
the generation also records the handoff against the reconciled **intent episode**, and prompted
completion stays quiet for that episode however many generations follow. Recording happens
*before* anything is typed, and a failed or ambiguous injection is never retried automatically:
the **Ship it?** card is the recovery, exactly as it is for a send that could not be delivered.
Type a new instruction and completion re-arms on the next episode; clearing the context rotates
the session onto a fresh key that has made no handoff at all. Only direct shipping latches -
submitting a bound **Foreman Complete** Workflow does not, so its repair rounds keep working.

If Claude resumes the same objective from a background task notification, that notification
remains excluded from the human Goal, while its later settled Stop completes a new work-cycle
generation and opens one new verification. The same natural start-and-complete path follows a
Live Workflow repair packet on an item-less session; confirming delivery does not reset the
prompted guard itself. Foreman rechecks the generation, logical key, reconciled intent,
settled-idle state, human-attention state, and queue precedence after verification, so work that
restarts while the model is judging discards the stale result without consuming either cycle.
An incomplete verdict consumes the completed generation without sending the agent back, because
Foreman did not commission that work. Untick both triggers and Foreman never wraps up on its own.

The action is the same whichever trigger fired:

| Then | What it does |
|---|---|
| **Ask me** (default) | marks the moment; you pick from the **Ship it?** card, and an alert points you at it |
| **Straight to PR** | when no Workflow is bound, use git and `gh` directly to commit, push, and open a PR, then merge the default branch in, resolve conflicts, and follow CI until every check passes |

An active **Foreman Complete** binding takes precedence over either choice: Foreman submits
that exact Workflow at the verified boundary. A **Manual** binding remains manual and raises
the **Ship it?** card instead of letting Straight to PR create a competing pull request on the
same branch. Foreman never creates a fallback Workflow for an unbound session; choose one in
the task's **After work** field or bind it directly to the session.

Automatic wrap-up is only for shippable changes. A linked task whose **Kind** is **scout**
retires its completion without submitting an existing Workflow, typing the Straight-to-PR
instruction, or raising a Ship it? card. The
same rule applies when the resolved objective explicitly asks for review-only output such as
mockups, wireframes, prototypes, plans, reports or design explorations, and when the completed
diff contains only conventional mockup or plan artifacts. A mixed change that also contains an
implementation remains eligible. This is a Foreman automation boundary; it does not prevent a
human from committing or opening a pull request manually.

Straight to PR can ultimately *push*, so it only fires in **live** mode on an
**allowlisted** repo. Until then Foreman asks, and the popover says so rather than letting
the selected radio quietly do nothing. Workflow completion claiming is durable and
idempotent, so retries converge on one submission and one run instead of launching the
review twice.

The manual **Run No-Mistakes Review** button on the **Ship it?** card follows the same
workflow path. It reuses the active built-in binding when one exists, creates a manual
built-in binding for an unbound conversation, and refuses to replace a different workflow.
The review starts in **Live** only when Workflows Live authorizes the repository; otherwise
it starts in **Preview**.

**Foreman verification is evidence-only by design.** It reads the diff and the transcript and
does not run tests. Its job is the narrower question: *was the thing you asked for actually
done?* The review workflow owns its configured checks and reviewers. Gaps carry a severity, and only **blocking** ones send the agent back - a style nit
lands as advisory, shows on the session detail, and never costs a round. Two knobs in the Foreman
popover bound it: **fix attempts per issue** (default 3) and **max fix rounds per item**
(default 10, the hard stop).

Sends obey the same gate as everything else: dry-run **drafts** each item and waits for your
**Approve**, and live sends only happen in allowlisted repos. Verification is read-only, so
it runs in any mode - you see Foreman's judgment before it ever types. A queue needs hook
pickup/completion signals: Claude sessions must report installed hooks, Codex sessions must
have the launch-scoped hooks attached, and Pi is unsupported. The panel says so rather than
letting you queue work that can't run.

It says the same about a session Foreman was never [invited
into](foreman.md#which-sessions-foreman-may-act-in) - and says it over an *empty* queue too,
which no other explanation does. The rest describe what will happen to the items waiting, so
with none waiting there is nothing to say; this one is about the panel itself, and an empty
queue that has never moved is exactly where you go looking for the reason.

### Keeping a PR on track

Once work has an **open pull request**, its session can park while the
[GitHub Inspector](inspector-and-shipping.md#inspector-automated-pr-review) posts comments or CI goes red. The Foreman
popover's **Pull requests** section has two independent, default-on controls:

- **Keep sessions on track with review comments** nudges the parked session to resolve
  GitHub Inspector comments already posted on its PR.
- **Keep sessions on track with CI** nudges the parked session to fix failing checks. It
  never creates a PR; an existing open PR is a required input, and every fix stays on that
  PR's branch.

Each control can be disabled without disabling the other. A later GitHub Inspector round or a new
CI failure episode re-arms only the corresponding follow-through.

When upgrading from the earlier combined **Keep sessions on track** control, its saved answer
initializes both controls. An existing opt-out therefore stays fully opted out; only a fresh
configuration defaults both controls on.

Both apply to parked sessions on harnesses Foreman can reliably drive - currently Claude,
and Codex sessions launched with Mission Control's scoped hooks - whether the PR came from
**Straight to PR**, a review workflow, or one you shipped by hand.

Each nudge is typed into the session's pane, so it carries the usual gates and one more:

- it only **types** in **live** mode on an **allowlisted** repo, exactly like direct
  wrap-up - dry-run leaves the parked PR for you;
- it fires only at a **settled-idle** session, so it never interrupts one already working the
  fixes, and it does not nag a PR that's being handled: review comments re-arm **once per
  GitHub Inspector round**, and a failing CI re-arms **once per failure episode** - after the checks
  recover, a later failure counts as new (so a red CI is never permanently silenced, and a
  CI that merely goes green does not re-nudge the comments already relayed);
- it stands down while the session **needs you**, while it has a live **work queue**
  (the drain trigger owns that checkout), and while a non-terminal **workflow run owns the
  session and branch**;
- the review-comment half counts only GitHub Inspector findings **already posted on the PR**
  (dry-run drafts and findings still being posted do not count) - the failing-CI half works
  regardless.

**A session holding several pull requests is followed through on each of them.** A
[multi-repo task](dispatch-and-backlog.md#attaching-more-than-one-repository) opens one per
repository it changed, and each is tracked separately here: its own GitHub Inspector rounds, its own
CI-failure episodes, its own re-arming. Repo B's review landing does not re-relay what repo A
was already told, and a red CI in one repository is nudged even while the other is green -
which before this was invisible, because the trigger only ever looked at the pull request on
the session's own checkout.

The one thing they share is the pane. At most **one nudge per session per pass** is typed,
the primary repository's first, and the others wait for a later pass rather than landing two
instructions in a turn expecting neither - the same rule the concurrent
[per-repository reviews](workflows.md#one-review-per-repository) follow. A nudge about an
attached repository names it, tells the agent which worktree to stand in, and scopes its `gh`
commands to that repository, so "do not open a new pull request" is read as being about that
one rather than as a ban on a sibling it has not opened yet.

## Backlog autopilot (Foreman schedules the fleet)

A work queue drains one *session*. The **backlog autopilot** drains the *fleet's*
[backlog](dispatch-and-backlog.md#dispatch-an-agent) - the items you've queued but not started. Foreman reads the
planning head - up to 400 items, including held ones - to preserve its dependency graph,
then schedules enabled, ready items one at a time: onto an agent that's already idle when
there is one, or into a fresh worktree when there isn't - never past a ceiling you set.

Three knobs, in the Foreman popover under **Backlog**:

| Knob | Default | What it does |
|---|---|---|
| **Auto-schedule the backlog** | off | arms the autopilot |
| **Max agents running at once** | `3` | the ceiling it won't launch past |
| **Open PRs keep an idle agent off the backlog** | on | an agent whose branch still has an unmerged PR is not handed the next task |

The first of those three is also in the footer of the Line's
[Backlog drawer](ui.md#the-autopilot-planner), beside a live readout of what it is doing. It is the
same switch on the same config field, not a second copy of it - flip it in either place and
both surfaces say so.

### What model an autopilot launch runs on

**Settings → Foreman → Launches → "&lt;harness&gt; backlog tasks"** sets a per-harness model used **only**
when the autopilot launches an unpinned task from the backlog. It ships on *the Harnesses
default*, so most fleets never need to touch it.

Set it, and it outranks the Harnesses default for autopilot launches only. It is one tier of
the dispatch model order, which [Settings → Harnesses](dispatch-and-backlog.md#default-model) owns and states in
full - including what this field does and does not persist. If an autopilot-launched agent
isn't on the model you expected, that list is where to start.

These are task-agent models, not Foreman's dependency planner. **Settings → Foreman →
Models → Provider** controls all four of Foreman's own model roles, including **Backlog**;
the **Backlog** role's model field selects the dependency planner model. Changing a Launches
field never changes the provider or model that reads the dependency graph.

**The autopilot only assigns into sessions Mission Control created** - embedded ones and
ones it dispatched. That is a stricter bar than the rest of Foreman applies: everything else
Foreman does needs only [an invite](foreman.md#which-sessions-foreman-may-act-in), while
assignment hands a session a whole new task nobody in it asked for, so an *operator* invite
deliberately does not grant it. Dragging a card onto an agent yourself is unaffected, as
always - you picked that pane, and this loop has to guess.

**Max agents counts every live agent on the machine**, not just the ones Mission launched -
it's a statement about your machine's load, and a count that ignored the six sessions you
started by hand wouldn't be one. Uninvited sessions are counted here too, for the same
reason: a personal chat still burns the machine's CPU even though nothing may be assigned
into it. It bounds *autopilot* only: it never refuses a dispatch
**you** clicked, because blocking a button you pressed to protect a background scheduler's
budget is the worse surprise. A backlog item's
[on/off switch](dispatch-and-backlog.md#hold-a-backlog-item-back) is scoped the same way - it holds the machine
back, not you. An unmet dependency is different: it is a task-level ordering
constraint and blocks every scheduling path, manual ones included.

**It only ever launches in Live mode, on an allowlisted repo** - the same gate the
automated wrap-up actions clear, for the same reason. Launching an agent starts unattended
work, and handing a task to a running agent types a whole prompt into a pane you may be
sitting in front of; both are more consequential than answering a prompt. In **dry-run**
and **semi-auto** it still *plans*, so you see the dependency read on the board and can
click **launch new agent** yourself. Dry-run means dry-run.

**Foreman's inferred dependencies come from a model, and are treated as one.** A fresh,
tool-less call through the effective Foreman Provider sees every planning
item's title and intent and returns, for each item, what it must wait for. The reply isn't trusted as written: ids that aren't in the backlog are dropped,
self-references are dropped, **only the edges that close a cycle** are cut, and any item
the model forgot is appended unblocked. A cycle would deadlock two cards forever and look
exactly like two cards waiting their turn;
a forgotten item would leave the plan permanently stale, which is an unbounded replanning
loop. Every dependency that isn't part of a cycle survives, whatever order the model listed
the items in. **The plan supplies edges and never position** - what runs first is
[the order you arranged](dispatch-and-backlog.md#the-backlog-order-is-the-one-you-set),
and no model has an opinion about it. The read re-runs only when the planning head
**gains an uncovered item**, so a steady backlog costs nothing - and reordering the
backlog is not a change the planner has to see, so a move costs zero model calls.

Claude enforces the planner's JSON Schema through its structured-output contract. Codex
receives the same schema through `codex exec --output-schema`, using a per-run temporary
schema file that is always removed. The schema is rendered strict for that reader - every
property required at every depth, with optional values carried as nullable rather than
absent - so a plan entry with no `reason` and a report with no `note` are still sayable. See
[Foreman](foreman.md) for the full contract. The local Zod parse and its one repair attempt stay in
place for Codex until a real CLI conformance test proves every shape mismatch exits nonzero;
the fake CLI argument contract alone does not advertise that stronger guarantee. Both paths
remain fresh, read-only, and tool-less. A failed Codex JSON stream contributes only its
bounded failure-event message to planner health; agent-message output and task briefs are
never copied into the error.

Operator-selected dependencies from the dispatch form are separate, persisted facts. The
planner sees them, cannot reverse or remove them, and its inferred graph is sanitized
against them so an inferred reverse edge cannot deadlock the backlog. Those facts remain
enforced when autopilot is off or its model plan is missing.

**The read's time budget scales with the planning backlog** (`60s + 20s` an item,
capped at 10 min; `FOREMAN_BACKLOG_TIMEOUT_MS` pins a flat one instead). It has to: the
model writes one entry per item, so two dozen items take minutes of wall clock where
a handful takes seconds. A fixed cap worked on a short backlog and then stopped working for
good once one grew past it - every read timed out, so no plan was ever stored, so the
autopilot re-read the same backlog every tick and scheduled nothing while the board showed
ready items and an idle fleet. Three failures in a row and
Foreman stops asking and schedules **one task at a time, top-ranked first** - serial
execution satisfies any dependency order by construction, so a broken planner degrades to
slow rather than to wrong, and your order still decides which task that one is. That's a cooldown, not a latch: after `FOREMAN_BACKLOG_RETRY_MS` (10 min)
one fresh read is tried, so an API blip heals itself instead of waiting for a restart. A
daemon that refuses to *store* a plan degrades the same way rather than halting, on its own
counter and its own backoff.

The Foreman popover makes that circuit visible. **Dependency planner** reports
`healthy` or `degraded`, the effective provider and Backlog model, the consecutive failure
count, the last bounded error, and when the next automatic retry is due. While degraded,
**Retry planner now** spends one immediate probe. It does not disable the serial fallback:
if the provider or plan store is still unavailable, Foreman returns to one-at-a-time
scheduling and waits through the bounded cooldown again. The live worker claims each retry
signal once, so restarting only the worker does not replay an old click as a new model call;
a retry requested while no leader is live waits for the next leader to claim it.

Changing the effective **Foreman Provider** or **Backlog** model retires the previous pair's
failure state and forces an immediate dependency read, even if an older stored plan still
covers every item. This is also how changing away from a broken provider recovers without an
app restart. A successful provider answer is not enough to declare recovery; the new plan
must also be accepted by the daemon. The worker reports this process-local circuit over
localhost and never opens SQLite. The daemon exposes the bounded status and retry signal but
does not make scheduling decisions, so there is still one scheduler source of truth.

One read, one model call, over the **top 400 backlog items by your order**, including any
[held back](dispatch-and-backlog.md#hold-a-backlog-item-back) - they stay in the read so the edges pointing at
them survive it. Reading a
longer backlog in several calls was tried and taken back out: they run on the Foreman
worker's single loop, which also drives queue drain and needs-you triage, so each extra call
is another span in which nothing else in the fleet is attended to. Past 400 the
tail is scheduled **in your order with no dependency information** - and, since staleness
is coverage, a dispatch while the backlog is that long promotes an unplanned item
into the head and costs one replan. The 400 that get a dependency read are the 400 you put
at the top, which is what makes the limit defensible rather than merely bounded.
That is the accepted trade: one call, only above 400, in exchange for a bounded worst case
on the shared loop.

**An idle agent is preferred to a new worktree**, and that preference survives the ceiling,
since it consumes no new session. "Idle" is stricter here than the board's Idle column: the
agent must be settled, hook-instrumented (an autopilot that can't observe a session must
not type a whole task into it), have a pane, have no work queue of its own, no review
waiting on you, **no open PR on its branch**, be in the same repo, and be **the harness the
task was filed for** - a Codex task is never typed into a Claude pane unasked. The daemon
re-checks on arrival, because an agent can go busy between the decision and the request.

**An agent that shipped is not an agent that's free.** An agent which opened a PR and went
quiet looks identical, on every other signal, to one that finished with nothing left to
protect: it reads idle, its queue is empty, and once you mark its task done nothing binds
it. Handing it the next item would type into a checkout still standing on the PR's branch,
so the new work lands on a change that's out for review. So an **unmerged PR keeps the
agent off the backlog** until it merges - turn off **Open PRs keep an idle agent off the
backlog** if your PRs auto-merge and you'd rather have the throughput. A *merged* PR never
blocks; it lingers on the session detail so you can see the work landed. This narrows *autopilot*
only - dragging a task onto that agent yourself still works, because that's you saying
"yes, that one".

**A reused agent is reset before it's handed anything** - the same reset, and the same
refusals, as [dragging a card onto an agent
yourself](dispatch-and-backlog.md#hand-a-shelved-task-to-an-agent-thats-already-running). It keeps its own
checkout, so without this the next task inherits the last one's branch and context, and
the agent would push two unrelated tasks into one PR. A checkout holding anything origin
can't give back sends the task straight back to the backlog with a line saying what's in
the way; nobody is watching this one, so the only thing it may not do is quietly discard
your work.

Autopilot **confirms the rest of that reset unattended**, and it has already ruled out
what the confirmation protects: an agent is only "free" here with an empty work queue,
and clearing the context is how a handover works at all.

On the **board**, the Backlog column shows the
[hold switch and its disabled state](dispatch-and-backlog.md#hold-a-backlog-item-back), a **blocked** chip naming
what an item waits on, and a **next up** mark on the one Foreman would take next. A card
blocked only by Foreman's inferred dependencies stays draggable and launchable
(**launch anyway**), because the model's read is an opinion. An operator-selected
dependency is authoritative: its card reads **waiting for dependencies** and cannot be
launched or assigned early. The Foreman popover carries the live readout -
`2/3 agents · 4 ready · 1 blocked · 1 disabled` - so "why is nothing launching?" is
answerable without reading a log. The Line's [Backlog drawer](ui.md#the-autopilot-planner) answers
the same question in the place the queue is actually read: the capacity half of that readout
sits in its footer beside the switch, and its **next up** mark opens what Foreman
recorded about that item. It is the head because that is where you put it; the recorded
reason explains its *dependencies*, not its position.
