import assert from "node:assert/strict";
import test from "node:test";

import { isSetupInstallArgv } from "../src/server/setup/install.ts";

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
