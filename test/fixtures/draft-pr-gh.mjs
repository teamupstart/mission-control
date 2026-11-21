// A stateful GitHub CLI boundary. It knows only argv, never Mission Control's policy.
// Omitting --draft creates a ready PR; view reads the saved creation state separately.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const path = process.env.DRAFT_PR_FIXTURE_STORE;
assert.ok(path, "an isolated PR store is required");
const prs = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
const args = process.argv.slice(2);
assert.equal(args[0], "pr");
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
if (args[1] === "create") {
  const number = prs.length + 1;
  const pr = { number, url: `https://github.example.test/fixture/repo/pull/${number}`,
    isDraft: args.includes("--draft"), state: "OPEN",
    title: option("--title") ?? "", body: option("--body") ?? "", comments: [] };
  prs.push(pr);
  writeFileSync(path, JSON.stringify(prs));
  console.log(pr.url);
} else if (["view", "edit", "comment"].includes(args[1])) {
  const pr = prs.find((item) => item.url === args[2]);
  assert.ok(pr, "a PR must exist before it can be read or updated");
  if (args[1] === "edit") {
    if (option("--title") !== undefined) pr.title = option("--title");
    if (option("--body") !== undefined) pr.body = option("--body");
  } else if (args[1] === "comment") {
    assert.ok(option("--body"), "a comment needs a body");
    pr.comments.push({ url: `${pr.url}#issuecomment-${pr.comments.length + 1}`, body: option("--body") });
  }
  if (args[1] === "view") console.log(JSON.stringify(pr));
  else {
    writeFileSync(path, JSON.stringify(prs));
    console.log(pr.url);
  }
} else {
  throw new Error(`Unexpected GitHub write or command: ${args.join(" ")}`);
}
