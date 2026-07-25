/**
 * What is at stake: the sentence explaining why a card is stuck has to be READABLE.
 *
 * A blocked backlog card says its state twice - a chip naming the blocker ("after X")
 * and the launch button, whose label becomes "waiting for dependencies". Both landed
 * under `.bl-card.is-blocked`, which composites the whole card at 0.72, and the button
 * carried the generic `:disabled` dimming on top of that. A container `opacity`
 * multiplies every colour beneath it, so `--dim` - the bottom of the text ramp, tuned in
 * the token block to clear 4.5:1 - arrived at 3.1:1 on the chip and 2.2:1 on the button:
 * the dimmest thing on the card was the only thing saying what was wrong. Measured in
 * the real shell, the pair now draws at 4.5:1 with the card's recession intact.
 *
 * Nothing in this repo catches that class of regression. Typecheck passes with the rule
 * deleted, every render test passes, the dashboard comes up, and the card simply goes
 * quiet again - the same silent degradation `agent-accent.test.ts` exists to stop. So
 * this pins both halves: the component emits the state, and the stylesheet still answers
 * it with the two declarations that make it legible.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BacklogColumn } from "../src/web/components/layouts/BacklogColumn.tsx";
import type { Task, TaskDependency } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
const component = readFileSync(
  fileURLToPath(new URL("../src/web/components/layouts/BacklogColumn.tsx", import.meta.url)),
  "utf8",
);
/** Prose explains the arithmetic; only the declarations are the contract. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, " ");

const noop = (): void => {};

function dependsOn(taskId: string, title: string): TaskDependency {
  return {
    type: "task",
    taskId,
    title,
    sessionId: null,
    episodeId: null,
    agentSessionId: null,
    branch: null,
    prUrl: null,
    selectedAt: 1000,
    satisfiedAt: null,
  };
}

function column(tasks: Task[]): string {
  return renderToStaticMarkup(
    createElement(BacklogColumn, {
      tasks,
      allTasks: tasks,
      plan: null,
      onAssignError: noop,
      onDragging: noop,
      onEdit: noop,
    }),
  );
}

/** A card held by an operator-declared dependency, plus the prerequisite it names. */
function blockedPair(): Task[] {
  return [
    mkTask({ id: "dep", title: "Phase 7" }),
    mkTask({ id: "held", title: "Phase 8", dependencies: [dependsOn("dep", "Phase 7")] }),
  ];
}

/**
 * One card's markup. The column draws the prerequisite too, and it is NOT blocked - so
 * a bare search of the whole column would happily read the free card's button and pass
 * on a page where the held card was never marked at all.
 */
function card(html: string, title: string): string {
  const segments = html.split(/(?=<article class="bl-card)/);
  return segments.find((s) => s.includes(`>${title}<`)) ?? "";
}

test("a card waiting on a dependency marks the button as a statement, not an inert control", () => {
  const html = column(blockedPair());
  const held = card(html, "Phase 8");
  assert.ok(held, "the held card must render");
  assert.match(held, /waiting for dependencies/, "the card must say why it is not moving");
  const launch = /<button class="bl-launch[^"]*"[^>]*>/.exec(held)?.[0] ?? "";
  assert.ok(launch, "the blocked card still draws its launch button");
  assert.match(launch, /class="bl-launch is-waiting"/, "the waiting state must be marked");
  assert.match(launch, /disabled/, "a declared dependency is policy: the button stays refused");

  // The prerequisite is ordinary work in the same column and must be untouched by any
  // of this.
  const free = card(html, "Phase 7");
  assert.match(free, /<button class="bl-launch"/, "the free card keeps the bare class");
  assert.match(free, /launch new agent/);
});

test("only waiting earns the opt-out - an ordinary disabled button keeps the generic dimming", () => {
  // `dispatching…` is a real inert control and must keep looking like one, or the
  // difference between "cannot press this yet" and "explaining itself" stops being
  // visible at all.
  const plain = column([mkTask({ id: "t1" })]);
  assert.ok(!plain.includes("is-waiting"), "an unblocked card marks nothing");
  assert.match(plain, /<button class="bl-launch"/, "and keeps the bare class");
  assert.ok(
    component.includes('className={`bl-launch${declaredBlocked && !busy ? " is-waiting" : ""}`}'),
    "a busy blocked card must keep the generic disabled treatment",
  );

  // Parked is not waiting: the hold is on the machine, so the operator's own button
  // stays live and unmarked.
  const parked = column([mkTask({ id: "t1", enabled: false })]);
  assert.ok(!parked.includes("is-waiting"));
});

test("the stylesheet still answers the class the component emits", () => {
  // The exact defect CLAUDE.md warns about: no linter notices a class that lost its rule.
  assert.match(rules, /\.bl-launch\.is-waiting:disabled\s*\{[^}]*opacity:\s*1/, [
    "The waiting label opts OUT of `.bl-launch:disabled`'s 0.6 rather than stacking it on",
    "the card's own 0.72. Without this it draws at 2.2:1 and the explanation disappears.",
  ].join(" "));

  // Both halves of "blocked" are compensated for the card's dimming, and to the SAME
  // value: the chip names the blocker and the button names the state, so the specific
  // half must not read dimmer than the generic one.
  const pair = /\.bl-blocked,\s*\.bl-launch\.is-waiting:disabled\s*\{([^}]*)\}/.exec(rules)?.[1];
  assert.ok(pair, "the blocked chip and the waiting label must share one colour declaration");
  assert.match(pair, /color:\s*color-mix\([^;]*var\(--dim\)[^;]*var\(--fg\)/, [
    "Lifted off the ramp's floor rather than set to a literal, so a retune of --dim or",
    "--fg still reaches it.",
  ].join(" "));
});

test("the card still recedes - quiet was the intent, invisible was the bug", () => {
  // If this ever becomes an alert it has overcorrected. The recession that makes a
  // blocked card read as parked work stays exactly where it was.
  assert.match(rules, /\.bl-card\.is-blocked\s*\{[^}]*opacity:\s*0\.72/);
  assert.ok(column(blockedPair()).includes("bl-card is-blocked"));
});
