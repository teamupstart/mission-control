import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CANONICAL_REPO,
  INSTALL_RECEIPT_SCHEMA,
  validateReceipt,
} from "../src/shared/install-receipt-schema.mjs";
import { readReceipt, receiptPath, writeReceipt } from "../src/shared/install-receipt.mjs";

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    schema: INSTALL_RECEIPT_SCHEMA,
    repo: CANONICAL_REPO,
    releaseTag: "v0.1.0",
    installedVersion: "0.1.0",
    sourceClone: "/Users/example/.mission-control/app-src",
    appPath: "/Applications/Mission Control.app",
    installedAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

function stateHome() {
  return mkdtempSync(join(tmpdir(), "mission-receipt-"));
}

test("the install receipt round-trips through the state directory", () => {
  const path = join(stateHome(), "install-receipt.json");
  const written = receipt();
  assert.equal(writeReceipt(written, path), path);
  assert.deepEqual(readReceipt(path), written);
});

test("the receipt path follows the shared state-dir resolution", () => {
  const before = process.env.MISSION_HOME;
  const home = stateHome();
  process.env.MISSION_HOME = home;
  try {
    assert.equal(receiptPath(), join(home, "install-receipt.json"));
  } finally {
    if (before === undefined) delete process.env.MISSION_HOME;
    else process.env.MISSION_HOME = before;
  }
});

test("an absent or malformed receipt reads as null rather than throwing", () => {
  const home = stateHome();
  assert.equal(readReceipt(join(home, "install-receipt.json")), null);

  const malformed = join(home, "malformed.json");
  writeFileSync(malformed, "{not json");
  assert.equal(readReceipt(malformed), null);

  const incomplete = join(home, "incomplete.json");
  writeFileSync(incomplete, JSON.stringify({ schema: 1, repo: CANONICAL_REPO }));
  assert.equal(readReceipt(incomplete), null);
});

test("a receipt from a newer schema is declined rather than guessed at", () => {
  const path = join(stateHome(), "install-receipt.json");
  writeFileSync(path, JSON.stringify(receipt({ schema: INSTALL_RECEIPT_SCHEMA + 1 })));
  assert.equal(readReceipt(path), null);
  assert.match(
    String(validateReceipt(receipt({ schema: INSTALL_RECEIPT_SCHEMA + 1 }))),
    /newer than this build understands/,
  );
});

test("an untagged install records a null release tag", () => {
  assert.equal(validateReceipt(receipt({ releaseTag: null })), null);
  assert.match(String(validateReceipt(receipt({ releaseTag: "" }))), /empty string/);
});

test("receipt validation names the field that is wrong", () => {
  assert.equal(validateReceipt(receipt()), null);
  assert.match(String(validateReceipt(null)), /not an object/);
  assert.match(String(validateReceipt([])), /not an object/);
  assert.match(String(validateReceipt(receipt({ schema: "1" }))), /positive integer/);
  assert.match(String(validateReceipt(receipt({ repo: "ai-harness" }))), /owner\/name/);
  assert.match(String(validateReceipt(receipt({ installedVersion: "" }))), /installedVersion/);
  assert.match(String(validateReceipt(receipt({ sourceClone: "app-src" }))), /absolute path/);
  assert.match(String(validateReceipt(receipt({ appPath: "Mission Control.app" }))), /absolute path/);
  assert.match(String(validateReceipt(receipt({ installedAt: "yesterday" }))), /ISO 8601/);
});

test("a rejected write leaves the previous receipt and no temp file behind", () => {
  const home = stateHome();
  const path = join(home, "install-receipt.json");
  writeReceipt(receipt(), path);
  const before = readFileSync(path, "utf8");

  assert.throws(
    () => writeReceipt(receipt({ installedAt: "yesterday" }) as never, path),
    /refusing to write an invalid install receipt/,
  );

  assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(readdirSync(home), ["install-receipt.json"]);
});

test("the trusted repository slug is exported once, from the browser-safe module", () => {
  assert.match(CANONICAL_REPO, /^[\w.-]+\/[\w.-]+$/);
});
