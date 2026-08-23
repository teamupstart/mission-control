import assert from "node:assert/strict";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LibraryPropertyChip,
  LibraryPropertyChips,
} from "../src/web/library/LibraryPropertyChip.tsx";
import { LibraryWorkspaceHeader } from "../src/web/library/LibraryWorkspaceHeader.tsx";
import { PipelineFrame } from "../src/web/workflows/pipeline-bits.tsx";

/**
 * The seams a guided tour reaches shared components through.
 *
 * Three components are rendered by several surfaces each - the property chip row, the
 * workspace header's promoted verb, and the pipeline strip - so which one a tour means is the
 * CALLER's to say, and the ref is an optional prop rather than a registration inside the
 * shared component. What is at stake is that the seam costs nothing when nobody uses it:
 * these assets are the Library's whole authoring surface, and a wrapper element, a changed
 * class, or a lost accessible name added "for the tour" would be a product change wearing a
 * test's clothes.
 */

const chips = (withRef: boolean): string =>
  renderToStaticMarkup(createElement(LibraryPropertyChips, {
    children: createElement(LibraryPropertyChip, {
      name: "provider",
      value: "Claude",
      tooltip: "Which runner answers for this Persona",
    }),
    ...(withRef ? { containerRef: createRef<HTMLDivElement>() } : {}),
  }));

const header = (withRef: boolean): string =>
  renderToStaticMarkup(createElement(LibraryWorkspaceHeader, {
    className: "persona-editor-head",
    title: createElement("h2", null, "Code Quality Judge"),
    menuLabel: "More Persona actions",
    primary: {
      label: "Duplicate to edit",
      hint: "Start an editable copy of this built-in Persona",
      onClick: () => {},
    },
    ...(withRef ? { primaryRef: createRef<HTMLButtonElement>() } : {}),
  }));

const frame = (withRef: boolean): string =>
  renderToStaticMarkup(createElement(PipelineFrame, {
    ariaLabel: "Workflow run pipeline",
    children: createElement("p", null, "one stage"),
    ...(withRef ? { stripRef: createRef<HTMLDivElement>() } : {}),
  }));

test("the chip row is the same element, class, and content with or without a tour ref", () => {
  assert.equal(chips(true), chips(false));
  assert.match(chips(true), /^<div class="lib-props">/);
});

test("the promoted verb keeps its element, class, label, and tooltip wiring", () => {
  assert.equal(header(true), header(false));
  const html = header(true);
  assert.match(html, /<button class="btn"[^>]*>Duplicate to edit<\/button>/);
  // No id, no data attribute, no tour-only wrapper: the button is reached by its own
  // accessible name, which is what keeps that name honest.
  assert.doesNotMatch(html, /data-testid/);
  assert.doesNotMatch(html, /data-tour/);
});

test("the pipeline strip keeps its role and accessible name for every host", () => {
  assert.equal(frame(true), frame(false));
  assert.match(
    frame(true),
    /<div class="wf-pipeline-strip" role="group" aria-label="Workflow run pipeline">/,
  );
});

test("a disabled promoted verb still renders disabled when a tour is watching it", () => {
  // The Library tour spotlights Publish and Duplicate to edit precisely BECAUSE they are the
  // disabled and the read-only control. A seam that quietly enabled one would turn a stop
  // about ownership into a button that writes.
  const disabled = renderToStaticMarkup(createElement(LibraryWorkspaceHeader, {
    className: "wf-command-editor-head",
    title: createElement("h2", null, "test"),
    menuLabel: "More Command actions",
    primary: { label: "Save Command", hint: "No unsaved changes", disabled: true, onClick: () => {} },
    primaryRef: createRef<HTMLButtonElement>(),
  }));
  assert.match(disabled, /<button class="btn" disabled=""[^>]*>Save Command<\/button>/);
});
