import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { withChildren } from "./helpers/element.ts";
import { Tooltip } from "../src/web/components/Tooltip.tsx";

const trigger = (focusable?: boolean): string =>
  renderToStaticMarkup(withChildren(
    Tooltip,
    { label: "Outcome: merged", ...(focusable === undefined ? {} : { focusable }) },
    createElement("span", { className: "task-outcome" }, "merged"),
  ));

test("a focusable tooltip gives its non-interactive trigger the tab stop it used to write by hand", () => {
  // The markup a call site produced with `<span tabIndex={0}>` before the tooltip owned it.
  assert.match(trigger(true), /^<span class="task-outcome" aria-describedby="[^"]+" tabindex="0">merged<\/span>/);
});

test("a tooltip leaves an interactive or opted-out trigger's focus alone", () => {
  assert.doesNotMatch(trigger(), /tabindex/);
  assert.doesNotMatch(trigger(false), /tabindex/);
  const button = renderToStaticMarkup(withChildren(
    Tooltip,
    { label: "Open pull request" },
    createElement("button", { type: "button" }, "PR"),
  ));
  assert.doesNotMatch(button, /tabindex/);
});
