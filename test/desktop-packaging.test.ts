import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function repoFile(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

test("the package command builds mac artifacts without publishing", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };

  assert.equal(
    manifest.scripts?.package,
    "npm run build && electron-builder --mac --publish never",
    "packaging a release tag must build the local artifacts without publishing them",
  );
});

test("the disk image ships the app and an offline Read Me, and no Applications alias", () => {
  const yml = repoFile("electron-builder.yml");
  // Settings only. The comments above them explain WHY there is no alias, so they name the
  // path the configuration must not name, and reading them as configuration would be reading
  // the rationale as the thing it argues against.
  const dmg = yml
    .slice(yml.indexOf("\ndmg:"))
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
  assert.notEqual(dmg.trim(), "", "electron-builder must still configure a dmg");

  // electron-builder's DEFAULT dmg layout is the app beside an alias to /Applications. That
  // default is what had to go: it teaches every recipient to install system-wide, which is the
  // one destination that needs an administrator password and the one this product no longer
  // defaults to. Stated contents rather than a default, so the alias cannot come back silently.
  assert.match(dmg, /^ {2}contents:$/mu, "the dmg contents must be stated, not defaulted");
  assert.doesNotMatch(dmg, /type:\s*link/u, "a dmg must not carry an /Applications alias");
  assert.doesNotMatch(dmg, /\/Applications/u);
  assert.match(dmg, /path:\s*build\/dmg\/readme\.txt/u);
  assert.match(dmg, /name:\s*Read Me\.txt/u, "and is presented under a name a person reads");

  // A dmg is built once and opened on somebody else's Mac, so nothing in it may name a path
  // that only exists on the build machine - a literal tilde included, since no alias expands it.
  assert.doesNotMatch(dmg, /~\//u);
  assert.doesNotMatch(dmg, /\/Users\//u);
});

test("the disk image Read Me explains personal install, system install, and managed updates", () => {
  // The dmg is an UNMANAGED distribution artifact: dragging the app across records no receipt,
  // so the app cannot update itself afterwards. The Read Me is the only place that can say so,
  // because the alias it replaced said nothing at all.
  const readme = repoFile("build/dmg/readme.txt");
  assert.match(readme, /UNMANAGED/u);
  assert.match(readme, /Applications folder\n {3}inside your home folder/u);
  assert.match(readme, /\/Applications folder at the top level/u);
  assert.match(readme, /make install/u);
  assert.match(readme, /--scope system/u);
  assert.doesNotMatch(readme, /\/Users\//u, "no build account's home may reach a recipient");
});

test("the developer install stages a sibling instead of deleting the installed app first", () => {
  // `make install-app` used to `rm -rf` the installed bundle and only then `cp -R` the new one,
  // so an interrupted copy left the account with no Mission Control at all. It now routes
  // through the same sibling-staging swap the managed install uses, and installs into the
  // personal folder by default.
  const makefile = repoFile("Makefile");
  const target = makefile.slice(makefile.indexOf("install-app: app"));
  const recipe = target.slice(0, target.indexOf("\n\n"));
  assert.match(recipe, /node scripts\/install-dev-app\.mjs/u);
  assert.doesNotMatch(recipe, /rm -rf/u);
  assert.doesNotMatch(recipe, /cp -R/u);
});
