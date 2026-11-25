import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { pull_request: pr } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { base, head } = pr;
for (const { sha } of [base, head]) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Expected exact pull request commit SHAs.");
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

const problems = [];
const agentName = /^(?:claude(?: code| (?:opus|sonnet|haiku)(?: .+)?)?|(?:openai )?codex(?: .+)?|chatgpt|(?:github )?copilot(?:-swe-agent)?(?:\[bot\])?|gemini(?: cli)?|cursor(?:agent| agent)?|pi(?: coding agent)?)$/i;
const agentEmail = /<(?:noreply@anthropic\.com|(?:\d+\+)?(?:claude(?:\[bot\])?|codex(?:\[bot\])?|copilot(?:-swe-agent)?(?:\[bot\])?)@users\.noreply\.github\.com)>$/i;
const commits = git("log", "-z", "--format=%h%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1f)", `${base.sha}..${head.sha}`).split("\0");
for (let i = 0; i < commits.length - 1; i += 2) {
  const [sha, trailers] = commits.slice(i, i + 2);
  for (const trailer of trailers.split("\x1f")) {
    const name = trailer.replace(/\s*<[^<>]+>\s*$/, "").trim();
    if (agentName.test(name) || agentEmail.test(trailer.trim())) {
      problems.push(`${sha}: remove the agent Co-authored-by trailer.`);
    }
  }
}

// The App also opens non-release automation PRs. Require its Release Please branch
// in this repository and the canonical release base. Titles and labels are editable.
const releasePr = pr.user?.login === "mission-control-release[bot]" &&
  head.repo?.full_name === base.repo.full_name &&
  base.ref === "main" && /^release-please--branches--main(?:--components--.+)?$/.test(head.ref);
const mergeBase = git("merge-base", base.sha, head.sha).trim();
const changes = git("diff", "--no-renames", "--name-status", "-z", mergeBase, head.sha, "--").split("\0");
const image = /\.(?:png|apng|jpe?g|gif|webp|avif|heic|heif|svgz?|bmp|tiff?|ico)$/i;
for (let i = 0; i < changes.length - 1; i += 2) {
  const [status, path] = changes.slice(i, i + 2);
  if (path === "CHANGELOG.md" && !releasePr) {
    problems.push("CHANGELOG.md: only Release Please pull requests may change the generated changelog.");
  }
  // The merge-base tree is the exact-path allowlist for legacy evidence, including
  // e2e/evidence and old plan evidence, verification, and shots. Renames add new paths.
  if (status === "A" && image.test(path) && !path.startsWith("docs/images/")) {
    problems.push(`${JSON.stringify(path)}: new images must be documentation in docs/images/. Attach evidence to the pull request.`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Pull request policy passed (co-authors, changelog, and image additions).");
}
