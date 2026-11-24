import { stageMod } from "../../server/mod-stage.ts";
import { installedMod, modMarketplace, MOD_ID } from "../setup-context.ts";
import type { SetupStepOptions, SetupStepResult } from "./types.ts";

export const id = "mod" as const;
export const owner = "P14" as const;
export const implemented = true;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function run({ context }: SetupStepOptions): Promise<SetupStepResult> {
  if (!context) throw new Error("Setup context required");
  try {
    const cli = await context.detectClaude();
    if (!cli) throw new Error("claude CLI not found: install Claude Code, then run mctl setup again");
    const staged = await stageMod(context.buildRoot, context.stateHome);
    const marketplace = await modMarketplace(cli);
    if (marketplace && (marketplace.source !== "directory" || marketplace.path !== staged.root)) {
      throw new Error(`The mission-control marketplace points elsewhere. Run claude plugin marketplace remove mission-control, then mctl setup to register ${staged.root}.`);
    }
    const addMarketplace = async () => {
      if (!await modMarketplace(cli)) await cli.run(["plugin", "marketplace", "add", staged.root]);
    };
    const plugin = await installedMod(cli);
    if (plugin?.version === staged.version) {
      if (!plugin.enabled) await cli.run(["plugin", "enable", MOD_ID, "--scope", "user"]);
    } else {
      if (plugin) await cli.run(["plugin", "uninstall", MOD_ID, "--scope", "user"]);
      try {
        await addMarketplace();
        await cli.run(["plugin", "install", MOD_ID, "--scope", "user"]);
      } catch {
        // An interrupted upgrade may leave no plugin. Retry once, then give exact recovery commands.
        try {
          await addMarketplace();
          await cli.run(["plugin", "install", MOD_ID, "--scope", "user"]);
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}\nRecovery:\nclaude plugin marketplace add ${quote(staged.root)}\nclaude plugin install ${MOD_ID} --scope user`);
        }
      }
    }
    await addMarketplace();
    const current = await installedMod(cli); // Fresh CLI invocation, never trust install's success text.
    if (!current?.enabled || current.version !== staged.version) throw new Error("Plugin install did not leave the expected enabled user version. Run mctl setup again.");
    return { id, status: "ok", message: `${MOD_ID} ${staged.version} enabled at user scope; staged at ${staged.root}` };
  } catch (error) {
    return { id, status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
