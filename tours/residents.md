# Meet your residents

## Agents that stay on the job
<!-- stage: residents -->

A resident is a long-running agent with a standing role. You author its profile once and launch it, and it runs as an ordinary session that keeps its role through compaction and restarts. It wakes on its own loop, does its job, and ends only when you choose Complete & close. This tour shows the resident that ships with Mission Control, how to change it or write your own, and where running residents live.

## Agent Shepherd ships ready to launch
<!-- stage: agent-shepherd -->

Agent Shepherd is built in and installed on every machine. It keeps your agents moving and passes the decisions only you can make through to you.

- **Unblocks stuck work:** Removes dependencies on work that already shipped, and grants repair rounds while a workflow is still finding real bugs.
- **Keeps reviews in scope:** Holds reviewers to the task's original intent and to legitimate bugs, not redesigns.
- **Asks you when it matters:** Brings decisions only a human can make to Needs you, with the context to answer quickly.
- **Steers other sessions:** Control other sessions is on, and only your own Launch click in the desktop app grants it.

## A profile is the resident's role
<!-- stage: profile -->

Everything a resident is lives in its profile. A built-in is read-only: every field is locked, and the note under its title says why.

- **Persona and instructions:** A Library Persona, Markdown instructions, or both. This is the standing role it keeps.
- **Harness, model and effort:** Claude Code or Codex, and the model and effort it runs on.
- **Workspace:** The repository Dispatch pre-fills, or none for a private working directory.
- **Loop and guardrails:** How often it wakes, and the rolling 24-hour caps on iterations and spend.
- **Authority and MCP servers:** Whether it may steer other sessions, and which MCP servers it carries.

## Make Agent Shepherd your own
<!-- stage: duplicate -->

Duplicate Agent Shepherd to customize it for your specific use case. The shipped default is a good starting point.

## Or author one from scratch
<!-- stage: new -->

Create your own custom persona's and apply them to Residents. Keep your Resident's scoped to specific domains for best results and to avoid context bloat.

## How a resident keeps working
<!-- stage: loop -->

After every turn the daemon waits the profile's cadence, then wakes the resident with its loop prompt: check what changed, act, and report one line of status. The resident may ask to wake sooner or later within the bounds set here, and the rolling caps pause it before it spends more than you allowed. A message from you always goes first, and while it waits on your answer it holds its wakes. Pause, Resume and Run now are on every surface that shows a running resident.

## Launch it
<!-- stage: launch -->

Launch opens Dispatch on this profile. Choose a repository, or No repository for a private working directory, add optional instructions for this run, and press Launch resident. This tour launches nothing; when you are ready, this button is where a resident starts.

## Open the Residents sidebar
<!-- stage: open-sidebar -->

Running residents live in the Residents sidebar, a column on the right of the fleet. Open it with this Residents button, Shift+H, Open the Residents drawer or dock in the ⌘K palette, or the edge tab on the window's right edge. If Settings > Display > Residents puts residents on the Board and in Console instead, this button and Shift+H open the Residents dock, and this tour borrows the sidebar to show it. Next opens it.

## Every resident at a glance
<!-- stage: sidebar -->

Each running resident is a card in its marker color, with its state, its loop and next wake, and Open, Run now and Pause. A resident that needs you moves to the top under Needs you, and ⌥1 to ⌥9 open residents from any page. Profiles at the foot launch one in a click, Agent Shepherd included, and Manage residents opens the profiles page. The sidebar sits beside the fleet, so nothing is covered and the fleet's keys keep working.

## Pin it open
<!-- stage: pin -->

Opened, the sidebar lasts until you close it or reload. Pin keeps it open through reloads and restarts, and closing a pinned sidebar unpins it. Settings > Display > Residents chooses where residents live: this sidebar, or the Board and Console with a Residents dock. Finish hands the fleet back to you.
