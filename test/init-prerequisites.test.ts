import assert from "node:assert/strict";
import test from "node:test";
import {
  chromiumPrerequisiteMessage,
  MIN_NODE_MAJOR,
  nodeMajor,
  nodePrerequisiteMessage,
} from "../scripts/init-prerequisites.mjs";

test("init prerequisite checks accept supported Node versions", () => {
  assert.equal(nodeMajor("v24.0.0"), 24);
  assert.equal(nodePrerequisiteMessage("24.0.0"), null);
  assert.equal(nodePrerequisiteMessage("26.6.0"), null);
});

test("init prerequisite checks give the Node installation fix", () => {
  assert.equal(nodeMajor("not-node"), null);
  assert.equal(
    nodePrerequisiteMessage("23.11.0"),
    `Mission Control requires Node.js ${MIN_NODE_MAJOR} or newer (found 23.11.0). Install Node.js ${MIN_NODE_MAJOR}+ and rerun \`make init\`.`,
  );
});

test("init prerequisite checks give the Playwright installation fix", () => {
  assert.equal(
    chromiumPrerequisiteMessage(),
    'Playwright Chromium is required for end-to-end tests. Run `npx playwright install chromium`, then rerun `make init ARGS="--with-e2e"`.',
  );
});
