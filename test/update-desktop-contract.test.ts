import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { UPDATE_COPY } from "../src/shared/update-copy.ts";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/**
 * A file with its comments removed.
 *
 * The scans below look for code that must not exist, and prose about that code is not it.
 * `update-dialog.ts` explains at length WHY there is no platform sheet in the update path,
 * and a scan that cannot tell the explanation from the thing being explained would fail on
 * the comment while proving nothing.
 */
function codeOnly(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
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
  // The pushed channels, which are `on`/`send` rather than `invoke`/`handle` because main is
  // the side asking: it pushes a snapshot nobody requested, and a dialog it is waiting on an
  // answer to. `mission:update-dialog-ready` runs the other way, and is how a renderer says
  // it can draw one - see `main/update-dialog.ts` for what happens when none can.
  const pushChannels = [
    "mission:update-state",
    "mission:update-dialog",
    "mission:update-dialog-ready",
    "mission:update-dialog-choice",
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
      // The two dialog channels are the renderer talking back, so both are refused from any
      // sender but the dashboard's own contents. A second window - or anything else that got
      // hold of the channel name - must not be able to answer a question on the operator's
      // behalf, and "install the update now" is one of the answers.
      mainGatesDialogChannelsOnTheDashboard:
        (main.match(/ipcMain\.on\(["']mission:update-dialog-[^"']+["']/g) ?? []).length === 2 &&
        ["mission:update-dialog-ready", "mission:update-dialog-choice"].every((channel) =>
          new RegExp(
            `ipcMain\\.on\\("${channel}"[\\s\\S]{0,220}?event\\.sender !== getMainWindow\\(\\)\\?\\.webContents\\) return;`,
          ).test(updateHandlers),
        ) &&
        /mission:update-dialog-ready[\s\S]{0,240}updateDialogPresenter\.attach\(\)/.test(updateHandlers) &&
        /mission:update-dialog-choice[\s\S]{0,320}updateDialogPresenter\.answer\(/.test(updateHandlers),
      // A renderer that is destroyed while a question is up cannot answer it, and
      // `checkForUpdates()` is awaiting that answer. Without this the update wedges for the
      // life of the process, silently.
      mainFallsBackWhenTheRendererGoes:
        /onMainWindowClosed\(\(\) => \{[\s\S]{0,200}updateDialogPresenter\.detach\(\);/.test(main),
      mainGuardsUpdateStateSend:
        updatePush.includes('wc.send("mission:update-state"') &&
        updatePush.includes("isLoading()") &&
        updatePush.includes('did-finish-load'),
      preloadHasOneGroupedNamespace:
        (preload.match(/\bupdates\s*:\s*\{/g) ?? []).length === 1 && updatePreload.length > 0,
      preloadUsesOnlySandboxSafeImports: sandboxedPreloadUsesOnlySafeImports(preload),
      preloadExposesExactMethods:
        Array.from(updatePreload.matchAll(/^\s{4}(\w+):/gm), ([, method]) => method).join(",") ===
          "getState,check,apply,install,cancel,defer,onState,onDialog,answerDialog" &&
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
          .every((channel) => [...channels, ...pushChannels].includes(channel!)) &&
        channels.every((channel) => (updatePreload.match(new RegExp(channel, "g")) ?? []).length === 1) &&
        (updatePreload.match(/mission:update-state/g) ?? []).length === 2 &&
        // Subscribing to the questions IS the announcement that this renderer can draw them,
        // and the order is load-bearing: main re-offers whatever is unanswered on that
        // signal, so a listener attached afterwards would miss its own backlog.
        /ipcRenderer\.on\(["']mission:update-dialog["'][\s\S]{0,120}ipcRenderer\.send\(["']mission:update-dialog-ready["']/
          .test(updatePreload) &&
        /removeListener\(["']mission:update-dialog["'],\s*listener\)/.test(updatePreload) &&
        /answerDialog:[^\n]+\n[^\n]*mission:update-dialog-choice/.test(updatePreload),
      preloadDropsEventAndUnsubscribes:
        /listener\s*=\s*\([^,]+,\s*snapshot[^)]*\)\s*(?::[^=]+)?=>\s*cb\(snapshot\)/s.test(updatePreload) &&
        /removeListener\(["']mission:update-state["'],\s*listener\)/.test(updatePreload),
      preloadLeaksNoDiagnostics:
        !/\b(?:path|url|stderr|stack|rawError)\b/i.test(updatePreload),
      declarationsMirrorGroupedContract:
        /import\s+type\s+\{\s*UpdateSnapshot\s*\}/.test(declarations) &&
        // Optional, like `setCardJumpKeys`: an older preload beside this bundle is what a
        // partly-applied desktop update looks like, and the `?` is what makes the compiler
        // refuse the unguarded call that would throw out of a mount effect.
        /onDialog\?\(/.test(declarations) &&
        /answerDialog\?\(/.test(declarations) &&
        /updates\s*:\s*\{[\s\S]*getState\(\)\s*:\s*Promise<UpdateSnapshot>[\s\S]*check\(\)\s*:\s*Promise<UpdateSnapshot>[\s\S]*apply\(\)\s*:\s*Promise<boolean>[\s\S]*install\(\)\s*:\s*Promise<boolean>[\s\S]*cancel\(\)\s*:\s*Promise<void>[\s\S]*defer\(\)\s*:\s*Promise<void>[\s\S]*onState\(.*UpdateSnapshot.*\)\s*:\s*\(\)\s*=>\s*void[\s\S]*\}/.test(
          declarations,
        ),
      missionDesktopRemainsOptional: /missionDesktop\?\s*:\s*MissionDesktop/.test(declarations),
    },
    {
      mainRegistersExactlyTheUpdateHandlers: true,
      mainHandlersCallController: true,
      mainSubscribesOnce: true,
      mainGatesDialogChannelsOnTheDashboard: true,
      mainFallsBackWhenTheRendererGoes: true,
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


test("every update surface takes its words from one owner", () => {
  // Two surfaces are reachable for the same phase - the dashboard banner, and the themed
  // modal when the shell needs an answer - so a sentence written twice is a sentence that
  // will drift. It already had: one draft said "administrator password" while the other said
  // "administrator permission".
  //
  // `shared/update-dialog.ts` owns the title, the detail, the tone and the buttons for all
  // seven conversations, and the shell asks only through it, so a phase cannot be worded or
  // styled one way here and another way there.
  const main = source("src/main/index.ts");
  const dialogs = source("src/shared/update-dialog.ts");
  const presenter = codeOnly("src/main/update-dialog.ts");
  const mainCode = codeOnly("src/main/index.ts");
  const banner = source("src/web/components/UpdateBanner.tsx");
  const modal = source("src/web/components/UpdateDialog.tsx");

  assert.deepEqual(
    {
      dialogContentReadsTheSharedCopy:
        /import \{ UPDATE_COPY \} from "\.\/update-copy\.ts"/.test(dialogs) &&
        ["preparing", "ready", "applying"].every(
          (phase) =>
            dialogs.includes(`UPDATE_COPY.${phase}.title(version)`) &&
            dialogs.includes(`UPDATE_COPY.${phase}.detail`),
        ),
      bannerReadsTheSharedCopy:
        /import \{ UPDATE_COPY \} from "@shared\/update-copy\.ts"/.test(banner) &&
        ["preparing", "ready", "applying"].every(
          (phase) =>
            banner.includes(`UPDATE_COPY.${phase}.title(snapshot.newVersion)`) &&
            banner.includes(`UPDATE_COPY.${phase}.detail`),
        ),
      // The shell asks through the builders and never writes a dialog's words itself.
      shellAsksThroughTheSharedBuilders:
        /import \{ UPDATE_DIALOGS \} from "\.\.\/shared\/update-dialog\.ts"/.test(main) &&
        ["available", "upToDate", "preparing", "ready", "applying", "error", "outcome"].every(
          (phase) => new RegExp(`askUpdate\\(UPDATE_DIALOGS\\.${phase}\\(`).test(main),
        ) &&
        !main.includes("UPDATE_COPY"),
      // No update conversation reaches a platform message box. A `dialog.showMessageBox`
      // sheet is a SECOND, unthemed auto-update surface, which is the thing this change
      // removes rather than a fallback worth keeping - so the whole of the update path, the
      // presenter included, must be free of one. `showMessageBox` survives in this file
      // only for the integrations result, which is not an update surface.
      noUpdateConversationReachesAPlatformSheet:
        !/native|MessageBox/i.test(presenter) &&
        (mainCode.match(/showMessageBox/g) ?? []).length ===
          (functionBlock(mainCode, "showIntegrationResult").match(/showMessageBox/g) ?? []).length,
      // The modal draws whatever arrives. A per-phase branch here would be a second place
      // that decides what an update says, which is the defect this file exists for.
      modalRendersContentRatherThanPhases:
        modal.includes("request.title") &&
        modal.includes("request.actions.map") &&
        !/UPDATE_COPY|snapshot\.phase/.test(modal),
      // The sentences themselves appear in none of them: one owner, not one owner plus copies.
      noSurfaceHardCodesASentence: [
        UPDATE_COPY.preparing.detail,
        UPDATE_COPY.ready.detail,
        UPDATE_COPY.applying.detail,
      ].every(
        (sentence) =>
          !main.includes(sentence) && !banner.includes(sentence) && !modal.includes(sentence),
      ),
    },
    {
      dialogContentReadsTheSharedCopy: true,
      bannerReadsTheSharedCopy: true,
      shellAsksThroughTheSharedBuilders: true,
      noUpdateConversationReachesAPlatformSheet: true,
      modalRendersContentRatherThanPhases: true,
      noSurfaceHardCodesASentence: true,
    },
  );
});
