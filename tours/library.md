# Author what runs

## The Library
<!-- stage: library -->

The library owns components you've built, or that come with Mission Control. 

- **Missions · Sources:** Task Sources. Tasks are synced in from external systems, or scheduled Mission Control jobs.
- **Workflows:** Post-work verification. These are run after an agent has completed its work.
- **Commands:** Test, lint, anything you shell out to run.
- **Personas:** Identities for agents who act as judges during workflow runs.
- **Actions:** A prompt sent back to the session at a stage in the workflow. I.E. Create Pull Request
- **Ensembles:** Run several competing agent sessions and pick the best one, or the best ideas or components from each.

## The Persona library
<!-- stage: persona-library -->

A Persona is one reviewer's standards in Markdown. The rail groups them as System, Built-in, and Yours. Built-in may not be modified, but may be cloned and updated. Build your own, or use the standard library.

## What a Persona is, and what configures it
<!-- stage: persona-anatomy -->

A Persona has 3 components:

- **Model:** The provider + model a persona runs as
- **Markdown:** The prompt a persona gets


## Editing one
<!-- stage: persona-editing -->

Shipped roles are read-only, but you can duplicate and customize them, then add them to a custom workflow of your choice. 

## The Action library
<!-- stage: action-library -->

An Action is a reusable instruction a workflow stage sends to the bound session - open a pull request, run a migration. It does not judge or review work. 

## Optional: Associated a skill to an action
<!-- stage: action-contract -->

You may associate a specific skill to be invoked for an action (recommended). 

## A Command slot
<!-- stage: command-slot -->

Four fixed slots ship with the product - test, lint, typecheck, and build - so there is no New card here. A workflow's Command node names a portable slot and never an argv, which is what lets the same workflow run against any repository; this screen is where THIS machine says what the slot runs.

## Overrides, and saving one
<!-- stage: command-overrides -->

A repository path plus an override command writes one exception into the rules table above; everything else keeps the machine-wide default. Then Save Command - and the point is that saving executes nothing. A workflow reaching this slot, later, in a repository granted the Workflows cell in Trust, is what runs it, and Settings → Workflows → Allow workflow Commands is the machine-wide switch above that.

## The builder
<!-- stage: workflow-builder -->

A workflow is composed of Persona, Command, and Session action nodes - exactly the three assets the last three chapters covered. The rail lists what exists, tags what ships with the build, and New is where a workflow of your own starts. The node palette that adds nodes renders only in Graph view on a draft you own, so this stop names where creation begins rather than pressing it.

## Draft and published
<!-- stage: workflow-draft -->

Pipeline and Graph are two views of one workflow, and the toolbar offers both for anything open. Publish is disabled here, and that disabled control is the whole lesson: a built-in ships already published and always carries the graph this build was made from, so Duplicate is how you get a copy you own. A draft follows Library edits, a published version freezes its Persona snapshots, and publishing never changes a binding that already exists.

## No-Mistakes Review
<!-- stage: workflow-no-mistakes -->

Five stages, in order: typecheck and test together; Intent Conformance alone as a cheap gate; Code Risk and Code Quality in parallel; Test Evidence and Documentation in parallel; then the verified Pull Request action before End. Every failure returns to the session for a repair round, up to five. It is a built-in, so its versions stay addressable exactly as shipped and your changes live in a Duplicate.

## Binding it
<!-- stage: workflow-bind -->

Binding attaches a published version to one session's work in one repository. Version 10 ships Foreman-complete as its trigger, live delivery of each repair packet into the session, and five repair rounds before it stops asking.

## A run, moving
<!-- stage: run-moving -->

The same five stages, now carrying real state from a finished run of your own. Under the strip, the review worklist sorts what the reviewers actually said: Blocking is what is still open, Passed is what cleared, and an individual verdict opens in place.

## Where a run is watched
<!-- stage: run-watched -->

The same run, drawn as the vertical stage ladder in its session's Workflows tab. That is where the work is actually followed: the desk you are already reading is the one that tells you a reviewer is waiting on it.

## That is the authoring half
<!-- stage: close -->

Personas, Actions, and Commands are the parts; a workflow composes them and decides what counts as done. This tour wrote nothing: no asset was saved, duplicated, published, or bound, and no run was started. See the work, in the same Help & tours footer and the same palette group, is the other half - the Line, the Board, one session's desk, and a task from dispatch to completion.
