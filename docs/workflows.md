# Workflows and Personas

A Persona is a reusable Markdown review role, not an agent, terminal session, Foreman rule,
or Inspector setting. Personas you create or import live in Mission Control's SQLite
database. Their name, description, optional provider and model overrides, and guidance are
revisioned together. Saves use compare-and-swap, so a second tab editing an older revision
gets an explicit conflict and keeps its local text. Archive is soft: archived Personas are
read-only, remain addressable for future published history, and continue reserving their
normalized names.

Guidance is exact text. Accepted Markdown is not trimmed or newline-normalized when it is
created or updated. Copy writes that same text to the browser clipboard, download writes it
to a local `.md` Blob, and both imports store the document unchanged after deriving a proposed
name from the first level-one heading or the filename. Download URLs are revoked after the
click. Duplicate creates a new Persona rather than editing the source.

Each saved Persona shows the provider and model its reviews use. Resolution is:
the Persona's provider override or the app-wide provider; then the Persona's model override,
`MISSION_WORKFLOW_PERSONA_MODEL`, or that provider's balanced default. A stored provider id
unknown to an older build is reported and falls back through the shared provider ladder.
Each attempt is a fresh, tool-less provider call. The actual provider and model are recorded
on the attempt so history never has to re-resolve them from current settings.

### Importing a Persona from a file

There are two ways to bring an externally-authored Markdown role in, and they differ in one
thing that matters:

- **Import .md** picks a file with the browser's file dialog. The bytes are uploaded and stored.
  Mission Control never learns where the file was, so nothing can be said later about it.
- **Import from path** names an absolute path *on the machine the daemon runs on*. The daemon
  reads that file itself, which is what lets the Persona remember where its guidance came from.

An imported Persona is an ordinary Persona: revisioned, editable, archivable, offered to any
workflow stage. What it carries in addition is **provenance** - the source path, the enclosing
git worktree when there is one, the version from the nearest `.claude-plugin/plugin.json` when
the file sits under an installed Claude Code plugin, a sha256 of the exact bytes read, and when
it was imported. The editor prints the path and the timestamp under the Persona's name.

The name comes from the document's first level-one heading (or the filename, when it has none)
and the description from the paragraph under it - the same rule the built-ins and **Import .md**
use, so one document arrives under one name however it got here.

The path is refused, by name, when it is not absolute, when nothing is there, when it is not a
regular file, when it is not valid UTF-8 or contains NUL bytes, or when it is larger than the
100,000-byte guidance limit. An oversized file is **refused rather than truncated**: a Persona
carrying a prefix of its source would still be a valid reviewer while judging with less
authority than the document it names.

#### Upstream changes

Source files move on - a plugin upgrade, a `git pull`. Mission Control re-reads every imported
Persona's source when an authoring surface opens and when you press **Check upstream**, hashes
what it finds, and compares it with the hash recorded at import. Nothing is watched or polled in
the background, and nothing is ever adopted automatically.

A Persona whose source has changed is tagged `upstream changed` in the Persona list and on its
Library card, and its editor says so. One whose source cannot be read at all - deleted, moved,
replaced by a directory, grown past the limit - is tagged `source missing`. In both cases the
**stored guidance is unchanged and is still exactly what runs**.

**Re-import from source** adopts the file's current text as a new revision through the same
compare-and-swap as any other save, so a re-import from a stale tab is refused rather than
overwriting whatever landed first. It replaces the guidance and the provenance record; the name
and description stay yours, because you may have edited them and because a heading that now
collides with another Persona would otherwise make the change impossible to adopt at all.

Published workflow versions and ensemble evaluations are untouched by all of this. A published
version carries its own copy of the guidance it was published with, exactly as it does for an
edited or archived Persona (see
[Workflow drafts and published versions](#workflow-drafts-and-published-versions)), so an upstream
edit can never change what a judge already scored with. Adopting drift into a workflow is two
deliberate steps: re-import, then publish a new version.

Re-import is refused for a built-in, for an archived Persona, and for one that was authored in
the editor rather than imported - there is no source file to re-read, and the refusal says so.

The motivating source for this is [UpstartClaw](https://github.com/teamupstart/claude-code-extensions)'s
`agent-team` role documents (Reviewer, Tester, and the rest), which are shaped as
persona-plus-DO/DON'T contracts and read as review roles almost unchanged. Point **Import from
path** at one inside the installed plugin, for example
`~/.claude/plugins/.../plugins/agent-team/references/roles/reviewer.md`, and the Persona records
the plugin version it was adapted from. When the plugin is upgraded, the badge appears and the
diff is yours to adopt. None of those documents are copied into this repository: they are the
plugin's to version, and an imported Persona is your database's content.

### Built-in Personas

Four ready-made review roles ship with the application. Nothing has to be
imported: they are in the Personas tab of a fresh install, and any workflow stage can pick
one immediately.

| Persona | What it judges |
|---|---|
| Intent Conformance Judge | Whether the change contradicts a stated acceptance criterion. Fails only on a removed required behavior or an added forbidden one |
| Code Risk Reviewer | Risk the changed code introduces: bugs, security, performance, breaking changes, error handling. Never style, formatting, linting, or types |
| Test Evidence Auditor | Whether the evidence shows the intent working end to end, with visual evidence required for anything a user will see |
| Documentation Steward | Documentation this change made stale, against a one-owner-per-fact placement policy |

They are **app data, not your data**, and the Personas tab marks each one `Built-in`. Each
carries exactly the guidance the build was made from. An upgrade that improves a role updates
the current catalog, so drafts and newly published versions use the new guidance. Existing
published versions keep the guidance they were published with and history marks them
outdated. Adopting the changed guidance requires publishing a new version. Opening a
built-in shows it read-only: Save is disabled, Archive is absent, and there is a line saying
why. **Duplicate** is the way to a version you own - the copy is an ordinary Persona with
its own name, editable, archivable, and never touched by an upgrade. Their guidance is still
exactly as visible as any other: Copy Markdown, Download .md and the preview all work.

Because they always exist, their names are reserved: creating or renaming a Persona to
`Code Risk Reviewer` is refused the way any duplicate name is. The one exception is
historical - a Persona you imported from these documents before they shipped built-in keeps
the name it already reserved, and the built-in it shadows stays hidden behind your copy.
Archive or rename your copy to see the built-in.

The authored Markdown is in this repository under [`personas/`](../personas/), one document per role,
and it is compiled into the build - run `npm run personas` after editing one, and commit the
generated module. Each document's first level-one heading is the Persona's name and the
paragraph under it is the description. **Import .md** shares only the heading-to-name rule;
an imported Persona's description stays empty.

The four are written to compose, and they ship already composed: **No-Mistakes Review** is the
built-in workflow below. Among its Personas, Intent Conformance Judge runs first as a cheap
gate, then the other three fan out behind an All-pass Join. None of them restates the engine's
own review contract or output format, which every Persona prompt already carries, so editing
your copy changes what that role judges, not how it replies.

### Built-in workflows

One ready-made review workflow ships with the application: **No-Mistakes Review**. Versions 1
through 7 are preserved for bindings that already pin them, and version 8 is current. There is
nothing to author and nothing to import - it is in the Workflows tab of a fresh install,
already published, and can be bound to a session immediately.

Stage 1 is a deterministic gate: the [`typecheck` and `test` checks](#check-nodes), placed
ahead of every reviewer so that a change which does not compile costs no model calls at all.
Both are evaluated on the same submission and both must pass at their All-pass Join before
anything behind them starts, so one failing gate returns the submission to the session with the
command's own output and **no Persona runs**.

Those checks are live from version 3 onward, on a machine where you have switched checks on and
configured a command - the graph did not change, the runtime behind it arrived. Where you have
not, the gates report Not run and pass, and versions 3 onward follow the same Persona review
path version 2 does while preserving the deterministic stage in the graph. The
[Check nodes](#check-nodes) section owns the rules for configured, unconfigured and unauthorized
slots.

Behind it are the four built-in Personas wired the way they were written to compose. Intent
Conformance Judge is stage 2, the cheap gate: there is no point spending three deeper reviews
on a change that has already drifted from what was asked. Code Risk Reviewer, Test Evidence
Auditor and Documentation Steward are stage 3, running **in parallel on the same submission**
and aggregating into one combined repair packet at their All-pass Join. Every fail returns to
the session for repair.

**Version 8 adds a fourth stage: the built-in [Pull Request action](#pull-request-actions),
after the reviews and before End.** That is a change of *where the pull request comes from*.
Versions 5 through 7 reach End first and then have the completion policy type a handoff, so the
run is already successful at the moment the pull request is asked for and nothing proves one
arrived. In version 8 the pull request is an authored stage: it types the same skill, and its
`complete` route reaches End only once an open pull request has been observed at the commit the
continuation captured. End still means the authored graph succeeded - and by the time the
Inspector claims that success there is provably something for it to review. Because the graph
cannot reach End without one, version 8's missing-PR policy is **wait**: a gate that found no
pull request has met a state its own preparation would not fix, and typing a second handoff
would ask for one the run already has.

A passed review is then gated on the
[Inspector final gate](#inspector-final-gate) finding nothing on the pull request:
in versions 4 onward, findings require the session to fix, verify, commit and push, then
Inspector reviews the new head without rerunning the already-passed Personas. Versions 1
through 3 retain their original whole-workflow restart behavior. Versions 5 through 7
automatically return a passed, PR-less review to the session to prepare the pull request;
versions 1 through 4 offer **Prepare PR in session** instead. Every one of those paths
explicitly invokes the bound harness's **Pull Request** skill; if the skill is disabled, its
link has drifted, or the live session has not loaded the current skill generation yet, the
handoff refuses without advancing the run or falling back to an ordinary prose instruction.
Versions 2 through 5 retain their
Manual trigger and Live delivery defaults, while versions 6 onward default to Foreman
complete and Live. Live still requires the subsystem switch and repository allowlist, and
every binding can override the version default. Version 1 retains its original Manual and
Preview defaults for existing pinned bindings.

Like the built-in Personas it is **app data, not your data**, and the workflow list marks it
`Built-in`. Opening it shows it read-only: it draws in the Pipeline view with every editing
affordance off, Archive and Publish are disabled, the settings rail does not take an edit, and
there is a line saying why. **Duplicate** is the way to a version you own - the copy is an
ordinary workflow with its own name, editable, publishable, archivable, and never touched by
an upgrade. Duplicating changes nothing about the built-in, which stays listed and stays
bindable.

Because it always exists, its name is reserved: creating or renaming a workflow to
`No-Mistakes Review` is refused the way any duplicate name is. The one exception is
historical - a workflow you authored under that name before it shipped built-in keeps the name
it already reserved, and the built-in it shadows stays hidden behind your copy while remaining
addressable, so bindings and runs pinned to it keep resolving. Archive or rename your copy to
see the built-in.

An upgrade that improves one of the four Personas improves this workflow too, with no gesture
from you: it always carries the guidance and the graph the build was made from. Improving the
shipped workflow itself appends a **new version** rather than editing the one you may be bound
to, so an existing binding keeps running exactly the graph it was bound to until you rebind it.

Versions 3 through 7 are that rule in practice. Version 3 added the deterministic check
stage; version 4 preserves that graph and changes only the immutable Inspector-findings
policy; version 5 automatically prepares a missing pull request; version 6 makes Foreman
complete the default trigger; version 7 changes only the immutable
[repair-resumption policy](#repair-resumption) to `auto`; and version 8 appends the Pull
Request stage and sets its missing-PR policy to `wait`. Every earlier version remains in the
catalog and still resolves, so an existing binding keeps its pinned graph, policies, and
binding defaults - including versions 1 through 6, which stay `manual` and still wait for you,
and versions 1 through 7, none of which carries an action node or has its post-End handoff
changed. New bindings take version 8 because it is current. Adopting the newer version on an
existing binding means creating a new binding, which is the same gesture adopting any newly
published version already requires.

The graph is not stored in your database at all, which is what makes all of that true without
a seeding step that could half-run. It is compiled into the build beside the Persona documents.

### Workflow drafts and published versions

A workflow is a chain of **stages**, and the **Pipeline** view is where you author one. It
draws Session, the stages between it, and the End outcome; you add, remove and reorder stages,
and everything structural is generated for you. Every fail returns to Session for repair, and
the last stage's pass reaches End. Nothing is hand-drawn, so none of it can be got wrong.

There are two kinds of stage, and the difference is what they do to the run:

- An **evaluation** stage holds one or more Persona reviewers and deterministic Checks. They
  all read the same submission, a stage of two or more gets its all-pass Join, and the stage
  moves on only when every member passes.
- A **[session action](#session-actions)** stage holds exactly one action and no members. It
  does not judge the work - it *sends* an instruction to the bound session, waits for that
  turn to finish, and captures fresh evidence. Its outgoing seam says `complete`, never
  `pass`, and everything after it reviews the new evidence rather than the evidence the
  stages above it saw.

A brand-new workflow opens on Session, one empty stage affordance, and End - opening it never
edits it. Picking a Persona from the stage's inline list makes it stage 1; picking a second
makes the two run **in parallel on the same submission**, both of which must pass before
anything moves on. That is the whole gesture: two picks, no validation error. A version
published with that shape runs correctly on any build, but an older build refuses to
re-publish it.

Reorder by dragging a member onto another slot or another stage, or from the keyboard:
arrow keys move between cards, <kbd>⌥</kbd> plus <kbd>←</kbd> / <kbd>→</kbd> moves the focused
stage along the chain, <kbd>⌥</kbd> plus <kbd>↑</kbd> / <kbd>↓</kbd> moves the focused member
within its stage, and <kbd>Delete</kbd> removes the focused card after a confirmation.
Announcements and labels name members and stages; no surface prints a node id. A stage's name
is derived, not stored: one member names its own stage, and a parallel stage reads "Stage N".

**Graph** is the other half of the toolbar toggle, and it still edits anything. Add Persona,
**All-pass Join**, **Check**, **Session action** and End nodes from the left palette, then
connect the directional handles: Session emits `submitted`; a Persona, Check or Join emits
`pass` and `fail`; a session action emits only `complete`; failures may return to Session for
changes. Session needs at least one `submitted` route and may fan out to several. A Join needs
both outcomes from at least two distinct predecessors, waits for one result from each, and
passes only when all passed; a predecessor may be a Persona, a Check or another Join, and
never a session action - an action produces no verdict for a join to aggregate. Cycles are
legal only when they include Session. Persona-only cycles are rejected because they could
spend repeatedly against unchanged work. There is no checkpoint node and Inspector is not a
graph node.

The Pipeline view is offered exactly when a draft *is* a pipeline: one Session, a linear chain
of stages, one End, and nothing else. A graph drawn freehand that is not - two End nodes, a
fail routed somewhere other than Session, a Join fed from two different stages - opens in
Graph with a banner naming each reason in a sentence. Both views write ordinary draft graphs,
so a draft moves between them freely and existing workflows need no migration.

There are two add controls, because they answer two different questions. **＋ Stage**, on the
seam between cards, creates a stage and offers all three things a stage can be: your Personas,
the four check slots, and your addable session actions, grouped. The picker inside an
evaluation stage adds another *member* to it, so it offers Personas and checks only. A session
action stage has neither - it holds exactly one action by construction - so its own control
chooses **which** action it sends. Checks are offered even before you have authored a Persona,
because the slots are a fixed vocabulary rather than something you configure here.

Immediately after End, the Pipeline draws a fixed **Inspector** footer whenever the workflow's
final gate is Inspector. It is a projection of the completion policy and not a stage: it has
no drag handle, no member list, no graph edge and no delete, it is marked `Fixed`, and its
switches are the ones in the settings rail. End is still where the graph succeeds; Inspector
claims that success afterwards. A workflow whose final gate is None shows no footer at all.

### Session actions

A **session action** is a reusable instruction a workflow stage sends to the session it is
bound to. It is not a third kind of reviewer. A Persona reads one immutable submission and
returns a verdict; an action writes to the bound conversation, may change the repository, and
returns only "this finished". `#/library/actions` is its shelf and editor, beside Personas.

An action's fields are its name, description, the **exact Markdown instruction** the session
receives, an optional **required skill**, and the **completion** Mission Control must observe
before the stages below it run. The instruction is exact in the same sense Persona guidance
is: nothing trims it, re-wraps it or normalizes its newlines between the editor and SQLite,
because it is typed into somebody's conversation verbatim. Its ceiling is what one delivery
packet can actually carry, so an action that would be truncated on the way out is refused at
authoring rather than half-sent at run time.

Saves are revisioned and use compare-and-swap, so a second tab editing an older revision gets
an explicit conflict and keeps its local text. Nothing is resolved until you pick one of
three:

| Choice | What it writes |
|---|---|
| **Reload latest** | Nothing. Your edits are discarded and the newer revision is loaded. |
| **Reapply my changes** | Your edits, onto the newer revision, on **this same action** - so a workflow already pointing at it gets them. This is a three-way merge: only the fields you actually changed are sent, so a field the other tab edited and you did not keeps their value. |
| **Save as duplicate** | Your edits, as a **new** action. The original is untouched. |

Archive is soft: an archived action is read-only, leaves the add
controls, keeps reserving its normalized name, and stays readable because drafts and published
versions name its id. Built-in actions ship with the application, are marked `Built-in`, and
are read-only; **Duplicate** is the way to a copy you own.

The authored Markdown behind the built-ins is in this repository under [`actions/`](../actions/) -
Mission Control session actions, not GitHub Actions - one document per action, beside the
[Persona documents](../personas/) and compiled in the same way: run `npm run session-actions` after
editing one, and commit the generated module. The heading-to-name rule is the Personas' rule. An
action's required skill and completion are not in its Markdown, because those two are contracts
the daemon enforces rather than prose.

The completion selector offers what **this build can prove**, read from the daemon rather than
from the browser's own copy of the list:

| Completion | What the daemon must observe |
|---|---|
| Session turn finishes | The session verifiably picked the instruction up, then settled. A pre-existing idle never counts. |
| Pull request is opened and verified | The same turn boundary, plus an **open pull request Mission Control adopted, on this repository and this branch, observed at the exact commit the continuation captured**. See [Pull request actions](#pull-request-actions). |
| A commit lands in the checkout | The same turn boundary, plus a **commit in the bound checkout made after the session picked the instruction up** - HEAD's committer time is what proves it, because nothing durable records the head at delivery. Uncommitted edits do not count, and what the commit touched is a review question rather than this adapter's. The shipped [Retro](repository-memory.md#the-retro) action uses it: a retrospective that discussed three memories and wrote none of them has not finished. |

A completion is **code with proof and recovery tests**, not a string you type or a skill you
name. That is why the list comes from the daemon: a build that cannot prove a completion
offers it nowhere, and refuses to publish a workflow that names it, rather than running a
stage whose guarantee nothing keeps.

An action stage may sit anywhere a stage may sit, and a pipeline may hold more than one. When
the turn finishes, Mission Control captures **fresh evidence** and resumes from that action's
`complete` route. This is not a repair: it spends no repair round, and the stages *above* it
keep their attempts on the evidence they actually reviewed. Only a real evaluation failure
starts round *N+1* back at Session.

Publishing snapshots the action exactly as it snapshots a Persona - name, description,
instruction, required skill, completion, source id and source revision. Editing or archiving
the source afterwards cannot reach a version already published; version history marks the
snapshot outdated or its source archived and shows the exact instruction that version froze.

#### Pull request actions

The shipped **Pull Request** action invokes the [`pull-request`](skills-and-settings.md#skills-every-session-mixed-reload-behavior) skill and completes
only on durable proof. Duplicating it keeps that completion and that skill, so you can rewrite
the instruction without losing the verification.

What the daemon has to see before the stages below it run, and before End:

1. the packet was confirmed sent, something newer than the send anchor proved the session read
   it, and the session has since settled without a question outstanding;
2. Mission Control has **adopted** a pull request - the same ledger the
   [Inspector](inspector-and-shipping.md#inspector-automated-pr-review) reviews from, which only records pull requests it can prove are
   ours;
3. that pull request is on the **same repository root and the same branch** as the bound
   session's checkout;
4. it is **open**, and the last poll saw its remote head at the **exact commit** the
   continuation captured.

None of that can be satisfied by the session saying so. A pull request URL on the session card
is a lookup hint and nothing more, the branch name is not proof, and a pull request merely
existing is not proof. The head comparison is between full object ids on both sides: evidence
capture records an abbreviated commit, so the abbreviation is resolved against the repository's
object database rather than prefix-matched.

**Mission Control never polls GitHub for this.** The Inspector's existing poller is the only
thing that talks to a provider, and the action reads what it wrote down - which is also why a
freshly opened pull request can take up to one poll interval to be seen.

While it waits, the run says which of four things it is waiting for, because the remedies
differ:

| State | What it means |
|---|---|
| **Awaiting PR** | The turn finished and no adopted pull request names this repository and branch yet. |
| **Awaiting push** | The pull request is open, and the reviewed commit has not reached it. |
| **PR on another repo** | This turn opened a pull request, and it is against a different repository. |
| **PR on another branch** | This turn opened a pull request on this repository, from a different branch. |

The last two are the ones worth having separately. "No pull request yet" and "a pull request
was opened somewhere else" look identical from the outside and are opposite problems - one is
work that has not finished, the other is work that finished and landed off target - so an
operator told only "awaiting" would keep watching for something that already exists where they
are not looking. Both are still waits rather than blocks: a turn that opened a stray pull
request first and the right one second recovers on its own, with nothing retyped.

Mission Control claims a stray only when it can prove one: the pull request has to have been
adopted from the bound session after this action's instruction was delivered, and its
repository or branch has to be **known and different**. A pull request the poller has not
looked at yet has neither recorded, and that reads as *Awaiting PR* - the ordinary case for one
opened seconds ago - rather than as your session's mistake.

If the checkout moves between the proof and the capture - an agent that pushed and then kept
working - the captured segment is held to the commit it actually holds, and the action waits
for the pull request to catch up with *that*. It never sends a second instruction to get there.

One state blocks instead of waiting: a pull request at the reviewed commit that is **closed or
merged**. Nothing the daemon waits for reopens it, so the run stops for you to reopen it,
replace it, or reset the run. That holds for a pull request closed *while the action was
waiting*, which is the ordinary way it happens. Everything else - a provider that could not be reached, a
checkout that could not be read, a pull request on the wrong branch - waits, because a later
observation can still change the answer.

A blocked action is never a review failure. It writes no verdict, sends no repair packet back
to the session, and spends no repair round.

### Check nodes

A **Check** represents a deterministic command gate instead of a model review. **A configured,
authorized check now runs its command, and a non-zero exit fails the submission** - the failing
output comes back to the session as a repair packet, exactly the way a Persona's requested
changes do. It runs in a [pooled worktree of its own](worktrees-and-checks.md#check-leases), pinned to the commit the
run captured, under a [supervisor](worktrees-and-checks.md#running-a-check-command) that can prove afterwards that the
command and everything it spawned is gone.

> **If you already had checks switched on, this changes your results.** Earlier builds shipped
> the node without an execution runtime, so a configured check recorded **Not run** and passed.
> Those same commands now run and can fail. That is the fix rather than a regression, but a
> gate that has been quietly green may go red on the first run after upgrading, and the first
> thing to check is whether the command actually passes on the captured commit.

**Check commands run on Linux and macOS.** Everywhere else a check reports Not run and passes,
which is the same already-shipped path an unconfigured slot takes - see [Running a check
command](worktrees-and-checks.md#running-a-check-command) for why the platform floor exists.

**A Check names a slot, never a command.** The slots are `test`, `lint`, `typecheck` and
`build`. The command assigned to each slot is configured per repository under **Settings →
Workflows**, keeping the exportable published version machine-neutral and free of argv. The
execution contract accepts an **argv**, not a shell string, so `&&`, `|` and `$HOME` are
ordinary arguments. The settings field splits a typed line quote-aware (`'…'` literal, `"…"`
honouring `\"` and `\\`, a backslash escaping the next character outside quotes, adjacent
runs joining into one token) and **shows the parsed argv back**, so you see what the
execution runtime will receive.

The repository box beside it is the same picker the dispatch form uses. It offers the
allowlisted repositories first - a check only runs in one of those - then every git
repository under the workspace roots, filtered as you type. It starts empty and still takes
a typed path, which is how a subdirectory override is entered: the list holds roots, and the
override is a path below one.

Each repository may configure a slot **once**; a second entry for the same pair is refused
rather than silently ignored. A **subdirectory** entry beats the repository-wide one, which
is how a monorepo gives one package its own command - and the command then runs *in that
subdirectory*, not at the top of the tree. Worktrees of a configured repository count too,
wherever they live on disk: a dispatched session usually stands in a pooled checkout under
`~/.treehouse/`, and because a worktree mirrors its repository's layout, a session in that
checkout's `packages/web` resolves the command configured for the repository's
`packages/web`. That match is on the exact directory, component by component - a session in
`examples/packages/web` gets the repository-wide command, not the one configured for
`packages/web`.

**An unrun gate passes, with a note saying why.** A slot with no command configured for this
repository is *skipped*; a repository that has not been authorized is *not run*; a platform that
cannot run checks, or an executable that is not there, is *not run* too. All of them pass,
because a workflow that failed on every unconfigured machine would be broken by default, and
each says which of them happened so it is never mistaken for a gate that ran. Only a command
that ran and exited non-zero fails.

An infrastructure problem is never a fail either. A timeout, a kill, a pool with no worktree to
give: none of them is a statement about the change under review, so they retry and then block
the run visibly rather than reporting a verdict.

**Checks are consent-gated twice**, and are off by default. **Settings → Workflows**
(`#/settings/workflows`) carries both controls: **Enable workflow check commands**, the switch,
and **Check commands**, the table of repository root, slot and argv. The switch alone is not
enough - the repository must also hold the **Workflows** grant in
**Settings → Trust** (`#/settings/trust`), the same grant Live delivery uses, and neither is
granted by default. Enabling both authorizes running code the reviewed branch supplies - its
scripts, dependencies and build steps - with the daemon's own filesystem authority. **This is
not a sandbox**, and the grant rather than anything in the runtime is what bounds it.

Because that pairing is the heaviest thing any grant in the matrix permits, Trust flies a
double dagger on every Workflows cell while the check switch is on, names those repositories,
and offers **Turn checks off** in place. A grant with checks off is not flagged: no command
can run, and amber on an inert grant is how a matrix teaches you to stop reading it.

**Checks use the treehouse pool whenever the binary is installed.** Unlike dispatch, a check does
not consult `treehouse.toml`; it keeps using the pool for a repository that has no such file. Two
check commands run at once, and each one holds a pooled worktree for as long as it runs - drawn
from the same `max_trees` a dispatched session draws from (`treehouse.toml` in the repository;
this one sets 32). On a repository with a small pool, a long test suite gating a review is a slot
a dispatch is waiting for. Raise `max_trees` there if dispatch starts queuing behind checks.

When `treehouse` is not installed, a check instead uses a throwaway detached `git worktree` pinned
to the captured commit. The configured command still runs and its real result still gates the
workflow; the fallback does not record the check as passed without running it. Checks also run
through their own small attempt budget, separate from the review budget, so a build never spends
a Persona's slot.

Run detail draws a check as its own card: the slot, the configured argv, the exit code, and the
last few kilobytes of output with a count of anything dropped - or, for a gate that did not run,
the sentence saying which of the reasons above applied.

Draft changes autosave after 500 ms of quiet. Every write carries the revision it loaded,
so a newer tab cannot be overwritten: autosave pauses and offers **Reload latest** or
**Duplicate my draft**. A conflicted draft cannot be replaced by selecting or creating
another workflow; Duplicate is the explicit path that preserves it under a unique name.
Validation runs from the same browser-safe implementation in the
canvas and at the daemon boundary. It checks ports, routes, Join pairs, reachability,
Session-centered cycles, active Personas, graph limits, and finite bounded coordinates.

**Publish** is enabled only for a saved, conflict-free, valid revision. It is idempotent for
that revision and creates an immutable version containing the exact name, description,
Markdown, provider/model overrides, and revision of every Persona. Editing or archiving a
Persona you own, or updating a shipped built-in in a later build, never changes old versions;
history marks its snapshot as outdated or its source as archived. To update a published
design, edit the mutable draft and publish a new version. Opening a workflow fetches only
bounded version metadata; selecting one history entry fetches that immutable graph and its
exact Persona Markdown from the version route.

Workflow settings also store binding defaults: Manual or Foreman-complete trigger, Preview
or Live delivery, and a repair-round limit. Foreman complete plus Preview is the default for
new workflows. The optional Inspector final gate and its missing-PR and findings policies are
immutable parts of each published version, and so is the
[repair-resumption policy](#repair-resumption) below.

The trigger mode answers only **what opens round 1**. What resumes round *N+1* after a repair
is a separate question with a separate answer, which is why Manual no longer means the run
stops for ever the first time a Persona asks for changes.

### Retiring a workflow

**Archive** is the way to retire a published workflow, and it is soft and reversible.
Archived workflows leave the default library listing and refuse edits, new bindings, and
binding reattachment until restored. Existing bindings and in-flight runs remain intact,
and published versions and run history stay readable. Archiving is refused while any binding
on the workflow is still active. **Restore** brings one back: the normalized name was never
released while archived, so nothing can have taken it and there is no conflict to resolve.
Show archived workflows with the checkbox under the library list.

**Delete** is offered only for a workflow that has never been published, and it removes the
row outright. That restriction is what makes it safe rather than careful. A binding names a
published version and a run names a binding, so a workflow with no versions can have no
binding, no run, and none of the submissions, attempts, deliveries or evidence hanging off
one; there is nothing to orphan and nothing to cascade. Publish once and the workflow can
only ever be archived, because an immutable version is audit history that bindings, runs and
ensemble handoffs quote by id. Deleting also frees the name for reuse, which archiving does
not. Delete asks for confirmation and cannot be undone.

### Manual Preview runs

Bind a session to an exact published workflow version from the workflow history or from any
fleet layout, then choose **Preview**. On a Cards card and in the Console and Board detail
header, the offer is a **＋ workflow** chip, and it is present whenever no run currently *owns*
that session - which includes a session whose last run has finished. A finished run shows both:
its outcome chip (**Approved**, **Preview cancelled**, **Preview failed**) as history, and the
＋ workflow chip as the next move. Only an open run withdraws the offer, on the same
[held-ness join](ui.md#layout-cards-console-or-board) the held tag and the backlog drop target
read, because that is the window in which the daemon would refuse a second binding anyway as a
conflict. A binding records the conversation note key, harness, name, working directory, and
repository root, and pins the immutable version id. Publishing or editing a newer workflow
cannot change an existing binding or run. Reaching for the chip on a session that is still bound
to an active binding opens the dialog on that binding rather than an error: choosing the bound
version offers **Submit bound version**, and choosing a different one explains the conflict.

Each submit and resubmit carries a durable request key. The daemon creates the submission
before evidence capture, so retrying the same request returns the same durable row and never
starts duplicate work. **Bind and submit** returns as soon as that capturing row is durable,
and the dashboard opens the run immediately while evidence capture and context compaction
continue in the background. The first request is acknowledged with HTTP `202`; replaying its
request key returns the same row with HTTP `200`. One submission captures one shared snapshot
for every concurrent Persona. It preserves the raw goal, refined goal when present, human
decisions and rationale, repository HEAD and diff, transcript evidence, repository standards,
and prior Persona feedback. A cheap provider-neutral compaction call may summarize that
context, but its 45-second attempt cannot replace the raw evidence. An unparsable reply gets
one fresh 45-second attempt; invalid, timed-out, or unavailable compaction produces a
deterministic visible fallback.

Persona prompts put the operator's intent, decisions, constraints, and acceptance criteria
before repository evidence. Prior Persona feedback is labeled as non-human input and all
captured evidence is fenced as untrusted data. A strict `pass` verdict requires approval
details; a strict `fail` verdict requires concrete requested changes and evidence references.
Malformed output, provider failures, and timeouts are infrastructure errors, never Persona
fail verdicts.

The durable engine records attempts and edge receipts, waits for all inputs at an all-pass
Join, retries transient infrastructure failures with bounded backoff, and stops at the
binding's repair-round limit. A failing path back to Session either resumes itself or waits for
a manual resubmit, depending on the published [repair-resumption policy](#repair-resumption).
Resubmission captures fresh evidence and refuses an unchanged snapshot unless the operator
explicitly confirms it, so an approval from an older round is never reused. Preview performs
no terminal write, keystroke injection, Foreman action, Inspector action, or message delivery.

The whole daemon runs at most three review calls at once, and Persona attempts and context
compaction spend that one budget together rather than each holding a private ceiling. The
capture compaction for an accepted submission moves ahead of queued Persona attempts when a
slot becomes free; it does not interrupt a call already running. The Foreman is a separate
process with its own serial queue, and the background jobs below keep their own limits,
because they degrade differently and must not wait behind a Persona call.

Run state survives daemon restarts. Interrupted provider calls become auditable errors and
are retried without duplicating receipts; missing immutable data fails visibly instead of
falling back to a mutable draft. A disappearing session orphans its binding. A conversation
clear pauses it. Reattachment is explicit and validates the harness and repository identity,
then requires a fresh resubmit. Reset removes bindings, runs, submissions, attempts, receipts,
captured context, and model-call metadata through the same session reset owner. Compact run
summaries update over the existing SSE stream, while detailed evidence and timelines are
loaded on demand for a selected run or a bound Board tile. Cards, Console, and Board show the
same workflow status. Run history pages use the updated-time cursor index, select the bounded
page before enrichment, and batch the latest attempts in one follow-up query. Summary reads
never load submission context or evidence. Detail reads batch attempts and receipts for the
whole run, so their query count does not grow with the number of submissions.

### Watching a run

When a session has a bound run, its Console and Board detail pane shows a vertical stage
ladder in the **Workflows** tab (<kbd>y</kbd>). Every stage names its members and each member's own
status, so a stage that folded to `All passed` still says which reviewers and checks passed it,
and an objection, Inspector wait, session-action wait, or uncertain delivery opens in
place. A workflow whose final gate is Inspector ends the ladder with a fixed `Inspector` rung
*after* the End outcome, marked `Fixed`, reading `Not reached` until the run gets there.
Preview feedback can be copied there. The failing rung also reports a member that has failed consecutive
repair rounds, the signal of a non-converging repair loop. At the Inspector gate, **Recheck
Inspector** evaluates the wait again, and **Open PR** opens the adopted pull request when there
is one - it is absent rather than greyed out on a gate with no pull request adopted yet, which
is every Inspector workflow up to the moment one is. A waiting run with a missing or unadopted
PR also offers **Prepare PR in session** when its immutable run policy permits preparation. An uncertain delivery can be resolved under the same confirmation
and typed-phrase guards as the Runs page. Use **Open run** for the full evidence and timeline.
A published version whose graph cannot be expressed as stages keeps the existing workflow chip
here and links to the Runs page, where its read-only graph remains available.

The Board overview also keeps a compact **active-rung preview** inside each bound session tile.
It names the consequential stage and its members, and keeps the first objection, Inspector wait,
or uncertain-delivery warning in view. **Show full workflow** expands that tile in place into the
same actionable ladder; **Collapse workflow** returns to the preview. Press <kbd>e</kbd> on the
selected tile to toggle those same controls without opening the session detail. These controls do
not open the session or leave the Board. **Open run** inside the expanded ladder remains the explicit route
to the complete evidence and timeline. The preview fetches run detail when its tile mounts and
refreshes from the compact SSE summary's `updatedAt` signal; the SSE payload itself is unchanged.

The **Runs** tab reads a run on **the pipeline it was authored on** - the same Session,
stages and End the Pipeline view draws, with a live status on every member. Reviewers show
queued, reviewing, passed, or changes requested; Checks show their corresponding command
state. Inspector-only repair rounds show their previously passed stages as green **Skipped**;
the tooltip explains that only Inspector is being rerun. A check skipped because its command
is not configured stays amber, with its reason available on the check and stage status.
A stage of two or more members shows each one and passes only when all do. A version
drawn freehand in the Graph view is not a pipeline, so its run falls back to that graph,
read-only, carrying the same statuses. No surface prints a node id. The same fixed
**Inspector** footer the author saw follows End here, carrying the gate's live state.

A **session action** reports a lifecycle rather than an outcome, and its vocabulary is
deliberately its own - nothing about it ever reads Passed, Failed or Changes requested,
because it judged nothing:

| Chip | What has been proven |
|---|---|
| Preparing | The attempt exists; its one packet has not been composed yet. |
| Ready to send | Composed, and nothing has been typed - Preview, or Live awaiting authorization. |
| Sent | Typed into the pane. Nothing newer than the send anchor proves the session read it. |
| Session working | Pickup proven, and the turn has not settled. |
| Needs you | Picked up and parked on a question. Never a settled turn. |
| Verifying | Settled, and the completion this action asks for wants evidence it does not have yet. |
| Awaiting PR | Settled, and no adopted pull request names this repository and branch yet. |
| Awaiting push | The pull request is open, and the reviewed commit has not reached it. |
| PR on another repo | This turn opened a pull request against a different repository. |
| PR on another branch | This turn opened a pull request from a different branch. |
| Capturing evidence | The completion is satisfied and the fresh evidence is being captured. |
| Complete | The turn finished and the downstream evidence exists. |
| Could not run | A delivery or infrastructure problem, stated as a sentence. Never a repair packet, never a spent round. |

A finished [Pull Request action](#pull-request-actions) also names **what it proved**: the pull
request it verified, and the short commit its remote head was observed at. That link appears
only once the proof exists - offering to open a pull request nothing has verified would be the
claim this whole completion refuses to make.

Each waiting or blocked action also carries the sentence behind its chip, and its own card
under **Session actions** - separate from **Reviewer verdicts**, which promises a verdict an
action does not produce. The card names the snapshot the version froze, what the action
required, and a bounded preview of the exact instruction that was sent.

**Reviewer verdicts lists what can hold an opinion, and nothing else.** Every node in a graph
owns attempt rows, including the three kinds that are pure structure - the Session, each all-pass
join, and the End - so a run used to list them here as cards reading `Session completed ·
attempt 1`. Their state is already on the pipeline strip above, and a Persona or Check with no
verdict yet (queued, retrying, errored) still appears, because that is the case a reader most
needs. A workflow with no reviewer in it at all says so, rather than promising one that is not
coming. A structural attempt that is anything other than quietly complete is still shown.

The rail lists history newest first with a state chip, the bound conversation and a relative
time. Four chips - **All**, **Running**, **Needs you**, **Done** - are shortcuts onto the
same single-state filter the **State** dropdown offers in full; the dropdown still reaches
every state, and workflow id and session filters sit beside it. Filters and the selected run
are part of the bookmarkable hash, and history pages 50 rows at a time.

A run is read one **submission** at a time. The scrubber lists every one with the round it
belongs to - Inspector-only repair rounds marked as such - and the round that asked for
changes is marked even though its submission is a healthy `waiting for the session`.
Selecting one scopes the pipeline statuses, the verdicts, the join packets and the timeline to
it; the latest is selected by default. The Inspector gate, completion claims, deliveries and
every recovery action always reflect the live run whatever is on screen, and a note says so
while an earlier one is selected.

**A repair round and an evidence segment are different things.** A round is a repair: an
evaluator asked for changes, the work came back, and the whole pipeline runs again from
Session against the repair budget. A segment is a session action finishing: fresh evidence,
only the stages after the action, and no budget spent. A round that holds more than one
segment labels each of them - `Round 1 · evidence 1`, `Round 1 · evidence 2` - and selecting
a continuation says in a sentence which action produced it and that it cost no repair round. A
round with a single segment is just `Round 1`, because there is no distinction to draw. The
action that authorized a segment is shown *with* that segment even though its attempt belongs
to the parent, so a continuation never reads as evidence that arrived from nowhere.

On a run that has not finished, click a Persona row, or the header of a stage containing one
Persona, to attach **Critical Persona feedback**. The editor locks the scope to that Persona
node and that workflow run. Once saved, the instruction appears first in the Persona prompt
on its next execution and every later round until it is removed or the run ends. It takes
priority over the run's original intent, the published Persona guidance, prior reviewer
feedback and evidence text; safety requirements and the required verdict format still apply.
The published Persona, sibling Personas and every other run remain unchanged. An amber mark
on the Persona says feedback is active, while each attempt snapshots the exact revision it
used so later edits do not rewrite history.

The Persona or stage **•••** menu owns the separate run override. Choose **Disable for this
run** and the row turns red with a ⊘ mark; choose **Enable for this run** to restore it. The
stage menu switches every eligible member at once. A disabled gate auto-passes instead of
running: any round that has not reached it yet, the current one included, records a pass
verdict that says plainly the gate was disabled, stamps no provider, and appears in the
timeline as `Disabled node auto passed`. A gate already running or already finished this
round keeps its real outcome - the red row treatment says the gate is switched off going
forward, while the member's chip stays the viewed round's history: **Disabled** only for
a gate the round has not reached (or the auto-pass itself), the recorded verdict
otherwise, so a failure that already happened never reads as skipped. The switch is
scoped to that one run - the published version, other runs of the same workflow, and the
workflow editor are untouched - and it is how you force a phase to pass on the next
resubmission when a reviewer keeps blocking for reasons outside the work. A **Disabled**
chip never folds its stage to **Failed**; the stage counts it with the not-run gates
("Passed, 1 not run"), and the session tile's compact ladder shows the same boundary.

Verdicts are cards: the outcome, the reviewer, its summary, its approval rationale or
requested changes with evidence references, and the runner, model, duration and cost that
actually ran. Inspector gate state, Foreman completion claims and repair deliveries are the
same card with a different accent. Durable failures read as sentences - "The write may or may
not have landed" - with the machine code kept beside them for a bug report, never instead of
them. The timeline names Personas and rounds rather than printing payload JSON; the run id and
the complete durable JSON records sit beside it under **Audit and bug reports**, collapsed,
because they answer a bug report rather than a reader.

**The header offers one next move, derived from the run's own state.** Not every control the
run might accept: a single primary, in the language of the person reading the page rather than
of the route behind it. A parked run offers **Resume review**; an Inspector gate waiting on a
pull request offers **Ask the session to open a PR**, or **Check again** when its immutable
policy declines the handoff; a run blocked on an exhausted provider call offers **Retry the
failed call**. A run whose evidence snapshot has not moved since the last round is refused by
the daemon, and the primary becomes the recovery for exactly that refusal - **Review this
snapshot anyway** - which is the only state it appears in.

When there is no move, the header says so **in a sentence** and names where the decision
actually lives: "Confirm or discard it in Deliveries below", "they are listed under Inspector
final gate below". A control that cannot run is never left standing in place of an explanation.
That covers the states nothing argument-free revives - the bound session is gone, the run is
externally sourced, it has used every repair round its binding allows - and the states blocked
on a judgement the page carries the material for further down. Beside the primary sit at most
**Copy feedback** and **Open PR**, and **Open PR** appears only when there is an adopted pull
request to open.

**A finished run can be run again.** A `completed`, `cancelled` or `failed` run used to be the
end of the road - every control left on it copied, downloaded or navigated, and nothing anywhere
offered to review that session again. Its primary is now **Run this review again**, or **Preview
this review again** on a bound preview: it reads the session's current diff and transcript, runs
the version that session is bound to against that fresh evidence, and takes you to the new run.
The finished one stays in history. Where the binding has since been paused, orphaned or archived
there is no run to start, so the header says which of those it is and what would start another.

Actions that cannot be taken back confirm in the app rather than in a browser dialog.
**Cancel run**, the resubmission against unchanged evidence, running a finished review again,
and the delivery's **Mark delivered** ask once; **Restart full workflow** and **Discard and send
new round** require the exact phrase the daemon also demands, typed into the confirm. Running a
review again asks because it spends model tokens and creates a run, not because it destroys
anything, so it takes one click to confirm rather than a typed phrase.

With no runs at all the tab offers **Bind to a session…**, the same dialog the builder's
right rail opens.

### Runs Mission Control started for itself

Almost every run is one an operator submitted. A run can also be started by Mission Control
on its own behalf, when one of its own features has already selected an exact result and
wants it reviewed. That path is internal - there is no endpoint that starts arbitrary runs on
a caller's say-so, and nothing can aim one at a session you did not choose. The daemon
resolves the published version, the live conversation, and the idempotency key itself.

Such a run is one run. Repeating the request, or restarting the daemon mid-flight, returns
the same binding, the same run, and the same first submission rather than starting a second
review of the same work. A conversation that already has an active binding is reported as a
conflict: yours is never replaced or quietly taken over.

The evidence must be exactly what was selected. Before anything is stored and before a single
provider token is spent, the capture has to observe the expected commit **and** a clean
working tree - matching HEAD with uncommitted changes beside it is not the selected result.
A mismatch blocks visibly and says what it saw; restoring the exact result and asking again
resumes that same submission instead of opening a new round.

That commit is pinned to the run at creation and cannot be changed afterwards. A repeat call
naming a different commit is refused rather than accepted, so one result id always means one
artifact. For the same reason the ordinary **Preview fresh evidence** and discard-and-resend
actions refuse on these runs: they re-read whatever the session holds right now, which is not
what this run is reviewing.

These runs are Preview and Manual only for now. If the pinned workflow version's defaults ask
for Live delivery or Foreman completion, the request is refused rather than quietly downgraded
to Preview - being handed a review that silently never reaches the session would be worse than
being told no.

Run detail names the feature that started a run, matched on that run's own source, so an
ordinary manual run on the same session is never labelled as someone else's. Reset removes the
claim with the rest of the run family.

### Repair resumption

A review that asks for changes is only half a loop. The other half is what happens once the
session has made them - and until version 7 the answer was *nothing*, unless the binding was
Foreman-complete. The repair packet was typed into the pane, the agent fixed the work, and the
run sat in `waiting_for_session` until a human opened the Runs page and clicked resubmit.

**Repair resumption** closes it. It is an immutable part of each published version, `auto` or
`manual`, and it is `auto` for every workflow you create. Versions published before it existed
read as `manual`, so nothing you are already bound to changes behaviour under you.

Under `auto` the daemon watches its own parked runs. When the bound session has been idle for
the settle window, is not waiting on you, has been handed its packet, and the **repository has
changed**, the run opens the next repair round by itself - fresh evidence, same graph, the
round counter and `Max repair rounds` budget it always had.

Four things it deliberately does not do:

- **It does not ask the model to signal anything.** The instruction that used to end every
  repair packet is gone; the loop is closed by the daemon observing work, not by an agent
  remembering to report it. That is what makes it work for a session with no work queue, a
  harness with no hooks, and an installation with Foreman switched off - none of which could
  ever produce a completion claim.
- **It does not resume on a transcript that merely grew.** Delivering the packet is itself a
  transcript write, so the anchor moves before the agent has done anything. Resumption is
  gated on the repository: a repair that changed no code is not a repair, and resubmitting
  byte-identical work into the same reviewers would spend the whole budget proving nothing.
- **It does not touch a run waiting for a new pushed head.** The `inspector_only` findings
  policy already resumes on its own, when the Inspector observes a head that is not the failed
  one, and that remains its business.
- **It does not fire under Preview delivery.** Preview stores the repair packet and never
  types it, so the agent has not been told what to fix. Resuming there would spend every round
  in the budget re-reviewing work nobody asked to be changed, without a single packet reaching
  a screen. A Preview run still waits for you, which is what Preview means. Auto-resumption is
  therefore a **Live** behaviour in practice, the same boundary automatic PR preparation sits
  behind.
- **It does not become a silent loop.** A reviewer that rejects the same work two rounds
  running raises a **repeat offender** alert - attention-level, so it breaks through even
  while you're [away](attention-and-alerts.md#away-mode). It is edge-triggered on the streak *growing*, so it
  announces once per round it burns rather than every tick, and a third rejection is still
  news after the second. The daemon computes it, which is the point: a run burning its budget
  unattended is exactly the case where no tab is open to notice.

`Max repair rounds` is the budget, and exhausting it blocks the run exactly as it always did.

Automatic **pull request** preparation is the same idea one stage later, and it is Live-only
for a reason that is not a preference: preparing a PR means typing into the session, and
Preview is defined as performing no keystroke injection at all. A Preview binding that reaches
the missing-PR gate records why it deferred rather than appearing to do nothing.

### Blocked runs are recoverable, not terminal

A check runs in a **pooled worktree**, and a check that times out is terminated by process
group. When that group cannot be proven gone, the worktree cannot be handed back, and the run
blocks rather than reporting a result it cannot account for - something may still be writing
into the tree the verdict came from. The run reads **Blocked**, phase `check_cleanup_unresolved`.

That block is meant to clear itself, and now does. The pool's reclamation pass keeps asking
whether the group has gone and hands the tree back when it can prove it; on the next sweep the
run **resumes on its own** - the retry the block withheld is scheduled against the same
evidence and the same round, and the timeline records **Check cleanup resolved**. A node that
had already spent every infrastructure attempt moves to `infrastructure_error` instead, which
is the phase **Retry provider call** belongs to.

Blocked is also no longer a dead end in the header. A resubmission is offered for a blocked
run, not only a parked one, because the daemon has always accepted one for both - so a run
blocked on a fault that has since cleared, `check_cleanup_unresolved` once its pooled worktree
came back, is recoverable from the page rather than reading as terminal.

### Live repair delivery and Foreman completion

Live workflow delivery is **on by default, and authorised nowhere**. Those are two halves of
one gate, and only the second one is consent: the switch says *this machine may type repair
packets into panes*, and the **Workflows** grant says *in these repositories*. The grant
ships empty, so a fresh install delivers nothing until you name a repository. Open
**Settings → Trust** (`#/settings/trust`), add a canonical repository root, and click its
**Workflows act** cell. **Settings → Workflows** (`#/settings/workflows`) holds the switch and
reports how many repositories hold the grant, with a link into the matrix.

It is that way round because two gates that both default closed means the second one never
gets read. With Live off by default the loop below was dead on arrival for everyone - the
packet was prepared, never sent, and the run parked forever - while the allowlist was already
carrying the consent the switch looked like it was carrying. A run that has nowhere to deliver
says so: the refusal is `live_not_authorized` on the run, not silence.

A Live binding can be saved only while its current session is in a granted checkout. Revoking
consent keeps the binding choice visible but refuses the next delivery; it is never silently
changed to Preview. The Workflows panel holds the second, independent switch for
[Check nodes](#check-nodes), which shares that one grant and is still
**off** by default, because it grants something different in kind: running branch-authored code
on your disk, rather than typing text a human can read before it acts. One cell in Trust,
two capabilities, each still armed by its own switch - which is why the cell's tooltip names
both, and why revoking it stops delivery and checks together.

When a Persona failure returns to Session, the daemon renders one bounded deterministic repair
packet in published graph order. The packet preserves the original raw goal, identifies the
immutable workflow version and evidence fingerprint, and includes only failed Persona findings.
Preview stores the exact packet and hash without touching the terminal. Live records
**Prepared**, claims **Sending**, and uses the same pane-locked prompt injection as dispatch and
the work queue. Confirmed delivery is credited to `workflow` in the transcript. A positive
pre-write refusal can be retried explicitly; a lost or possibly-landed write becomes
**Delivery uncertain** and is never sent again automatically. Inspect the pane, then either
mark it delivered or type the required confirmation to discard it and create a new repair
round.

**Foreman complete** lets an active binding claim Foreman's existing queue-drain or prompted
completion proof. Foreman still runs as a separate HTTP-only worker and never reads workflow
SQLite. The daemon creates or resumes the durable workflow and retires the matching Foreman
once-only guard in one transaction. A missing or failed claim endpoint fails closed - Foreman
does not fall through to an unreviewed wrap-up. If no Foreman binding claims the boundary,
the existing wrap-up behavior is unchanged.

#### The repair loop, end to end

One confirmed Live delivery re-arms **exactly one** completion episode - drain when the session
has queue items, prompted when it does not. Exactly one, because re-arming both would let a
single repair packet produce two completion claims and therefore two review rounds for one fix.
So the whole cycle runs without you:

1. A Persona (or a [Check](#check-nodes)) fails. The run parks in
   `waiting_for_session` and the repair packet is typed into the pane.
2. Confirming that delivery re-arms one Foreman completion episode.
3. The session makes the change and goes idle.
4. Foreman notices, claims the completion, and opens round N+1.
5. The graph re-runs **from the top** - every reviewer, against fresh evidence. Attempts are
   keyed by submission, so round N+1 starts with an empty slate rather than resuming round N.

**Expect roughly fourteen seconds of apparent silence at step 4**, and know that it is the
design rather than a hang. Foreman's loop ticks every four seconds and a session must be
settled-idle for ten before it counts as finished, so a new round cannot start sooner. Nothing
is broken during that pause; the run is simply waiting for the session to hold still.

**The loop does not advance without the Foreman worker running.** Foreman is a separate process
(`npm run foreman`), not part of the daemon, and the completion claim comes from it. Enabled
with no worker running is enabled and idle - the **Foreman** control in the top bar reports
whether a worker actually holds the lease. [Repair resumption](#repair-resumption) is the other
route to round N+1 and needs no worker at all, which is why an `auto` version keeps moving on a
machine where Foreman was never started.

If a session signals completion having changed **nothing**, the round is refused rather than
re-reviewed - the same bytes would return the same verdict. The refusal is not silent: the
session gets a packet saying the evidence fingerprint is identical, naming what the last review
asked for, and stating that the only two acceptable answers are to make the change or to say why
it should not be made. That happens at most **twice**. A third consecutive unchanged completion
blocks the run for you to resolve, and any round that captures a real change resets the count.

### Inspector final gate

An Inspector completion policy adds a final stage after a successful End. End stays successful,
but the run does not complete until Inspector has reviewed the exact PR head represented by that
submission. A PR URL on the session is only a lookup hint. The gate can use it only when the
durable Inspector ledger already says the hook saw `gh pr create`. A URL alone never adopts a
pull request and never grants permission to comment on it.

Gate entry records the local committed HEAD, then waits for a normal Inspector sweep observed
after entry. It does not start a second GitHub poller. The observed PR must still be open, its
remote head must equal that captured HEAD, and the captured working tree must have no staged,
unstaged, or untracked changes outside the commit. A dirty tree requires commit, push, and a fresh
full submission. A pre-pin mismatch waits for Inspector to observe the captured committed head; a
push after pinning requires a fresh full submission. A stale ledger timestamp or reviewed head
alone, including one loaded after a daemon restart, cannot satisfy the gate; the next normal
Inspector observation must first prove which head is current.

Once the matching head is pinned, the durable Inspector ledger decides the state:

- A pending, failed, or backed-off review remains waiting and shows its current posture and retry.
- Every non-resolved Inspector row remains a finding, including dry-run drafts and interrupted
  posting rows. Run detail shows its stored scrubbed body, or an explicit fallback for legacy rows.
- A completed current-head review with zero findings completes the workflow.
- Closing or switching the PR blocks instead of accepting old approval.

Findings produce one frozen, bounded, hashed `inspector_feedback` packet through the same Preview
or safe Live delivery state machine as Persona repair. The published default,
`restart_workflow`, requires fix, verify, commit, push, and a full resubmission that reruns every
Persona. The narrower `inspector_only` policy waits for Inspector to observe a different pushed
head, records an immutable attempt-free bypass submission, and reviews that head normally. It
refuses the failed head, every prior repair head, PR switching, and the round cap. Run detail
labels the Persona bypass and offers an explicit confirmed restart of the full workflow.

If no adopted PR exists, the published policy waits, offers **Prepare PR in session**, or prepares
it automatically. The latter two use the same deterministic commit, push, and PR prompt; the gate
itself never pushes or opens a pull request. The offered action prepares the packet under Preview
or sends it under Live delivery. Automatic preparation is scheduled only for a Live binding.
When that handoff opens an already-reviewed clean commit, its durable adoption record pins the PR.
The record must belong to the bound session, match its exact known repository root, and have been
adopted after gate entry, so an older PR or one from a nested checkout is never claimed.
After the handoff turn settles, unchanged repository evidence advances the gate to a fresh Inspector
observation without spending another Persona round. If PR preparation changed the head, the normal
full resubmission requirement still applies. The durable adoption also preserves the workflow's
Shipping veto across a daemon or SDK-session restart before the gate has pinned the PR key.
**Recheck Inspector** only reevaluates the current durable observation and remains waiting until
Inspector's normal sweep has seen a new head.

Gate summaries travel on the existing workflow-run SSE upsert. Finding bodies and full audit
state stay on the selected run's HTTP detail, so the browser adds no polling. Reset removes the
session-bound workflow gate, submissions, packets, and events, but retains Inspector's adopted PR
and comment ledgers because those records outlive a session.

### Retention, history, exports, and workflow health

Workflow retention is configured under **Settings → Workflows**. It has two stages:

1. Raw evidence is compacted from eligible completed or cancelled runs after 30 days by default.
   The diff, transcript, status paths, standards bodies, and delivered or refused packet text are
   removed. Their hashes, counts, truncation flags, HEAD, branch, timestamps, goals, decisions,
   compacted constraints, immutable Persona snapshots, verdicts, Inspector fingerprints,
   delivery state, event history, and model-call records remain.
2. A complete eligible run family can be removed after 180 days, but only when it is also outside
   the newest 1,000 completed or cancelled runs.

The settings allow 1–365 raw-evidence days, 30–3,650 completed-run days, and a newest-run cap of
100–10,000. Shortening any boundary requires confirmation. Active, waiting, blocked, failed,
orphaned, and delivery-uncertain work is never age-pruned. In particular, an uncertain delivery
keeps its exact payload until a human resolves it. The daemon runs one non-overlapping sweep after
workflow recovery and then hourly. A sweep failure stops only that sweep and appears in Workflow
health; it never stops execution or delivery.

The panel shows those limits **against a measurement**: how many finished runs the newest-kept
cap actually ranks, and what the last sweep compacted and deleted (or that no sweep has run
yet). That figure counts only the population the cap windows - completed or cancelled, with a
completion time, and not pinned by an uncertain delivery - so it is comparable with the limit
beside it. It is deliberately not the **Retained runs** counter under Workflow health, which
counts every run row of any status and therefore climbs on active work no retention limit can
remove.

Run history is loaded 50 rows at a time and can be filtered by state, workflow id, or session.
Filters are part of the bookmarkable hash. A selected run stays selected as SSE updates arrive.
Events and workflow-owned model calls load in pages of at most 200 durable records. Raw run and
immutable version exports are versioned JSON downloads from the Run detail. A retained run export
marks pruned evidence explicitly, so an empty diff is never confused with a review that saw no
diff.

Workflow-owned model calls record the actual runner, model, attempt, state, timing, input bytes,
output bytes, retry, and classified error. The local runner returns text but no authoritative
price, so the monetary field remains `null` and the UI says **Cost unavailable from this runner**.
It is never displayed as zero, inferred from the fleet ledger, or estimated.

Workflow health is read under **Settings → Workflows**, and refreshes on its own while that
panel is open. It reports active runs, queued and running Persona calls, waiting, uncertain and
delivered deliveries among retained run families, Inspector gates, retained run count, recovery
time, retention time, the last retention error code, and the last compacted and deleted counts.
It contains no prompt, diff, transcript, Persona guidance, model output, or delivery payload.

Five of those counters lead as a **strip of tiles, in escalation order** - *Needs you*
(uncertain deliveries), *Waiting*, *Inspector gates*, *Active*, *Delivered* - and each tile
opens the nearest corresponding view in the
[run list](#workflow-drafts-and-published-versions), applying a status filter where one exists.
*Active* counts every run that has not finished - running, waiting and blocked alike - so it
deliberately carries no status filter: no single run status means "active", and one would
exclude rows the tile had just counted.
The rest stay as a plain list beneath it: they are throughput and sweep bookkeeping, and
rendering them in the same weight as "a repair may or may not have been typed into somebody's
session" was what made the one counter that needs a human the least findable thing on the
panel. **Delivered** is the fleet-wide count of deliveries confirmed typed into a session
among run families retention still keeps. Compaction does not reduce it, because a compacted
delivery keeps its state and loses only its content. Full run-family deletion does reduce it:
once a finished family is older than `completedRunDays`, outside the newest
`maxCompletedRuns`, and not pinned by an uncertain delivery, retention deletes its delivery
rows too.

For an offline backup, stop Mission Control and copy
`$MISSION_HOME/harness.db` (by default `~/.mission-control/harness.db`) together with its `-wal`
and `-shm` files when present. Run and version exports are portable audit artifacts, not a database
restore format. Restore the SQLite files only into a stopped daemon using the same or a newer
Mission Control build.

### Canvas and accessibility controls

Palette buttons add a node at the current viewport center; pointer drag remains available.
The canvas snaps to its visible grid and includes zoom in, zoom out, fit, 100% reset, and a
pannable minimap. **Auto-layout** changes positions only, then fits once. Local draft undo and redo
hold the last 50 meaningful edits and use <kbd>⌘/Ctrl</kbd><kbd>Z</kbd> and
<kbd>⌘/Ctrl</kbd><kbd>Shift</kbd><kbd>Z</kbd>. Autosave does not consume history entries.
Duplicate applies to Persona, Check, Join, and End nodes, never Session.

Tab enters the graph through one roving node focus. Selected nodes move one grid unit with an Arrow
key and ten grid units with Shift+Arrow. Press <kbd>C</kbd> on one selected non-terminal node, or choose
**Connect…**, to open the keyboard connection form; it uses the same port validator as pointer
connections. Delete or Backspace shows the number of selected nodes and connected edges before
removal. Every edge is also focusable and removable in the Properties drawer. Port names appear
on hover and focus, failure paths are dashed and text-labelled, state changes use live regions,
focus returns after dialogs, and reduced-motion preferences disable canvas and panel animation.
At narrow widths the canvas stays primary and Library and Properties become mutually exclusive
drawers.
