import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { embedGuideImages } from "../scripts/embed-guide-images.mjs";

/**
 * The published guide is a SELF-CONTAINED document: its screenshots are embedded, not linked.
 *
 * Inlining trades one failure for another. A referenced figure cannot go stale but breaks when
 * the file is opened away from `docs/images/`; an embedded one always renders but forks
 * silently from the PNG `npm run docs:screenshots` regenerates. These cases hold the second
 * half of that trade, which is the half a reader cannot see.
 */

const GUIDE = fileURLToPath(new URL("../docs/setup-guide.html", import.meta.url));
const html = readFileSync(GUIDE, "utf8");
const tags = [...html.matchAll(/<img\b[^>]*>/g)].map(([tag]) => tag);
const attribute = (tag: string, name: string): string | null =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

test("every figure is embedded rather than referenced", () => {
  assert.ok(tags.length > 0, "the guide has no figures at all");
  for (const tag of tags) {
    const src = attribute(tag, "src") ?? "";
    assert.ok(
      src.startsWith("data:image/"),
      `a figure is still a file reference, so the document is not self-contained: ${src}`,
    );
    // Non-empty payload: a `data:` prefix with nothing after it renders as a broken image just
    // as surely as a missing file, and is harder to spot.
    assert.ok(src.includes(";base64,"), `figure ${src.slice(0, 40)} carries no base64 payload`);
    assert.ok(src.split(";base64,")[1]!.length > 1024, "embedded payload is implausibly small");
  }
});

test("every embedded figure still matches the committed PNG it came from", () => {
  // The staleness guard. Regenerating a figure with `npm run docs:screenshots` and forgetting
  // `npm run docs:embed` leaves the document showing the OLD picture, which no rendering check
  // can catch because the old picture renders perfectly.
  for (const tag of tags) {
    const source = attribute(tag, "data-embed");
    const recorded = attribute(tag, "data-embed-sha256");
    assert.ok(source, `an embedded figure records no data-embed source: ${tag.slice(0, 80)}`);
    assert.ok(recorded, `${source} records no data-embed-sha256`);

    const bytes = readFileSync(resolve(dirname(GUIDE), source));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      recorded,
      `${source} has changed since it was embedded - run \`npm run docs:embed\``,
    );
  }
});

test("the embedded payload is the source file, byte for byte", () => {
  // The digest above proves the SOURCE has not moved. This proves the copy in the document is
  // actually that source, so a hand-edited or truncated payload is caught too.
  for (const tag of tags) {
    const source = attribute(tag, "data-embed")!;
    const payload = attribute(tag, "src")!.split(";base64,")[1]!;
    const bytes = readFileSync(resolve(dirname(GUIDE), source));
    assert.equal(payload, bytes.toString("base64"), `${source} payload differs from the file`);
  }
});

test("re-running the generator would change nothing", () => {
  // Idempotence, asked without writing. If this fails the committed document is out of step
  // with what the generator produces, whatever the reason.
  const result = embedGuideImages({ guidePath: GUIDE, write: false });
  assert.equal(result.changed, false, "docs/setup-guide.html is not what `npm run docs:embed` produces");
  assert.equal(result.embedded.length, tags.length);
});

test("every figure keeps alt text through the rewrite", () => {
  // The generator rebuilds each tag rather than patching it, so alt text is the thing most
  // likely to be dropped by a future change to that rebuild.
  for (const tag of tags) {
    const alt = attribute(tag, "alt") ?? "";
    assert.ok(alt.length > 30, `figure ${attribute(tag, "data-embed")} lost its alt text`);
  }
});
