# Foreman upgrades — opportunities to expand the auto-responder

Status: backlog / ideas
Owner: ai-harness (Mission Control)
Related: `docs/plans/foreman/plan.md` (the shipped design), `docs/plans/foreman-watcher/plan.md`
(the cheap-watcher token optimization — first item below, planned in detail).

This doc captures a comparison of Foreman against [`firstmate`](https://github.com/kunchenguid/firstmate)
and a ranked list of ways to grow Foreman's capabilities. It's a living backlog, not a
committed plan; individual items graduate into `docs/plans/**` when we pick them up.

## The two systems, briefly

- **Foreman** (this repo) is a *queue-draining auto-responder* bolted onto a GUI dashboard:
  it watches the `needs-you` queue, reviews each blocked Claude session in a fresh `claude -p`
  process, and answers / escalates / skips. GUI-native, one global poll loop. It owns **one
  slice** of the fleet-supervision problem — the "this session is blocked, what do I say?"
  moment — and owns it as engineered, tested code with a dry-run→semi-auto→live trust ladder
  and prompt-injection-hardened reviews (`--tools ""`, fresh context per session).
- **firstmate** is a *conversational fleet commander*: you talk to one agent, it dispatches a
  crew into isolated git worktrees, watches them with a zero-token bash watcher, and escalates
  only real decisions. Terminal-native, harness-agnostic (Claude Code, Grok, Pi, Codex,
  OpenCode), no GUI. It owns the **whole task lifecycle**: dispatch → supervise → deliver
  (ship/scout) → capture knowledge (`/stow`) → away-mode (`/afk`).

They aim at the same target — supervise a fleet, bother the human only for genuine decisions —
from opposite ends. Foreman is deeper on the triage moment; firstmate is broader across the
lifecycle. Most of the ideas below are about borrowing firstmate's breadth without giving up
Foreman's engineering rigor.

## Capability comparison

| Dimension | firstmate | Foreman (today) |
|---|---|---|
| Interaction model | Chat with one supervisor | Watch a board + a background bot |
| Dispatch new work | Core (`fm-spawn.sh`, worktree per task, ship/scout types) | No — only reacts to already-running sessions (dashboard has dispatch, Foreman doesn't drive it) |
| Triage blocked sessions | Via watcher + protocol | Its whole job (answer/escalate/skip) |
| Cost of supervision | Zero-token bash watcher absorbs benign wakes | Tiered gate (#1, shipped): zero-token Tier 0, cheap Haiku Tier 1, full `claude -p` only for real judgment - in `shadow` until measured |
| Away mode | `/afk` daemon: batches, defers, flushes on return | Shipped (dashboard-side): daemon-owned away mode buffers informational events and flushes one digest on return; only blockers break through. Foreman's own autonomy is unchanged by it |
| Knowledge capture / learning | `/stow` routes durable facts to canonical homes | Notes are ephemeral triage aids; no feedback loop |
| Turn-end safety | Backstop blocks blind exit while work in flight | Partial: the `unfinished-work` stall rule (`src/shared/stall.ts`) flags a session idle with a task or queue still open, but only reports it - no recovery playbook |
| Cross-session awareness | Serializes same-file tasks, `blocked-by` | Each session reviewed in isolation |
| Multi-harness | Claude, Grok, Pi, Codex, OpenCode | Claude plus Mission Control-launched Codex; operator-started Codex remains human-operated because its hooks are launch-scoped |
| Domain specialization | Secondmates (persistent scoped supervisors) | One global policy/allowlist |
| External channels | X-mode (bounded public replies) | In-app + browser notification only |

Where Foreman is *ahead*: fresh-context-per-review with injection hardening, a real GUI with a
per-card audit trail, the trust ladder, and mid-review re-validation against a fresh snapshot.
firstmate's supervision is largely prompt/protocol; Foreman's is code with tests.

## Ranked opportunities

### 1. Cheap "watcher tier" before the expensive review — cost + latency
**Shipped (Tiers 0 + 1), in `shadow` mode by default - see `docs/plans/foreman-watcher/plan.md`.**
What remains of this item is the rollout, not the build: shadow logs every divergence between the
cheap tier and the full review, and `triage: 'on'` gets flipped only once `cheap-over-eager` is
near zero. The original case, for the record: firstmate's watcher absorbs routine
wakes in pure bash for zero tokens; Foreman spends a full model review on *every* new blocked
marker, including obvious repeats and structurally-human-only surfaces. Add a tiered gate: (Tier
0) pure-code disposal of structurally-known cases in `worker.ts` before any model call, (Tier 1)
a cheap Haiku triage on a trimmed transcript that routes down to skip/escalate or a bounded
routine-access answer, and (Tier 2) the existing full Opus review only for what genuinely needs
judgment. Asymmetric by design: the cheap tier may only *reduce* risk (skip/escalate/defer up),
never invent a substantive answer. Roll out in shadow mode first. *(The 1-minute per-session
evaluation debounce was the first concrete step; the tiers landed on top of it.)*

### 2. Away mode with a batched flush digest — biggest UX win
**Batching + digest shipped as dashboard away mode - see `docs/plans/away-mode/plan.md`.** Away
state is daemon-owned, informational events buffer instead of firing an alert each, and on return
you get one ranked digest; anything blocked on you still breaks through immediately.
What remains here is the *Foreman* half: raising its autonomy within the existing safety rails
while you're away (never auto-approving destructive/security actions), so the digest can also say
"here's what I answered, here's the N calls I saved for you." Pairs naturally with a mobile push
channel (the `PushNotification` capability already exists).

### 3. Learning loop from accept/reject decisions — quality compounds
Every review starts cold from the same `POLICY` string. Foreman already produces the signals —
Approve/Dismiss on a note, resolved reviews — and since the Foreman log
(`docs/plans/foreman-log/plan.md`) it also *keeps* them: `foreman_episodes` records each
decision with the ask, the verdict and who resolved it. Nothing reads them back into a review.
Route them into a
per-repo/global learnings store and inject the relevant entries into `buildReviewPrompt`. e.g.
"in repo X, dependency installs are always approved," "this user prefers a unified abstraction
over per-case picks." Foreman gets more right per week without prompt edits. firstmate's `/stow`
is the analog (it routes durable facts to `captain.md` / `learnings.md`).

### 4. Foreman as dispatcher, not just responder — biggest capability jump
The dashboard already indexes workspace repos and opens terminal panes. Give Foreman a backlog:
hand it a task, it spins up a session in an isolated worktree, seeds the prompt, and supervises
it through the loop it already runs. Closes the gap from "auto-responder" to firstmate's
"auto-supervisor," reusing dispatch we've already built. Adopt firstmate's **ship vs scout**
distinction so escalation policy differs by deliverable type (PR/merge vs report).

### 5. Codex support — shipped within the launch-scoped boundary
See [Foreman](../docs/foreman.md#foreman-auto-responder) and
[Work queues](../docs/work-queues.md#work-queues-load-a-session-up-and-walk-away) for the current support
contract and launch-scoped authorization boundary.

### 6. Turn-end / wedged-session recovery — reliability
firstmate refuses to let a session exit blind while work is in flight. Foreman only looks at
`needs-you`; it's blind to a session that idled or died with uncommitted changes, an unpushed
branch, or a failing gate. **The detector shipped** as the `unfinished-work` stall rule
(`src/shared/stall.ts`), which surfaces a session idle past a threshold with a task or queue
still open against it. What remains is the recovery playbook (re-engage or escalate) and the
richer signals - uncommitted changes, an unpushed branch, a failing gate - that the stall rule
does not inspect.

### 7. Cross-session collision awareness
firstmate serializes tasks touching the same files/subsystem and records `blocked-by`. Foreman
reviews each session in a vacuum. It could detect two sessions racing on the same repo/paths and
escalate or serialize rather than answer both into a conflict.

### 8. Domain-scoped policies — lightweight secondmates
Instead of one global allowlist + mode, allow per-repo or per-domain Foreman policies (different
autonomy, access rules, prompt emphasis). Same idea as secondmates without the full isolated-home
machinery.

### 9. Two-way escalation over external channels
firstmate's X-mode answers public mentions; the generalization for Foreman is routing an
escalation to Slack/mobile *and accepting the answer back*. Answer a blocked session from your
phone without opening the dashboard. (The Slack MCP is already available.)

## Suggested sequencing

1. **#1 (cheap watcher)** - the enabler that keeps everything else affordable. Shipped: the
   1-minute debounce, then Tiers 0 + 1 (`docs/plans/foreman-watcher/plan.md`), now running in
   `shadow` until the divergence data earns `triage: 'on'`.
2. **#2 (away digest)** - the batching/digest half shipped; the Foreman-autonomy half is open -
   and **#3 (learning loop)** — immediate felt value.
3. **#4 (dispatch)** — the strategic leap that makes Foreman a real supervisor, not a triager.
4. **#6 (wedged recovery)** — reliability once the core is richer.
