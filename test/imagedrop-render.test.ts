import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { withOverlayHost } from "./helpers/overlay-host.ts";
import {
  AttachmentStrip,
  readyAttachments,
  revokeAttachments,
  type PendingAttachment,
} from "../src/web/components/ImageDrop.tsx";
import { DispatchLayer } from "../src/web/components/DispatchModal.tsx";
import { AddBox } from "../src/web/components/WorkQueue.tsx";
import type { ImageDrop } from "../src/web/components/ImageDrop.tsx";

// The compose surfaces, rendered. Static markup rather than a driven browser: the
// dashboard's pages don't take script injection from the automation extension, and
// these are questions about words and structure, which markup answers honestly.
//
// What's actually at stake here is that an image never goes MISSING quietly. A chip
// that lies about its state, or a path that ships before its upload lands, both end
// the same way - an agent reading a prompt about a screenshot it was never given.

function att(over: Partial<PendingAttachment> = {}): PendingAttachment {
  return {
    id: "a1",
    name: "screenshot.png",
    previewUrl: "blob:fake",
    status: "ready",
    upload: { path: "/state/uploads/screenshot-abcd1234.png", name: "screenshot-abcd1234.png" },
    ...over,
  };
}

const strip = (list: PendingAttachment[]): string =>
  renderToStaticMarkup(createElement(AttachmentStrip, { attachments: list, onRemove: () => {} }));

test("readyAttachments: only an uploaded image has a path to cite", () => {
  // The guard that keeps a still-uploading drop out of the prompt. Sending its
  // absence is the worst outcome available: the agent gets the words and no image.
  const list = [att({ id: "a" }), att({ id: "b", status: "uploading", upload: undefined })];
  assert.deepEqual(
    readyAttachments(list).map((a) => a.name),
    ["screenshot-abcd1234.png"],
  );
});

test("readyAttachments: a failed upload is never cited", () => {
  const failed = att({ status: "error", error: "not a recognised image", upload: undefined });
  assert.deepEqual(readyAttachments([failed]), []);
});

test("workflow draft owners can revoke every preview URL without a DOM", () => {
  const revoked: string[] = [];
  const original = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => revoked.push(url);
  try {
    revokeAttachments([att({ id: "a", previewUrl: "blob:a" }), att({ id: "b", previewUrl: "blob:b" })]);
  } finally {
    URL.revokeObjectURL = original;
  }
  assert.deepEqual(revoked, ["blob:a", "blob:b"]);
});

test("an empty strip renders nothing at all", () => {
  // No stray empty list padding the compose box before anything is dropped.
  assert.equal(strip([]), "");
});

test("a chip names the file the human recognises, not the one on disk", () => {
  // The stored name is salted for uniqueness; "screenshot-abcd1234.png" is not what
  // they dropped, and the chip is for them.
  const html = strip([att()]);
  assert.match(html, /screenshot\.png/);
  assert.ok(!html.includes("abcd1234"), html);
});

test("a failed chip says why, without needing a hover", () => {
  // The error IS the reason the chip is still on screen; hiding it in a tooltip
  // leaves a chip that just looks stuck.
  const html = strip([att({ status: "error", error: "image is larger than 10MB", upload: undefined })]);
  assert.match(html, /image is larger than 10MB/);
  assert.match(html, /is-error/);
});

test("each chip state is legible to CSS", () => {
  assert.match(strip([att({ status: "uploading", upload: undefined })]), /is-uploading/);
  assert.match(strip([att()]), /is-ready/);
});

test("a ready chip carries a named preview control around its thumbnail and filename", () => {
  // The gesture is a double-click, which no markup can show and no keyboard can perform.
  // This is the half that survives both: a real button, named after the file, so the
  // feature has a keyboard and screen-reader route at all - and so an e2e spec can select
  // it without the `data-testid` the project forbids.
  const html = strip([att()]);

  assert.match(html, /<button[^>]*class="attach-open"[^>]*aria-label="Preview screenshot\.png"/);
  // Both halves of the chip are inside it, so the gesture works anywhere but the ✕.
  const open = html.match(/<button[^>]*class="attach-open"[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.match(open, /class="attach-thumb"/);
  assert.match(open, /class="attach-name">screenshot\.png</);
  // The remove button stays OUTSIDE it. Nested buttons are invalid, and a ✕ inside the
  // preview control would open a preview of the file it just removed.
  assert.doesNotMatch(open, /attach-remove/);
});

test("a refused chip offers no preview, because there is nothing to show", () => {
  // The error branch never had a thumbnail - the file is usually one the browser cannot
  // paint - so a preview control here would open a dialog onto a broken image.
  const html = strip([att({ status: "error", error: "not a recognised image", upload: undefined })]);

  assert.doesNotMatch(html, /attach-open/);
  assert.doesNotMatch(html, /aria-label="Preview /);
  // What it does keep: the reason, and the way to dismiss it.
  assert.match(html, /not a recognised image/);
  assert.match(html, /aria-label="Remove screenshot\.png"/);
});

test("the strip renders no dialog until one is asked for", () => {
  // The preview is state, not markup that is merely hidden. A dialog present-but-hidden
  // would sit in the accessibility tree of every compose box with an attachment on it.
  const html = strip([att(), att({ id: "a2", name: "second.png" })]);

  assert.doesNotMatch(html, /modal-backdrop/);
  assert.doesNotMatch(html, /attach-preview/);
  // And when one does open it is a SIBLING of the list, never a child: `<ul>` takes only
  // `<li>`, `<script>` and `<template>`, so a dialog inside it is invalid structure that
  // assistive technology walks as one more attachment. Pinned on the closing tag, because
  // that is the character a careless edit moves.
  assert.match(html, /<\/ul>$/);
  // Two chips, two distinguishable preview controls: the accessible name is the only
  // thing telling them apart, since both faces are a thumbnail and a truncated name.
  assert.match(html, /aria-label="Preview screenshot\.png"/);
  assert.match(html, /aria-label="Preview second\.png"/);
});

test("every chip can be taken back off, by name", () => {
  const html = strip([att()]);
  assert.match(html, /aria-label="Remove screenshot\.png"/);
});

test("the dispatch task box advertises that it takes images", () => {
  // Hosted because the modal is an <Overlay>; see helpers/overlay-host.
  const html = renderToStaticMarkup(
    withOverlayHost(createElement(DispatchLayer, { open: true, editTask: null, onClose: () => {} })),
  );
  assert.match(html, /drop or paste images to attach them/);
  assert.match(html, /drop-zone/);
});

test("a closed dispatch layer renders nothing", () => {
  const html = renderToStaticMarkup(
    withOverlayHost(createElement(DispatchLayer, { open: false, editTask: null, onClose: () => {} })),
  );
  assert.equal(html, "");
});

// ---- the work queue's add box ----
//
// A queued item is delivered by typing it into a pane later, exactly like a reply -
// so the same drop gesture has to mean the same thing here. The risk is the same one
// too, only worse for being deferred: an item that ships without its screenshot isn't
// noticed until an agent picks it up and asks what image.

function drop(over: Partial<ImageDrop> = {}): ImageDrop {
  return {
    dropping: false,
    uploading: false,
    addFiles: () => {},
    remove: () => {},
    dropProps: { onDragEnter: () => {}, onDragOver: () => {}, onDragLeave: () => {}, onDrop: () => {} },
    onPaste: () => {},
    ...over,
  };
}

const addBox = (over: { value?: string; attachments?: PendingAttachment[]; drop?: ImageDrop } = {}): string =>
  renderToStaticMarkup(
    createElement(AddBox, {
      value: over.value ?? "",
      onChange: () => {},
      onAdd: () => {},
      disabled: false,
      placeholder: "Queue more work…  (Enter to add, Shift+Enter for newline, drop or paste images)",
      attachments: over.attachments ?? [],
      drop: over.drop ?? drop(),
    }),
  );

test("the queue's add box advertises that it takes images", () => {
  assert.match(addBox(), /drop or paste images/);
});

test("an image alone is enough to queue an item", () => {
  // `withAttachments` makes a bare path a complete message, so requiring words here
  // would refuse an item the server would have taken - "look at this" with a picture.
  assert.ok(!addBox({ attachments: [att()] }).includes("disabled"), "Add should be live");
});

test("an empty add box offers nothing to add", () => {
  assert.match(addBox(), /disabled/);
  assert.match(addBox({ value: "   " }), /disabled/);
});

test("Add stands down while an image is still uploading, and says so", () => {
  // The deferred version of the send box's guard: queueing now stores an intent whose
  // image has no path yet, and nothing later goes back to add it.
  const html = addBox({
    value: "fix this",
    attachments: [att({ status: "uploading", upload: undefined })],
    drop: drop({ uploading: true }),
  });
  assert.match(html, /disabled/);
  assert.match(html, /Uploading…/);
});

test("the add box shows what's attached, and raises the veil on a drag", () => {
  assert.match(addBox({ attachments: [att()] }), /screenshot\.png/);
  assert.ok(!addBox({ attachments: [att()] }).includes("drop-veil"));
  assert.match(addBox({ drop: drop({ dropping: true }) }), /drop-veil/);
});
