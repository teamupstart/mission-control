import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REST_SSO_STDERR, SSO_AUTHORIZE_URL } from "./helpers/github-sso-stderr.ts";

// The Inspector names its repository on purpose (the PR URL chose it), so an SSO refusal gets
// no remedy, only the repository, the organization and gh's authorize link. That link is on
// stderr's second line, past where the old first-300-characters cut would have kept it.
// Driven through a fake `gh` on PATH, the same way `inspector-diff-bytes.test.ts` is.

const temp = mkdtempSync(join(tmpdir(), "mission-inspector-sso-"));
const binDir = join(temp, "bin");
const stderrPath = join(temp, "stderr.txt");
mkdirSync(binDir, { recursive: true });

process.env.FAKE_GH_STDERR = stderrPath;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;

const ghPath = join(binDir, "gh");
writeFileSync(
  ghPath,
  `#!/usr/bin/env node
process.stderr.write(require("node:fs").readFileSync(process.env.FAKE_GH_STDERR, "utf8"));
process.exit(1);
`,
);
chmodSync(ghPath, 0o755);

const { fetchDiff } = await import("../src/server/inspector/github.ts");

after(() => rmSync(temp, { recursive: true, force: true }));

test("an SSO refusal names the PR's repository and keeps gh's authorize link", async () => {
  writeFileSync(stderrPath, REST_SSO_STDERR);
  const res = await fetchDiff(null, "teamupstart", "mission-control", 7, 1_000);
  assert.equal(res.ok, false);
  assert.equal(
    res.error,
    "gh api (diff) failed (exit 1): GitHub refused teamupstart/mission-control: the teamupstart " +
      "organization requires SAML SSO and this gh token is not authorized for it. " +
      `Authorize: ${SSO_AUTHORIZE_URL}.`,
  );
});

test("any other failure keeps its current wording", async () => {
  writeFileSync(stderrPath, "HTTP 404: Not Found\nsecond line\n");
  const res = await fetchDiff(null, "acme", "widgets", 7, 1_000);
  assert.equal(res.error, "gh api (diff) failed (exit 1): HTTP 404: Not Found\nsecond line");
});
