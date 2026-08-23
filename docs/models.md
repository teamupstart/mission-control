# Models (what the app's own model work runs on)

Mission Control does a good deal of model work of its own - naming an untitled
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

The radio at the top of the panel is the **app-wide** provider, and every job below it starts on
*Inherit*. Any job can leave that and choose for itself, so naming a task can run on Claude while
compacting Workflow context runs on Codex. A job's own choice wins; when it has none, the app-wide
radio decides, and when that is unset too the ladder falls through to
[`MISSION_LLM_RUNNER`](configuration.md) and then the shipped default.

**Picking a provider clears nothing.** Changing the app-wide radio re-resolves only the rows still
on *Inherit* - a row that has chosen a model keeps it, because pinning a model pins its provider.

That is literal, not a figure of speech: choosing a model on an *Inherit* row **records the
provider it belongs to** in the same write, so the row stops following the app-wide picker from
that moment. Recording it then rather than inferring it later is what makes the rule hold even
when the effective provider moves with no configuration write at all - which is exactly what
`MISSION_LLM_RUNNER` changing between daemon restarts does. Clearing a model back to *Inherit*
records nothing, and a provider you set yourself is never rewritten by a model choice.

The other half of the rule is what a row's own Provider select does: because it is a statement
about exactly that row, changing it sends that row's model back to *Inherit* unless the new
provider offers the same id, and the row says what it reset. (Before this, the app-wide radio wiped
every model box on every change, which is what stopped a `claude` id from being handed to `codex`.)

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
| Workflow context | `claude-haiku-4-5` | `MISSION_WORKFLOW_CONTEXT_MODEL` | Compacts Preview evidence without replacing its preserved raw goal, decisions, and rationale |
| Ensemble evaluation | `claude-haiku-4-5` | `MISSION_ENSEMBLE_COMPARISON_MODEL` | Ranks Best-of-N candidates, mines a Consensus run's divergences, or scores one Panel-vote ballot per judge, all tool-less. A judging Persona's own model wins over this |

Each resolves the same way [Foreman's four](foreman.md#which-model-foreman-runs-as) and the
[GitHub Inspector's one](inspector-and-shipping.md#the-review-model) do: **your setting, then the environment variable, then the
shipped default**. Clearing a field means "fall back", never "run with no model" - an unset
`--model` inherits whatever the CLI happens to default to, which is the priciest tier available
and is not recorded anywhere. The panel prints which of the three won, because an environment
variable set in the daemon's shell outranks the box and would otherwise be invisible from the
browser. Each field is a select backed by the same browser model catalog as dispatch. Claude and
Codex remain on their shipped static rows; this change does not discover either provider's models
dynamically. A value saved by another version or through configuration remains selected as **not
currently reported** instead of being dropped, so catalog loading or failure cannot rewrite the
configured model.

The title, goal, digest, and Workflow-context jobs are best-effort calls with a deterministic
fallback, so a missing or logged-out provider degrades their output rather than failing a
dispatch. An Ensemble evaluation is different: a provider failure or invalid reply fails its
durable, bounded attempt, and the engine never invents a recommendation or a question set.

## Foreman's four roles

[Foreman](foreman.md) makes four distinct model calls, and they are on this page rather than in
Foreman's own panel. Review and Verify read a transcript, a diff and a policy and judge them;
Triage is the cheap router that keeps most sessions away from Review at all; Backlog reads the task
list once per change and orders it by what depends on what. Their cost profiles genuinely differ,
which is why each row carries its own provider as well as its own model - the deep pair can run on
one account while the cheap pair runs on another.

Foreman's grid leads with an **All roles** row. That is Foreman's group-level provider, and it is
what *Inherit* means on the four rows beneath it - one more rung than a background job has:

    a role's own provider  →  Foreman's All roles  →  the app-wide radio  →  MISSION_LLM_RUNNER  →  shipped default

Everything else is the same rule, deliberately: pinning a model pins its provider, changing a
row's own provider sends that row's model back to *Inherit* unless the new provider offers the same
id, and a pair no provider can honour is replaced at resolution with the row saying which id was
dropped. Changing **All roles** re-resolves only the roles still inheriting; a role that already
carries a model keeps the provider it was saved under.

That last sentence describes a **fix**, not only a rule. Before this, Foreman's panel cleared all
four model boxes whenever its provider select moved, which kept the pair valid as long as Foreman
had a provider of its own - but an unset one inherited the app-wide value, and the app-wide radio
is on a different page where Foreman's clearing never fired. An installation with role models
saved and no Foreman provider set was therefore stranded on a mismatched pair by an app-wide
change. It is not stranded now: saving a model on a role **records the provider it belongs to in
the same write**, so the pair the operator chose is still the pair in force after the radio moves,
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
which made the Inspector the one subsystem in the app that ignored the app-wide radio and
[`MISSION_LLM_RUNNER`](configuration.md) - an operator who had pinned everything to one provider
got a Claude review anyway, with nothing on screen saying so. An unset Inspector provider now
follows the same ladder as everything else on the page. **If you were relying on that fallback,
this upgrade changes which provider the Inspector spawns**; set its provider explicitly to keep
Claude.

## What is not here

A [Persona's](workflows.md) model, and an Ensemble judge's, stay on the Persona. There is one per
row and no fixed number of them, so they are a field on a definition rather than an app setting
with a place on a settings page - which is the same reason they were never moved.
