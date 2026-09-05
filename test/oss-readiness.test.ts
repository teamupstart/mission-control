import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function repoFile(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function topLevelYamlSequence(yml: string, key: string): string[] {
  const lines = yml.split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  assert.notEqual(start, -1, `missing top-level ${key} sequence`);

  const block = lines.slice(start + 1).findIndex((line) => /^\S/u.test(line));
  const end = block === -1 ? lines.length : start + 1 + block;
  return lines
    .slice(start + 1, end)
    .map((line) => line.match(/^\s+-\s+(.+?)\s*$/u)?.[1])
    .filter((entry): entry is string => entry !== undefined);
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
  const files = topLevelYamlSequence(repoFile("electron-builder.yml"), "files");

  assert.ok(files.includes("LICENSE"), "LICENSE must be in electron-builder's files sequence");
  assert.ok(files.includes("NOTICE"), "NOTICE must be in electron-builder's files sequence");
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

  const readme = repoFile("README.md");
  const contributing = repoFile("CONTRIBUTING.md");

  assert.match(readme, /Apache License 2\.0/);
  assert.equal(
    readme.match(/git clone https:\/\/github\.com\/teamupstart\/mission-control\.git/gu)?.length,
    2,
    "both README setup paths must clone the public repository",
  );
  assert.equal(readme.match(/^cd mission-control$/gmu)?.length, 2, "both README setup paths must enter mission-control");
  assert.match(contributing, /git clone https:\/\/github\.com\/teamupstart\/mission-control\.git/);
  assert.match(repoFile("SECURITY.md"), /upstart\.com\/lenders\/regulatory-compliance\/vulnerability-reporting/);
  assert.doesNotMatch(
    [
      repoFile("SECURITY.md"),
      repoFile(".github/ISSUE_TEMPLATE/bug_report.md"),
      repoFile(".github/ISSUE_TEMPLATE/config.yml"),
    ].join("\n"),
    /github\.com\/teamupstart\/mission-control\/security\/advisories\/new/u,
  );
  assert.match(readme, /@anthropic-ai\/claude-agent-sdk/);
  assert.match(readme, /does not accept external pull\s+requests/iu);
  assert.match(contributing, /Public users may open bug reports and feature requests/iu);
  assert.match(contributing, /write, maintain, or admin\s+access/iu);
  assert.doesNotMatch(contributing, /Fork the repository/iu);
});
