# Attention inbox (one place to drain what needs you)

The topbar's **to answer** count opens the **attention inbox**: one ordered queue holding
everything that is waiting on a person, so nothing depends on catching a toast or noticing a
card. Its sections are fixed and never interleave, because they are different kinds of
obligation:

1. **Decisions** - an ensemble run parked at `awaiting_decision`, with its progress dots and
   **Open dossier**. Nothing else in that run moves until it is answered.
2. **Questions from agents** - every pending [review](sessions.md#review-channel-mcp), grouped by the
   session that raised it and **answered right here**: the same card the per-session review
   modal draws, diff/plan/question and option menus included. A member of an ensemble carries
   its run context on the header line - *Best of N "Fix the parser" - candidate 3 of 5* - so
   whoever answers can tell they are steering one competitor of a comparison.
3. **Members parked on a menu** - an ensemble member sitting on a terminal
   [option menu](sessions.md#answer-a-sessions-menu-from-the-dashboard). Listed, not answered in the
   inbox: it deep-links to the session card, while the member's live lane in the run detail
   also renders the verified pane dialog in place.
4. **Stuck finalizations** - a promotion that stopped on an error.

The count is **answers owed**, not rows: a session holding three questions is one row and
three. It is a rendering of state the dashboard already has - it subscribes to nothing, decides
no severity, and is not a second notifier; [Alerts and Away mode](#alerts--away-mode) still own
what interrupts you. Escape closes it, like every overlay. Per-session entry points are
unchanged: a card's review affordance and a board tile's flag still open that session's own
review modal.

## Roundup

Click **Roundup** for a one-look snapshot of every session, assembled from the same live
data the grid shows: **who needs you** (needs-input, pending reviews, sessions sitting on an
[option menu](sessions.md#answer-a-sessions-menu-from-the-dashboard)),
**who's working** (with their intent + activity), **what's idle**, the **backlog**,
and **recent outcomes**. Dispatch a backlog task, [edit it](dispatch-and-backlog.md#edit-a-shelved-task) by
clicking its name, or drop it right from the panel, and **Mark
done** a running task with its outcome (e.g. "opened PR #123") to close the loop. **Copy as
markdown** yields a paste-able digest (also at `GET /api/report.md`; JSON at `GET
/api/report`).

The ☰ **Backlog** stage on [the Line](ui.md#the-line-the-pipeline-strip-above-the-fleet) used to
open this panel and now opens its own [drawer](ui.md#the-stage-drawers) - the queue in plan order,
which is the narrower thing that button's sentence promises. The drawer's footer escalates
here, because this is still where the backlog is read *against the rest of the fleet*: which
of those queued items is waiting on an agent that needs you, and what finished while you were
looking away. Nothing about this panel changed.

## Alerts & Away mode

So you don't have to watch the grid, the dashboard can **alert you when a session
needs you**. The daemon already streams every attention event over SSE; the browser
turns those into a **desktop (Chrome) notification + a short sound** the moment a
session goes to `needs-input`, a session stops on an
[option menu](sessions.md#answer-a-sessions-menu-from-the-dashboard) (which needs no hooks, and says
how many options it's offering), a review lands, or a
dispatched task fails. It's zero extra tokens - the daemon (not an LLM) does the
watching - and there's no phone/SMS piece; it's the open dashboard tab that alerts.

**Only things blocked on you ever interrupt.** Informational events (a session going
idle, a task finishing) are detected but never notify; they're digest material. Alerts
fire on the *transition* into attention (once, not every tick) and de-dupe, so a
waiting session pings you once. The chime is synthesized with the Web Audio API (no
asset, no network).

### Stuck sessions

The daemon also watches for sessions that have **gone quiet**, which no state
transition can announce - a stall is defined by nothing happening. Four rules, all
deterministic: an instrumented session that claims to be working but hasn't reported
in ~10 minutes; a session idle ~20 minutes with a task or queue still open against it
(the "died with work unfinished" case); and a Foreman escalation nobody answered. A stuck session is attention-level, so
it breaks through even while you're away.

### Away mode

Open the alerts control in the top bar - **🔔** when alerts are on, **🔕** when they're
muted, **🌙** once you're away. The panel is split by what owns each setting. Under
**How you're reached** sit the two delivery channels for this machine, **Desktop
notifications** (with **Enable desktop alerts** above them when the browser has not
granted permission yet - that click also unlocks the chime) and **Sound**. **Away
mode** sits below them in its own card, because it is not a third channel: it is
daemon state that survives closing the tab.

The card always states what would actually happen and names only the channels that are
live. With desktop and sound on, for example, it reads "Blockers interrupt via desktop
and sound; everything else waits in the digest". With **both channels off it says
"Nothing can reach you"** and changes colour, because away mode is not itself a delivery
path - with nothing to interrupt you on it can only hand you a digest when you get back,
and the panel never claims otherwise.

Switch away mode on and the card expands to show how long you have been gone
(`away 1h 04m`), how much has piled up (`7 buffered`), and a **Digest** button that
unfolds a preview of what is waiting. That preview is a *look*: the real digest is
written when you return, and reading it is what consumes it.

While away, anything blocked on you still notifies immediately - everything else
accumulates. When you come back, you get **one card** summarising the window: a couple
of sentences written by Haiku over what actually happened, a deterministic rollup
beneath it ("1 stuck · 3 finished"), and the per-event lines with what needs you
first. Repeats coalesce, so a session that finished twice is one line with a count,
not two notifications. A quiet window produces nothing at all.

Away state lives in the daemon, not the browser, so it survives closing the tab -
which is the case it exists for. The digest is read once; a refresh won't re-announce
it. If the provider is missing or logged out, the narrative is simply absent and the
rollup carries the summary on its own. Which model writes it is
**Settings → [Models](models.md#models-what-the-apps-own-model-work-runs-on) → Away digest**.

The count on the card comes from `GET /api/away/buffer`, a read-only look at the window
still open - deliberately a separate route from `GET /api/away/digest`, which hands the
buffer over exactly once and reports nothing at all until you are back at the desk.
