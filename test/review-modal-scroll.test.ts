import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A session can have many pending questions. Its review form must keep the heading and close
// action onscreen while the cards beneath them scroll, rather than relying on page scrolling
// behind the modal.
const reviewModal = readFileSync(
  fileURLToPath(new URL("../src/web/components/ReviewModal.tsx", import.meta.url)),
  "utf8",
);
const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");

test("the Needs Review modal constrains itself and scrolls its question list", () => {
  assert.match(reviewModal, /className="modal review-modal"/);
  assert.match(css, /\.review-modal\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?max-height:\s*calc\(100dvh - 96px\);/);
  assert.match(
    css,
    /\.review-modal \.modal-body\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?max-height:\s*none;[\s\S]*?overflow-y:\s*auto;/,
  );
});
