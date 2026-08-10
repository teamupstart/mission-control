# Models (what the app's own model work runs on)

Mission Control does a little model work of its own - naming an untitled
[dispatch](dispatch-and-backlog.md#dispatch-an-agent), reconciling prompts with the [Goal](sessions.md#goal) on a card, narrating the
[away digest](attention-and-alerts.md#away-mode), compacting Workflow evidence, and evaluating Ensemble submissions. None
of it is the agent in a card, and none of it should have to be: **Settings → Models** is where you
say which provider does that work and which model each job uses.

Two separate choices, deliberately.

**The provider** is app-wide - it answers *how* a model is called, not which one. Two ship: the
local `claude` CLI (the default) and `codex exec`. Claude's app-owned calls use one fresh Agent SDK
query by default, with the one-shot `claude -p` transport retained as the
[`MISSION_CLAUDE_TRANSPORT=print`](configuration.md) escape hatch. Either way there is no API key anywhere in this
path - each bills through whatever its own CLI is logged in as. It is entirely
independent of which harness a card runs, which is the point - you can review a Codex session with
Claude, or run the cheap jobs on the account that has quota left. Picking a provider clears the
model boxes below it, because a `claude` model id is not something `codex` can resolve.

**The model** is per job:

| Job | Default | Env | What it does |
|---|---|---|---|
| Task title | `claude-haiku-4-5` | `MISSION_TASK_TITLE_MODEL` | Names a dispatched task whose Title was left blank, for the card and the branch |
| Goal | `claude-haiku-4-5` | `MISSION_GOAL_MODEL` | Reconciles each instruction with the durable objective and derives the card sentence and tactical focus |
| Away digest | `claude-haiku-4-5` | `MISSION_AWAY_DIGEST_MODEL` | Narrates what the fleet did while you were away, over the deterministic rollup |
| Workflow context | `claude-haiku-4-5` | `MISSION_WORKFLOW_CONTEXT_MODEL` | Compacts Preview evidence without replacing its preserved raw goal, decisions, and rationale |
| Ensemble evaluation | `claude-haiku-4-5` | `MISSION_ENSEMBLE_COMPARISON_MODEL` | Ranks Best-of-N candidates, mines a Consensus run's divergences, or scores one Panel-vote ballot per judge, all tool-less. A judging Persona's own model wins over this |

Each resolves the same way [Foreman's four](foreman.md#which-model-foreman-runs-as) and the
[Inspector's one](inspector-and-shipping.md#the-review-model) do: **your setting, then the environment variable, then the
shipped default**. Clearing a field means "fall back", never "run with no model" - an unset
`--model` inherits whatever the CLI happens to default to, which is the priciest tier available
and is not recorded anywhere. The panel prints which of the three won, because an environment
variable set in the daemon's shell outranks the box and would otherwise be invisible from the
browser. Any id the selected provider's CLI accepts works; the fields are free text, not a fixed
list, with suggestions offered for whichever provider is in force.

The title, goal, digest, and Workflow-context jobs are best-effort calls with a deterministic
fallback, so a missing or logged-out provider degrades their output rather than failing a
dispatch. An Ensemble evaluation is different: a provider failure or invalid reply fails its
durable, bounded attempt, and the engine never invents a recommendation or a question set.

**Foreman's four models and the Inspector's review model are not here.** They live with the
subsystem that spends them - **Settings → Foreman** and **Settings → Inspector** - because each
panel owns the config it writes.
