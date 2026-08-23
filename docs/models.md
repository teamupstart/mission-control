# Models (what the app's own model work runs on)

Mission Control does a little model work of its own - naming an untitled
[dispatch](dispatch-and-backlog.md#dispatch-an-agent), reconciling prompts with the [Goal](sessions.md#goal) on a card, narrating the
[away digest](attention-and-alerts.md#away-mode), compacting Workflow evidence, and evaluating Ensemble submissions. None
of it is the agent in a card, and none of it should have to be: **Settings → Models** is where you
say which provider does that work and which model each job uses.

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
The other half of that rule is what a row's own Provider select does: because it is a statement
about exactly that row, changing it sends that row's model back to *Inherit* unless the new
provider offers the same id, and the row says what it reset. (Before this, the app-wide radio wiped
every model box on every change, which is what stopped a `claude` id from being handed to `codex`.)

Whatever route a provider and a model arrive by - a saved config, an environment variable, an
upgrade, a hand-edited blob - a job never spawns on a pair its provider cannot honour. A model id
positively known to belong to the *other* provider is replaced with this provider's own cheap
default and the row says which id was dropped. An id in no catalog is a new or custom model and
passes through untouched, because model ids are free text.

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

**Foreman's four models and the GitHub Inspector's review model are not here.** They live with the
subsystem that spends them - **Settings → Foreman** and **Settings → GitHub Inspector** - because each
panel owns the config it writes.
