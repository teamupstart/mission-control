import assert from "node:assert/strict";
import test from "node:test";
import { scrubSecrets as inspectorScrub } from "../src/server/inspector/scrub.ts";
import { scrubSecrets } from "../src/server/security/scrub.ts";
import {
  addressableGitPath,
  approveRepositoryPath,
  escapedGitPath,
  repositoryPathDenied,
  validateRevisionId,
} from "../src/server/repository/security.ts";

test("repository paths reject traversal, host syntax, lossy forms, and option-like inputs", () => {
  for (const path of ["", "/etc/passwd", "../secret", "a/../b", "./a", "a//b", "a\\b", "C:/x", "-n", "a/./b", "a/"]) {
    assert.throws(() => approveRepositoryPath(path), path);
  }
  assert.equal(approveRepositoryPath("src/server/index.ts"), "src/server/index.ts");
  assert.throws(() => validateRevisionId("HEAD~1"));
  assert.equal(validateRevisionId("a".repeat(40)), "a".repeat(40));
});

test("repository sensitive matching is case-aware and includes Inspector families plus git internals", () => {
  for (const path of [
    ".git/config",
    "src/.ENV.production",
    "config/.envrc",
    "config/.ENVRC.local",
    "config/secrets.yml",
    "config/SECRETS.yaml",
    "keys/ID_RSA_backup",
    "config/Credentials.JSON",
    "cert/client.PEM",
    ".codex/auth.json",
  ]) {
    assert.equal(repositoryPathDenied(path), true, path);
  }
  assert.equal(repositoryPathDenied("src/environment.ts"), false);
  assert.equal(repositoryPathDenied("docs/secrets-management.md"), false);
});

test("non-UTF-8 Git names are listable by stable marker but cannot become request paths", () => {
  const bytes = Buffer.from([0x66, 0x6f, 0x80]);
  assert.equal(addressableGitPath(bytes), null);
  assert.equal(escapedGitPath(bytes), "git-bytes:666f80");
  assert.equal(addressableGitPath(Buffer.from("valid/path")), "valid/path");
});

test("Inspector and repository results use the exact same secret scrubber", () => {
  const text = "token=github_pat_abcdefghijklmnopqrstuvwxyz0123456789 and sk-ant-abcdefghijklmnop";
  assert.equal(scrubSecrets(text), inspectorScrub(text));
  assert.doesNotMatch(scrubSecrets(text), /github_pat_|sk-ant-/);
});
