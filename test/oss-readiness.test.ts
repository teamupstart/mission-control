import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function repoFile(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

test("package metadata declares Apache-2.0 without enabling npm publication", () => {
  const manifest = JSON.parse(repoFile("package.json")) as {
    private?: boolean;
    license?: string;
    repository?: { url?: string };
  };
  const lock = JSON.parse(repoFile("package-lock.json")) as {
    packages?: Record<string, { license?: string }>;
  };

  assert.equal(manifest.private, true, "open source does not make the Electron app an npm package");
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.repository?.url, "git+https://github.com/teamupstart/mission-control.git");
  assert.equal(lock.packages?.[""]?.license, manifest.license);
});

test("the packaged application includes its license and attribution notice", () => {
  const yml = repoFile("electron-builder.yml");

  assert.match(yml, /^\s*-\s*LICENSE\s*$/m);
  assert.match(yml, /^\s*-\s*NOTICE\s*$/m);
});

test("fork pull requests cannot execute on shared self-hosted runners", () => {
  const workflow = repoFile(".github/workflows/ci.yml");

  assert.doesNotMatch(workflow, /frontend-platform|self-hosted:\s*true/iu);
  assert.doesNotMatch(workflow, /^\s+labels:\s+/mu);
  assert.match(workflow, /unit-node-24:[\s\S]*?runs-on:\s*ubuntu-latest/u);
  assert.match(workflow, /unit-node-26:[\s\S]*?runs-on:\s*ubuntu-latest/u);
  assert.match(workflow, /e2e:[\s\S]*?runs-on:\s*ubuntu-latest/u);
});

test("public entry-point documentation has no legacy internal-only notice", () => {
  for (const rel of ["README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
    const text = repoFile(rel);
    assert.doesNotMatch(text, /internal repository|not licensed for public distribution/iu, rel);
  }

  assert.match(repoFile("README.md"), /Apache License 2\.0/);
  assert.match(repoFile("CONTRIBUTING.md"), /git clone https:\/\/github\.com\/teamupstart\/mission-control\.git/);
  assert.match(repoFile("SECURITY.md"), /security\/advisories\/new/);
  assert.match(repoFile("SECURITY.md"), /upstart\.com\/lenders\/regulatory-compliance\/vulnerability-reporting/);
  assert.match(repoFile("README.md"), /@anthropic-ai\/claude-agent-sdk/);
});
