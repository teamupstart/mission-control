import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
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

test("the desktop update bridge exposes one safe, grouped IPC contract", () => {
  const main = source("src/main/index.ts");
  const preload = source("src/preload/index.ts");
  const declarations = source("src/web/mission-desktop.d.ts");
  const updatePreload = objectBlock(preload, "updates");
  const updateHandlers = functionBlock(main, "registerIpc");
  const updatePush = functionBlock(main, "pushUpdateSnapshot");
  const channels = [
    "mission:update-get-state",
    "mission:update-check",
    "mission:update-apply",
    "mission:update-defer",
  ];

  assert.deepEqual(
    {
      mainRegistersExactlyFourUpdateHandlers:
        (main.match(/ipcMain\.handle\(["']mission:update-[^"']+["']/g) ?? []).length === 4 &&
        channels.every((channel) => main.includes(`ipcMain.handle("${channel}"`)),
      mainHandlersCallController:
        main.includes("registerIpc(updater)") &&
        /mission:update-get-state[\s\S]{0,160}updateController\.getSnapshot\(\)/.test(updateHandlers) &&
        /mission:update-check[\s\S]{0,160}updateController\.check\(true\)/.test(updateHandlers) &&
        /mission:update-apply[\s\S]{0,160}updateController\.apply\(\)/.test(updateHandlers) &&
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
      preloadExposesExactMethods:
        Array.from(updatePreload.matchAll(/^\s{4}(\w+):/gm), ([, method]) => method).join(",") ===
          "getState,check,apply,defer,onState" &&
        [
          ["getState", "mission:update-get-state"],
          ["check", "mission:update-check"],
          ["apply", "mission:update-apply"],
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
        /updates\s*:\s*\{[\s\S]*getState\(\)\s*:\s*Promise<UpdateSnapshot>[\s\S]*check\(\)\s*:\s*Promise<UpdateSnapshot>[\s\S]*apply\(\)\s*:\s*Promise<boolean>[\s\S]*defer\(\)\s*:\s*Promise<void>[\s\S]*onState\(.*UpdateSnapshot.*\)\s*:\s*\(\)\s*=>\s*void[\s\S]*\}/.test(
          declarations,
        ),
      missionDesktopRemainsOptional: /missionDesktop\?\s*:\s*MissionDesktop/.test(declarations),
    },
    {
      mainRegistersExactlyFourUpdateHandlers: true,
      mainHandlersCallController: true,
      mainSubscribesOnce: true,
      mainGuardsUpdateStateSend: true,
      preloadHasOneGroupedNamespace: true,
      preloadExposesExactMethods: true,
      preloadDropsEventAndUnsubscribes: true,
      preloadLeaksNoDiagnostics: true,
      declarationsMirrorGroupedContract: true,
      missionDesktopRemainsOptional: true,
    },
  );
});
