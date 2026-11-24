// A stateful GitHub CLI boundary. It knows only argv, never Mission Control's policy.
// Omitting -F draft=true (or --draft) creates a ready PR; view reads the saved creation state separately.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const path = process.env.DRAFT_PR_FIXTURE_STORE;
assert.ok(path, "an isolated PR store is required");
const prs = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
const args = process.argv.slice(2);
// PRs open through the REST create (`gh api repos/<o>/<r>/pulls ... --jq .html_url`), whose
// draft flag is `-F draft=true` and whose title and body are `-f title=...` and `-f body=...`.
// `gh pr create` is still understood, for a script that spells creation that way.
const restCreate = args[0] === "api" && /^repos\/[^/]+\/[^/]+\/pulls$/.test(args[1] ?? "");
assert.ok(restCreate || args[0] === "pr");
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
/** A REST `-f`/`-F` field's value, or undefined. */
const field = (name) => {
  const prefix = `${name}=`;
  const index = args.findIndex((arg, i) => arg.startsWith(prefix) && (args[i - 1] === "-f" || args[i - 1] === "-F"));
  return index < 0 ? undefined : args[index].slice(prefix.length);
};
if (restCreate || args[1] === "create") {
  const number = prs.length + 1;
  const pr = { number, url: `https://github.example.test/fixture/repo/pull/${number}`,
    isDraft: restCreate
      ? args.some((arg, i) => arg === "draft=true" && args[i - 1] === "-F")
      : args.includes("--draft"),
    state: "OPEN",
    title: (restCreate ? field("title") : option("--title")) ?? "",
    body: (restCreate ? field("body") : option("--body")) ?? "", comments: [] };
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
