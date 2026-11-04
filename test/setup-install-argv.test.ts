import assert from "node:assert/strict";
import test from "node:test";

import { isSetupInstallArgv, setupSignInCommand } from "../src/server/setup/install.ts";

function rejects(cases: readonly (readonly unknown[])[]): void {
  for (const argv of cases) {
    assert.equal(isSetupInstallArgv(argv), false, JSON.stringify(argv));
  }
}

test("the setup install grammar refuses shell escape attempts", () => {
  rejects([
    ["brew", "install", "gh", "|", "sh"],
    ["brew", "install", "gh>owned"],
    ["brew", "install", "`id`"],
    ["brew", "install", "$(id)"],
    ["brew", "install", "gh\nprintf owned"],
    ["brew", "install", "'gh'"],
    ["brew", "install", "\"gh\""],
    ["sudo", "brew", "install", "gh"],
    ["brew", "install", "sudo", "gh"],
  ]);
});

test("the setup install grammar refuses the wrong program", () => {
  rejects([
    [],
    ["python", "install", "gh"],
    ["/opt/homebrew/bin/brew", "install", "gh"],
    ["/usr/local/bin/npm", "install", "-g", "pkg"],
  ]);
});

test("the setup install grammar refuses non-install verbs and aliases", () => {
  rejects([
    ["npm", "uninstall", "-g", "pkg"],
    ["npm", "publish", "-g", "pkg"],
    ["npm", "run", "build"],
    ["npm", "exec", "pkg"],
    ["npx", "pkg"],
    ["npm", "i", "-g", "pkg"],
    ["npm", "add", "-g", "pkg"],
    ["brew", "uninstall", "gh"],
    ["brew", "services", "stop"],
  ]);
});

test("the setup install grammar refuses operands that are not bare package names", () => {
  rejects([
    ["npm", "install", "-g", "/tmp/evil.tgz"],
    ["npm", "install", "-g", "../x"],
    ["npm", "install", "-g", "git+ssh://host/repo"],
    ["npm", "install", "-g", "file:./x"],
    ["npm", "install", "-g", "pkg@1.2.3"],
    ["npm", "install", "-g", "--package"],
    ["npm", "install", "-g"],
    ["npm", "install", "-g", "one", "two"],
  ]);
});

test("the setup install grammar refuses flag injection, repetition, and reordering", () => {
  rejects([
    ["npm", "install", "--ignore-scripts", "pkg"],
    ["npm", "install", "-g", "-g", "pkg"],
    ["npm", "install", "-g", "--global", "pkg"],
    ["npm", "install", "pkg", "-g"],
    ["npm", "install", "-g", "--global"],
    ["npm", "install", "pkg"],
    ["brew", "install", "--formula", "gh"],
    ["brew", "install", "--cask", "--cask", "wezterm"],
    ["brew", "install", "wezterm", "--cask"],
  ]);
});

test("the setup install grammar accepts only the catalog's complete invocation shapes", () => {
  for (const argv of [
    ["brew", "install", "gh"],
    ["brew", "install", "--cask", "wezterm"],
    ["npm", "install", "-g", "pkg"],
    ["npm", "install", "--global", "@scope/pkg"],
  ]) {
    assert.equal(isSetupInstallArgv(argv), true, JSON.stringify(argv));
  }
});

test("a brew formula may be qualified by its tap, and by nothing looser", () => {
  // `brew install owner/tap/formula` taps and installs in one step, which is how a
  // third-party CLI such as acli stays a single catalog argv.
  assert.equal(isSetupInstallArgv(["brew", "install", "atlassian/acli/acli"]), true);
  rejects([
    ["brew", "install", "atlassian/acli"],
    ["brew", "install", "a/b/c/d"],
    ["brew", "install", "/acli/acli"],
    ["brew", "install", "atlassian//acli"],
    ["brew", "install", "Atlassian/acli/acli"],
    ["brew", "install", "../acli/acli"],
    ["brew", "install", "https://example.invalid/acli.rb"],
    ["npm", "install", "-g", "atlassian/acli/acli"],
  ]);
});

test("sign-in commands are a closed list of exact argvs, never a grammar", () => {
  assert.deepEqual(setupSignInCommand(["acli", "jira", "auth", "login", "--web"]), {
    executable: "acli",
    argv: ["acli", "jira", "auth", "login", "--web"],
  });
  for (const argv of [
    ["acli", "jira", "auth", "login"],
    ["acli", "jira", "auth", "login", "--web", "--site", "x.atlassian.net"],
    ["acli", "jira", "auth", "logout"],
    ["/opt/homebrew/bin/acli", "jira", "auth", "login", "--web"],
    ["gh", "auth", "login"],
    [],
  ]) {
    assert.equal(setupSignInCommand(argv), null, JSON.stringify(argv));
  }
  // An install argv is not a sign-in, and a sign-in is not an install.
  assert.equal(setupSignInCommand(["brew", "install", "gh"]), null);
  assert.equal(isSetupInstallArgv(["acli", "jira", "auth", "login", "--web"]), false);
});
