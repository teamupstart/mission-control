import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AttachmentStrip,
  readyAttachments,
  type PendingAttachment,
} from "../src/web/components/ImageDrop.tsx";
import { DispatchLayer } from "../src/web/components/DispatchModal.tsx";

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

test("every chip can be taken back off, by name", () => {
  const html = strip([att()]);
  assert.match(html, /aria-label="Remove screenshot\.png"/);
});

test("the dispatch task box advertises that it takes images", () => {
  const html = renderToStaticMarkup(createElement(DispatchLayer, { open: true, onClose: () => {} }));
  assert.match(html, /drop or paste images to attach them/);
  assert.match(html, /drop-zone/);
});

test("a closed dispatch layer renders nothing", () => {
  assert.equal(renderToStaticMarkup(createElement(DispatchLayer, { open: false, onClose: () => {} })), "");
});
