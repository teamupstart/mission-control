import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { UPDATE_COPY } from "../src/shared/update-copy.ts";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function sandboxedPreloadUsesOnlySafeImports(contents: string): boolean {
  const tree = ts.createSourceFile(
    "src/preload/index.ts",
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let safe = true;

  const visit = (node: ts.Node): void => {
    let specifier: string | null = null;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifier = node.moduleReference.expression.text;
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifier = node.arguments[0]!.text;
    }

    if (specifier?.startsWith("node:")) {
      safe = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return safe;
}

function objectBlock(contents: string, property: string): string {
  const start = contents.search(new RegExp(`\\b${property}\\s*:\\s*\\{`));
  if (start < 0) return "";
  const open = contents.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < contents.length; index += 1) {
    if (contents[index] === "{") depth += 1;
    if (contents[index] === "}") depth -= 1;
    if (depth === 0) return contents.slice(start, index + 1);
  }
  return "";
}

function functionBlock(contents: string, name: string): string {
  const start = contents.indexOf(`function ${name}`);
  if (start < 0) return "";
  const open = contents.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < contents.length; index += 1) {
    if (contents[index] === "{") depth += 1;
    if (contents[index] === "}") depth -= 1;
    if (depth === 0) return contents.slice(start, index + 1);
  }
  return "";
}

test("the sandbox import guard covers every Node module specifier form", () => {
  const unsafeImports = [
    'import "node:crypto";',
    'import crypto from "node:crypto";',
    'import * as crypto from "node:crypto";',
    'import { randomUUID } from "node:crypto";',
    'export { randomUUID } from "node:crypto";',
    'import crypto = require("node:crypto");',
    'void import("node:crypto");',
    'const crypto = require("node:crypto");',
  ];

  assert.deepEqual(
    unsafeImports.map(sandboxedPreloadUsesOnlySafeImports),
    unsafeImports.map(() => false),
  );
  assert.equal(sandboxedPreloadUsesOnlySafeImports('import { contextBridge } from "electron";'), true);
});

test("the desktop update bridge exposes one safe, grouped IPC contract", () => {
  const main = source("src/main/index.ts");
  const preload = source("src/preload/index.ts");
  const declarations = source("src/web/mission-desktop.d.ts");
  const updatePreload = objectBlock(preload, "updates");
  const updateHandlers = functionBlock(main, "registerIpc");
  const updatePush = functionBlock(main, "pushUpdateSnapshot");
  // Six, because an update now happens in two acts: `apply` builds while the app stays open
  // (with `cancel` as the way out), and `install` is the restart that swaps the built bundle in.
  const channels = [
    "mission:update-get-state",
    "mission:update-check",
    "mission:update-apply",
    "mission:update-install",
    "mission:update-cancel",
    "mission:update-defer",
  ];

  assert.deepEqual(
    {
      mainRegistersExactlyTheUpdateHandlers:
        (main.match(/ipcMain\.handle\(["']mission:update-[^"']+["']/g) ?? []).length ===
          channels.length &&
        channels.every((channel) => main.includes(`ipcMain.handle("${channel}"`)),
      mainHandlersCallController:
        main.includes("registerIpc(updater)") &&
        /mission:update-get-state[\s\S]{0,160}updateController\.getSnapshot\(\)/.test(updateHandlers) &&
        /mission:update-check[\s\S]{0,160}updateController\.check\(true\)/.test(updateHandlers) &&
        /mission:update-apply[\s\S]{0,160}updateController\.apply\(\)/.test(updateHandlers) &&
        /mission:update-install[\s\S]{0,160}updateController\.install\(\)/.test(updateHandlers) &&
        /mission:update-cancel[\s\S]{0,160}updateController\.cancel\(\)/.test(updateHandlers) &&
        /mission:update-defer[\s\S]{0,160}updateController\.defer\(\)/.test(updateHandlers) &&
        !updateHandlers.includes("updateController?."),
      mainSubscribesOnce:
        (main.match(/updater(?:\?|!)?\.subscribe\(/g) ?? []).length === 1,
      mainGuardsUpdateStateSend:
        updatePush.includes('wc.send("mission:update-state"') &&
        updatePush.includes("isLoading()") &&
        updatePush.includes('did-finish-load'),
      preloadHasOneGroupedNamespace:
        (preload.match(/\bupdates\s*:\s*\{/g) ?? []).length === 1 && updatePreload.length > 0,
      preloadUsesOnlySandboxSafeImports: sandboxedPreloadUsesOnlySafeImports(preload),
      preloadExposesExactMethods:
        Array.from(updatePreload.matchAll(/^\s{4}(\w+):/gm), ([, method]) => method).join(",") ===
          "getState,check,apply,install,cancel,defer,onState" &&
        [
          ["getState", "mission:update-get-state"],
          ["check", "mission:update-check"],
          ["apply", "mission:update-apply"],
          ["install", "mission:update-install"],
          ["cancel", "mission:update-cancel"],
          ["defer", "mission:update-defer"],
        ].every(([method, channel]) =>
          new RegExp(`${method}:\\s*[^\\n]+${channel}`).test(updatePreload),
        ) &&
        Array.from(updatePreload.matchAll(/["'](mission:update-[^"']+)["']/g), ([, channel]) => channel)
          .every((channel) => [...channels, "mission:update-state"].includes(channel!)) &&
        channels.every((channel) => (updatePreload.match(new RegExp(channel, "g")) ?? []).length === 1) &&
        (updatePreload.match(/mission:update-state/g) ?? []).length === 2,
      preloadDropsEventAndUnsubscribes:
        /listener\s*=\s*\([^,]+,\s*snapshot[^)]*\)\s*(?::[^=]+)?=>\s*cb\(snapshot\)/s.test(updatePreload) &&
        /removeListener\(["']mission:update-state["'],\s*listener\)/.test(updatePreload),
      preloadLeaksNoDiagnostics:
        !/\b(?:path|url|stderr|stack|rawError)\b/i.test(updatePreload),
      declarationsMirrorGroupedContract:
        /import\s+type\s+\{\s*UpdateSnapshot\s*\}/.test(declarations) &&
        /updates\s*:\s*\{[\s\S]*getState\(\)\s*:\s*Promise<UpdateSnapshot>[\s\S]*check\(\)\s*:\s*Promise<UpdateSnapshot>[\s\S]*apply\(\)\s*:\s*Promise<boolean>[\s\S]*install\(\)\s*:\s*Promise<boolean>[\s\S]*cancel\(\)\s*:\s*Promise<void>[\s\S]*defer\(\)\s*:\s*Promise<void>[\s\S]*onState\(.*UpdateSnapshot.*\)\s*:\s*\(\)\s*=>\s*void[\s\S]*\}/.test(
          declarations,
        ),
      missionDesktopRemainsOptional: /missionDesktop\?\s*:\s*MissionDesktop/.test(declarations),
    },
    {
      mainRegistersExactlyTheUpdateHandlers: true,
      mainHandlersCallController: true,
      mainSubscribesOnce: true,
      mainGuardsUpdateStateSend: true,
      preloadHasOneGroupedNamespace: true,
      preloadUsesOnlySandboxSafeImports: true,
      preloadExposesExactMethods: true,
      preloadDropsEventAndUnsubscribes: true,
      preloadLeaksNoDiagnostics: true,
      declarationsMirrorGroupedContract: true,
      missionDesktopRemainsOptional: true,
    },
  );
});


test("the native dialog and the dashboard banner take the update's words from one owner", () => {
  // Both surfaces are reachable for the same phase - the dialog when someone updates from the
  // menu bar with the window hidden, the banner when the window is up - so a sentence written
  // twice is a sentence that will drift. It already had: one draft said "administrator
  // password" while the other said "administrator permission".
  const main = source("src/main/index.ts");
  const banner = source("src/web/components/UpdateBanner.tsx");

  assert.deepEqual(
    {
      dialogsReadTheSharedCopy:
        /import \{ UPDATE_COPY \} from "\.\.\/shared\/update-copy\.ts"/.test(main) &&
        ["preparing", "ready", "applying"].every(
          (phase) =>
            main.includes(`UPDATE_COPY.${phase}.title(version)`) &&
            main.includes(`UPDATE_COPY.${phase}.detail`),
        ),
      bannerReadsTheSharedCopy:
        /import \{ UPDATE_COPY \} from "@shared\/update-copy\.ts"/.test(banner) &&
        ["preparing", "ready", "applying"].every(
          (phase) =>
            banner.includes(`UPDATE_COPY.${phase}.title(snapshot.newVersion)`) &&
            banner.includes(`UPDATE_COPY.${phase}.detail`),
        ),
      // The sentences themselves appear in neither file: one owner, not one owner plus a copy.
      neitherSurfaceHardCodesASentence: [
        UPDATE_COPY.preparing.detail,
        UPDATE_COPY.ready.detail,
        UPDATE_COPY.applying.detail,
      ].every((sentence) => !main.includes(sentence) && !banner.includes(sentence)),
    },
    {
      dialogsReadTheSharedCopy: true,
      bannerReadsTheSharedCopy: true,
      neitherSurfaceHardCodesASentence: true,
    },
  );
});
