import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { expect, test } from "../fixtures/test.ts";
import { openSetupFamily } from "../fixtures/setup-panel.ts";
import { buildOwnedIntegrationInstaller } from "../../test/helpers/owned-integration-installer.ts";

test("desktop repair action runs the real installer and reports preserved custom commands", async ({page,daemon}) => {
  const home=mkdtempSync(join(tmpdir(),"e2e-owned-repair-"));
  try {
    mkdirSync(join(home,".claude"));
    mkdirSync(join(home,"dist/satellites"),{recursive:true});
    for (const name of ["hook.mjs","harness-statusline.mjs"]) writeFileSync(join(home,"dist/satellites",name),"");
    const settings=join(home,".claude/settings.json");
    const oldHook = {type:"command",command:'"/mise/shims/node" "/source/hooks/harness-hook.mjs" Stop',timeout:42};
    writeFileSync(settings,JSON.stringify({hooks:{Stop:[{hooks:[oldHook]},{hooks:[oldHook]}]},permissions:{allow:["keep"]}}));
    const installer=await buildOwnedIntegrationInstaller(home);
    await page.exposeFunction("repairOwnedFixture", () => JSON.parse(execFileSync(process.execPath,[installer],{
      encoding:"utf8",env:{...process.env,HOME:home,CLAUDE_SETTINGS_PATH:settings,MISSION_HOME:join(home,"state"),MISSION_TEST_APP_ROOT:home,
        MISSION_NODE_BIN:"/missing/node",MISSION_CLAUDE_BIN:"/usr/bin/false",MISSION_CODEX_BIN:"/usr/bin/false"},
    })));
    await page.addInitScript(() => Object.defineProperty(window,"missionDesktop",{value:{isDesktop:true,onOpenSettings:()=>()=>{},
      installIntegrations:()=> (window as unknown as {repairOwnedFixture():Promise<unknown>}).repairOwnedFixture()}}));
    await page.goto(`${daemon.baseURL}/#/settings/setup`);
    await openSetupFamily(page,"extensions");
    const panel=page.getByLabel("Mission-owned integrations");
    await panel.getByRole("button",{name:"Install Claude integrations"}).click();
    await expect(panel.getByRole("status")).toContainText("installed via this app's bundled Node");
    const config=parse(readFileSync(settings,"utf8"));
    expect(config.hooks.Stop).toHaveLength(1);
    expect(config.hooks.Stop[0].hooks).toHaveLength(1);
    expect(config.hooks.Stop[0].hooks[0].command).toContain('ELECTRON_RUN_AS_NODE="1"');
    expect(config.hooks.Stop[0].hooks[0].timeout).toBe(42);
    expect(config.permissions).toEqual({allow:["keep"]});
    writeFileSync(settings,JSON.stringify({hooks:{Stop:[{hooks:[{command:"echo custom; node /source/hooks/harness-hook.mjs Stop"}]}]}}));
    const custom=readFileSync(settings,"utf8");
    await panel.getByRole("button",{name:"Install Claude integrations"}).click();
    await expect(panel.getByRole("status")).toContainText("custom command");
    expect(readFileSync(settings,"utf8")).toBe(custom);
    if(process.env.MC_E2E_EVIDENCE==="1") {
      mkdirSync("e2e/.artifacts/setup-node-runtime",{recursive:true});
      await page.screenshot({path:"e2e/.artifacts/setup-node-runtime/repair-feedback.png",fullPage:true});
    }
  } finally {rmSync(home,{recursive:true,force:true});}
});
