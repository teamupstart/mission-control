# Models (the app's own model work, and what each task kind dispatches on)

The page starts with **[Task kinds](#task-kinds)**, where you say which harness, model and effort
a dispatched task of each kind runs on. These are the controls people most often customize: what
does my plan launch with, and should a scout use something different from a ship?

Mission Control also does a good deal of model work of its own - naming an untitled
[dispatch](dispatch-and-backlog.md#dispatch-an-agent), reconciling prompts with the [Goal](sessions.md#goal) on a card, narrating the
[away digest](attention-and-alerts.md#away-mode), compacting Workflow evidence, evaluating Ensemble submissions, judging a
stuck session, and reviewing a pull request. None of it is the agent in a card, and none of it
should have to be: **Settings → Models** is where you say which provider does that work and which
model each call uses.

Every app-owned model choice with a fixed place in this app is on that one page, in three groups -
the [background jobs](#the-background-jobs), [Foreman's four roles](#foremans-four-roles), and
[the GitHub Inspector's review](#the-github-inspectors-review). One screen answers *what is this
app spending on its own work, and on whose account?* A [Persona's](workflows.md) model and an
Ensemble judge's are the deliberate exception, for the reason [below](#what-is-not-here).

The two groups sit on one page because the question a person arrives with is "which model runs my
planning" - being told that the app's own titling calls live here while a `plan` task's model lives
somewhere else answers a question nobody asked. Task kinds lead; the app-owned calls follow.

Two separate choices, deliberately.

**The provider** answers *how* a model is called, not which one. Two ship: the
local `claude` CLI (the default) and `codex exec`. Claude's app-owned calls use one fresh Agent SDK
query by default, with the one-shot `claude -p` transport retained as the
[`MISSION_CLAUDE_TRANSPORT=print`](configuration.md) escape hatch. Codex's app-owned calls have the same
seam: `codex exec` by default, with [`MISSION_CODEX_TRANSPORT=sdk`](configuration.md) selecting `@openai/codex-sdk` over the
same binary - a choice about how a reply is decoded, not about how it is fetched, so it changes
nothing about latency. Either way there is no API key anywhere in this
path - each bills through whatever its own CLI is logged in as. It is entirely
independent of which harness a card runs, which is the point - you can review a Codex session with
Claude, or run the cheap jobs on the account that has quota left.

Every app-owned row starts on *Inherit*. Any job can leave that and choose for itself, so naming a
task can run on Claude while compacting Workflow context runs on Codex. A job's own choice wins;
when it has none, the app-wide provider resolution falls through to
[`MISSION_LLM_RUNNER`](configuration.md) and then the shipped default. There is no separate
app-wide selector on this page because it would not customize any particular row.

That is literal, not a figure of speech: choosing a model on an *Inherit* row **records the
provider it belongs to** in the same write, so the row stops following the app-wide default from
that moment. Recording it then rather than inferring it later is what makes the rule hold even
when the effective provider moves with no configuration write at all - which is exactly what
`MISSION_LLM_RUNNER` changing between daemon restarts does. Clearing a model back to *Inherit*
records nothing, and a provider you set yourself is never rewritten by a model choice.

The other half of the rule is what a row's own Provider select does: because it is a statement
about exactly that row, changing it sends that row's model back to *Inherit* unless the new
provider offers the same id, and the row says what it reset.

Whatever route a provider and a model arrive by - a saved config, an environment variable, an
upgrade, a hand-edited blob - a job never spawns on a pair its provider cannot honour. A model id
positively known to belong to the *other* provider is replaced with this provider's own cheap
default and the row says which id was dropped. An id in no catalog is a new or custom model and
passes through untouched, because model ids are free text.

## The background jobs

**The model** is per job:

| Job | Default | Env | What it does |
|---|---|---|---|
| Task title | `claude-haiku-4-5` | `MISSION_TASK_TITLE_MODEL` | Names a dispatched task whose Title was left blank, for the card and the branch |
| Goal | `claude-haiku-4-5` | `MISSION_GOAL_MODEL` | Reconciles each instruction with the durable objective and derives the card sentence and tactical focus |
| Away digest | `claude-haiku-4-5` | `MISSION_AWAY_DIGEST_MODEL` | Narrates what the fleet did while you were away, over the deterministic rollup |
| Workflow context | `claude-haiku-4-5` | `MISSION_WORKFLOW_CONTEXT_MODEL` | Compacts Preview evidence, canonically reconciles authored criterion ids, and suggests proof classes without replacing the preserved goal, human decisions, author declarations, or deterministic readiness rules |
| Ensemble evaluation | `claude-haiku-4-5` | `MISSION_ENSEMBLE_COMPARISON_MODEL` | Ranks Best-of-N candidates, mines a Consensus run's divergences, or scores one Panel-vote ballot per judge, all tool-less. A judging Persona's own model wins over this |

Each resolves the same way [Foreman's four](foreman.md#which-model-foreman-runs-as) and the
[GitHub Inspector's one](inspector-and-shipping.md#the-review-model) do: **your setting, then the environment variable, then the
shipped default**. Clearing a field means "fall back", never "run with no model" - an unset
`--model` inherits whatever the CLI happens to default to, which is the priciest tier available
and is not recorded anywhere. The panel prints which of the three won, because an environment
variable set in the daemon's shell outranks the box and would otherwise be invisible from the
browser. Each field is a select backed by the same browser model catalog as dispatch. Codex and Pi
discover their rows from the installation and account Mission Control will actually launch; Claude
remains on its shipped static rows. A value saved by another version or through configuration
remains selected as **not currently reported** instead of being dropped, so catalog loading or
failure cannot rewrite the configured model.

The title, goal, digest, and Workflow-context jobs are best-effort calls with a deterministic
fallback, so a missing or logged-out provider degrades their output rather than failing a
dispatch. An Ensemble evaluation is different: a provider failure or invalid reply fails its
durable, bounded attempt, and the engine never invents a recommendation or a question set.

Workflow-context compaction receives only the raw/refined goal and genuine human decision content.
Repository state, transcript evidence, evidence metadata, prior Persona feedback, automated
deliveries, and author coverage stay out of stable criterion extraction. A second source-only call
receives the extracted canonical criteria plus bounded author claim ids and text, and semantically
reconciles those claims without changing the stable result. Its schema and failure boundary are
independent: an invalid reconciliation leaves the stable extraction intact and yields fail-closed
claim mappings. The daemon stores those packet-specific mappings outside the stable canonical
criterion records, deterministically remaps replacement ids by stable normalized criterion text,
and applies the fixed proof-role matrix. Same-intent evidence-preflight children reuse their
parent's stable criteria and reconcile replacement claims deterministically without either model
call. A failed stable extraction records readiness as unavailable when coverage exists, but never
blocks Phase 1 execution.

## Foreman's four roles

[Foreman](foreman.md) makes four distinct model calls, and they are on this page rather than in
Foreman's own panel. Review and Verify read a transcript, a diff and a policy and judge them;
Triage is the cheap router that keeps most sessions away from Review at all; Backlog reads the task
list once per change and orders it by what depends on what. Their cost profiles genuinely differ,
which is why each row carries its own provider as well as its own model - the deep pair can run on
one account while the cheap pair runs on another.

Foreman's grid leads with an **All roles** row. That is Foreman's group-level provider, and it is
what *Inherit* means on the four rows beneath it - one more rung than a background job has:

    a role's own provider  →  Foreman's All roles  →  app-wide default  →  MISSION_LLM_RUNNER  →  shipped default

Everything else is the same rule, deliberately: pinning a model pins its provider, changing a
row's own provider sends that row's model back to *Inherit* unless the new provider offers the same
id, and a pair no provider can honour is replaced at resolution with the row saying which id was
dropped. Changing **All roles** re-resolves only the roles still inheriting; a role that already
carries a model keeps the provider it was saved under.

A provider is recorded only by a write that reaches that pair - saving the row's model, or moving
**All roles**. Changing an unrelated Foreman setting leaves an inheriting row inheriting, so a row
that has never chosen a provider is never quietly given one. The two cases also record different
answers, on purpose: saving a model records the provider that **model** belongs to, because the
operator just chose it, while an **All roles** move records the provider the row was **running
on**. A row carrying a model saved by an older build has no recorded provider, and a group move is
not evidence about it - so it keeps the account it was already being spent on rather than being
carried somewhere it has never run.

That last sentence describes a **fix**, not only a rule. Before this, Foreman's panel cleared all
four model boxes whenever its provider select moved, which kept the pair valid as long as Foreman
had a provider of its own - but an unset one inherited the app-wide value, and changes to that
value did not pass through Foreman's clearing path. An installation with role models
saved and no Foreman provider set was therefore stranded on a mismatched pair by an app-wide
change. It is not stranded now: saving a model on a role **records the provider it belongs to in
the same write**, so the pair the operator chose is still the pair in force after the default moves,
and the role's own provider is what the row goes on showing. A model no catalog claims - a custom
or newly released id - records the provider it was chosen under instead, which is the same answer
from the only evidence there is.

The models Foreman launches a backlog *task* with are a different question - they choose what a
launched agent runs as rather than what Foreman itself spends - and stay under
**Settings → Foreman → Launches**.

## The GitHub Inspector's review

The [GitHub Inspector's](inspector-and-shipping.md#the-review-model) single review model is here
too, as a one-row grid with the same vocabulary. Whether it posts anything is Dry run versus Live,
which stays under **Settings → GitHub Inspector** with the rest of its posture.

**Leaving its provider unset now means what it says.** It used to resolve to a literal `claude`,
which made the Inspector the one subsystem in the app that ignored the app-wide default and
[`MISSION_LLM_RUNNER`](configuration.md) - an operator who had pinned everything to one provider
got a Claude review anyway, with nothing on screen saying so. An unset Inspector provider now
follows the same ladder as everything else on the page. **If you were relying on that fallback,
this upgrade changes which provider the Inspector spawns**; set its provider explicitly to keep
Claude.

**Saving its model pins its provider too**, exactly as a Foreman role's does. Choosing a Claude
review model while the provider is inherited records Claude in the same write, so a later app-wide
move to Codex cannot carry the row away from the model it was given. And if a pair no writer could
reach does turn up - a blob from an older build, a hand edit, `MISSION_LLM_RUNNER` moving between
restarts - resolution refuses it rather than spawning it, substituting a model from the same
**deep** tier and naming the dropped id on the row. A pull-request review is the only call this app
makes that writes where other people read; it is not the one to let run on a pair that cannot
exist, or to quietly downgrade to a cheap model.

## Task kinds

A dispatched **plan** can run on a different harness and model from a **ship**, chosen once here
instead of overridden by hand on every dispatch. One row per kind Mission Control launches, each
with an **Agent**, a **Model** and an **Effort**, and each of the three inheriting by default -
so an untouched installation dispatches exactly as it did before this existed.

**The three do not inherit from the same place**, and the panel's top row says which is which.
An inheriting Model or Effort falls through to that harness's default on *Settings → Harnesses*.
An inheriting **Agent** falls through to Claude, which is built in and has no setting anywhere:
there is no app-wide "default agent" to fall through to, and a harness card cannot supply one
because the question is which card to use. A row's own Agent cell is the only way to change it.

**`pipeline` has no row.** Conductor owns its downstream agent, model and effort, so a control
here could never reach the process it appears to describe. The row set is derived from the kind
registry rather than listed, so a kind added later appears (or stays out) by declaring how it
launches.

**The three are not read at the same time, and the panel says so.** A task's `model` and `effort`
are stored as *overrides* - unset means "ask at launch" - so changing a kind's model reaches a task
already waiting in the backlog. A task's `agent` is not nullable: a task must be created holding
one, so the kind's agent is read **once, when the task is filed**, and from then on the row carries
an ordinary pin. Change a kind's agent and it reaches the next task filed; the backlog stays as it
stands. This is the one asymmetry worth knowing about the feature, and it is a property of the
schema rather than a choice.

**A model belongs to one harness.** A model id is agent-namespaced - `claude-opus-4-8` is not
something Codex can run - so a row that inherits its agent cannot pin a model at all, and its Model
cell is disabled with the reason on it. For the same reason a kind's model applies only when the
task's agent *matches* the agent that row names; a task pinned to another harness falls through to
that harness's own default (*Settings → Harnesses*) rather than being handed an id it will reject.
Changing a row's Agent sends its Model back to *Inherit* unless the new harness offers the same id
- the same rule the dispatch form has always followed.

**Every effort tier is checked, including a task's own pin.** A stored effort was chosen against
some harness at some earlier moment, and neither need still be true when the task launches - a
task filed with an inherited agent had no harness to be checked against at all. A level the
target cannot offer therefore falls to the tier below it rather than being passed on the strength
of having been chosen once. A creator that names an unsupported level is refused at the door
instead, so a recurring mission set to a level its kind's harness lacks fails its run visibly
rather than filing work that launches wrong.

**An effort is portable, and checked rather than matched.** The levels are one shared vocabulary,
so `high` chosen for planning means something on any harness, and a row may set an effort while
inheriting its agent. What narrows it is a capability check at launch: the level has to be one the
target harness offers *for the model this launch resolved*. Codex drops `max` on every model but
its newest two, so a `max` set for `plan` reaches a Codex launch on one of those and falls back to
the per-harness default on the others, rather than passing a flag the CLI rejects.

**Where the kind sits in the ladder** is written out under
[Which model wins](dispatch-and-backlog.md#default-model) - below Foreman's launch-only backlog
model, above the per-harness default.

The dispatch form still overrides any of this for one task, and it names the row when the row is
what applies: the Model option reads *"Default for plan - …"* rather than a bare *"Default"* that
would be pointing at the wrong tier. Choosing a Kind moves the form's Agent select to that kind's
harness - and never over a harness you picked by hand.

A task filed with no agent named at all - an agent's own `create_task`, for instance - takes the
kind's agent rather than a hardcoded Claude.

**The durable creators inherit too.** A **Recurring Mission** and a **task source** each carry
their own Agent, and both now offer *Inherit* alongside the harnesses. Left on *Inherit*, every
task they file takes the kind's agent **as each run fires** - so repointing a kind moves work
that was scheduled months earlier, without editing the mission. Naming a harness there is a pin
and still wins, and a mission or source saved before this existed keeps the harness it names, so
nothing already scheduled moves on upgrade. The same two rules as a kind row apply: an inheriting
template cannot pin a model (a model id belongs to one harness), and it may set an effort, drawn
from the levels every harness offers, because the harness it will get is not known until the run.

## What is not here

A [Persona's](workflows.md) model, and an Ensemble judge's, stay on the Persona. There is one per
row and no fixed number of them, so they are a field on a definition rather than an app setting
with a place on a settings page - which is the same reason they were never moved.
