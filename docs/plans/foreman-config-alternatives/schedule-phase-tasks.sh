#!/usr/bin/env bash
#
# Create the two Foreman-settings-tabs implementation tasks, in dependency order.
#
# RUN THIS AFTER THE PLANNING PR MERGES, not before.
#
# The tasks carry paths rather than content, so the paths must be on the default branch
# before a task names them. The usual gate - making each task depend on the planning session
# so the merge releases them - was not available for this plan: the planning session had no
# `agentSessionId`, so the daemon refused a session dependency, and the task it was bound to
# was `failed`, which as a prerequisite would have stranded the phase tasks permanently.
# Creating them ungated ahead of the merge was not an option either, because backlog
# autopilot is on and would have dispatched them against a `main` with no phase files on it.
#
# Waiting for the merge removes the need for a gate entirely, which is what this does. It
# refuses to run until the phase files are actually reachable on origin/main.
#
# Usage:  bash docs/plans/foreman-config-alternatives/schedule-phase-tasks.sh
#
set -euo pipefail

DAEMON="${MISSION_DAEMON:-http://127.0.0.1:7317}"
TOKEN_FILE="${MISSION_TOKEN_FILE:-$HOME/.mission-control/token}"
REPO_ROOT="${MISSION_REPO_ROOT:-/Users/jordanmance/workspace/ai-harness}"
PLAN_DIR="docs/plans/foreman-config-alternatives"

[ -f "$TOKEN_FILE" ] || { echo "no daemon token at $TOKEN_FILE" >&2; exit 1; }
TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"

# --- refuse to schedule against paths that are not on the default branch ------------------
git fetch origin main --quiet
for f in plan.md phased-plan.md phase-1-tab-strip-and-anchors.md phase-2-blurbs-on-demand.md; do
  if ! git cat-file -e "origin/main:$PLAN_DIR/$f" 2>/dev/null; then
    echo "REFUSING: $PLAN_DIR/$f is not on origin/main yet." >&2
    echo "Merge the planning PR first - a task whose paths do not resolve carries no instructions." >&2
    exit 1
  fi
done
echo "All four artifacts are on origin/main."

python3 - "$DAEMON" "$TOKEN" "$REPO_ROOT" "$PLAN_DIR" <<'PY'
import json, sys, urllib.error, urllib.request

daemon, token, repo_root, plan_dir = sys.argv[1:5]
cwd = repo_root


def create(title, intent, deps):
    body = {
        "env": {},
        "cwd": cwd,
        "repoRoot": repo_root,
        "title": title,
        "intent": intent,
        "dependsOnTaskIds": deps,
        "dependsOnCurrentSession": False,
    }
    req = urllib.request.Request(
        f"{daemon}/mcp/tasks",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "x-harness-token": token},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f"FAILED creating {title!r}: HTTP {e.code} {e.read().decode()[:400]}", file=sys.stderr)
        raise SystemExit(1)


ROUTE = (
    "That phase file is the proposed route, not a specification: follow it where the "
    "repository agrees, use your own judgement where it does not or where a better "
    "implementation presents itself, and record any deviation and its reasoning in the "
    "pull request. Only the goal is fixed."
)

phase1 = create(
    "Implement Foreman settings tabs - Phase 1: tab strip, group table, and the deep-link contract",
    f"""Shorten the Foreman settings pane by grouping its control column into four tabs - Posture, Models, Launches, Safety - so the column is as tall as the tallest group instead of the sum of all of them. Today it is 1988px, about two and a half screens, beside a ledger that never grows.

Read `{plan_dir}/plan.md` for the approved goal, `{plan_dir}/phased-plan.md` for how the work is split, and `{plan_dir}/phase-1-tab-strip-and-anchors.md` for this phase. `{plan_dir}/option-b-tabs.html` is an interactive mockup of the target. {ROUTE}

Two things the plan treats as requirements rather than suggestions, because getting either wrong fails silently: every existing settings deep link must still open the owning tab and land on its control, and Foreman must not gain a repository editor - it shows a read-only count and links into the separate Trust category.

Implement only this phase and preserve the cross-phase contracts it names; Phase 2 owns moving the per-field prose to hover and adding the per-tab counts. Run the verification that phase file specifies, including a Playwright spec in `e2e/`, then open a reviewable pull request - its merge releases the dependent phase task.""",
    [],
)
print("Phase 1 task:", phase1["id"])

phase2 = create(
    "Implement Foreman settings tabs - Phase 2: the prose stops being printed twice",
    f"""Stop the Foreman settings pane printing every field's explanation twice, and label each tab with how many settings it holds. The blurb is already carried by a tooltip that fires on hover and on focus; the visible duplicate under each field is what keeps the panel long.

Read `{plan_dir}/plan.md` for the approved goal, `{plan_dir}/phased-plan.md` for how the work is split, and `{plan_dir}/phase-2-blurbs-on-demand.md` for this phase. {ROUTE}

No sentence may be deleted or made unreachable - moved out of view means moved into a tooltip, which is what keeps it announced to screen readers and assertable by tests in a repository with no jsdom. `ModelField` is shared with the Inspector, LLM and persona surfaces, so the change must be opt-in and leave those rendering exactly as they do today.

Implement only this phase and preserve the cross-phase contracts Phase 1 established: the tab group table, the deep-link routing, and all four tab panels staying mounted. Run the verification that phase file specifies, then open a reviewable pull request.""",
    [phase1["id"]],
)
print("Phase 2 task:", phase2["id"], "(depends on Phase 1)")
print("\nBoth tasks are in the backlog. Phase 2 is held until Phase 1's pull request merges.")
PY
