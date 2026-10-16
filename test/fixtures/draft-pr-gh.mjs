// A stateful GitHub CLI boundary. It knows only argv, never Mission Control's policy.
// Omitting --draft creates a ready PR; view reads the saved creation state separately.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const path = process.env.DRAFT_PR_FIXTURE_STORE;
assert.ok(path, "an isolated PR store is required");
const prs = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
const args = process.argv.slice(2);
assert.equal(args[0], "pr");
if (args[1] === "create") {
  const number = prs.length + 1;
  const pr = { number, url: `https://github.example.test/fixture/repo/pull/${number}`,
    isDraft: args.includes("--draft"), state: "OPEN" };
  prs.push(pr);
  writeFileSync(path, JSON.stringify(prs));
  console.log(pr.url);
} else if (args[1] === "view") {
  const pr = prs.find((item) => item.url === args[2]);
  assert.ok(pr, "view cannot succeed before creation");
  console.log(JSON.stringify(pr));
} else {
  throw new Error(`Unexpected GitHub write or command: ${args.join(" ")}`);
}
