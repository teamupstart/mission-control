import { spawnSync } from "node:child_process";
import { Dispatcher } from "../../src/server/dispatcher.ts";
import { Registry } from "../../src/server/registry.ts";
import { PLAIN_NAMES } from "../../src/server/terminal/names.ts";
import { fakeEmulator, fakeMultiplexer, fakeTerminals, OK } from "../helpers/terminal-fakes.ts";

const [taskId, mode] = process.argv.slice(2);
const registry = new Registry();
const mux = fakeMultiplexer({ sessions: {
  names: PLAIN_NAMES, attachArgv: null, rename: async () => OK, kill: null, alive: null, closeIfOnlyPane: null,
  async spawnDetached({ argv, cwd }) {
    if (mode === "exited" && spawnSync(argv[0]!, argv.slice(1), { cwd, stdio: "ignore" }).status !== 0) {
      throw new Error("fixture wrapper failed");
    }
    process.send!({ submitted: true });
    return new Promise<never>(() => {}); // The parent kills this daemon before any backend acknowledgement.
  },
} });
await new Dispatcher(registry, undefined, {
  resolveRuntime: () => "terminal", resolveTerminalBackend: () => "tmux",
  homeDeps: fakeTerminals(mux, fakeEmulator()), piExtensionInstalled: () => true,
  verifyMissionMcpTools: async () => ({ ok: true }),
}).dispatch(taskId!);
throw new Error("dispatch returned before the simulated crash: " + registry.getTask(taskId!)?.error);
