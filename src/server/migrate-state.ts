import { migrateStateDir } from "../shared/harness-runtime.mjs";

/**
 * Rename a state dir left behind by an older name (`~/.fleet-control`, `~/.ai-harness`)
 * onto `~/.mission-control`. Imported for its side effect, by the daemon's entry point
 * ONLY, and it must stay that way.
 *
 * This is a module rather than a line in `config.ts` because of who else loads that
 * file. `config.ts` computes `STATE_DIR` at module scope, so the rename has to happen
 * before it is evaluated - but `config.ts` is imported by most of src/server, which
 * means the whole test suite pulls it in too. A rename sitting in its body therefore
 * ran on `npm test`, against the developer's REAL home, and moved a live install's
 * state dir out from under a running daemon. It did exactly that once, to the machine
 * this was written on. Tests that set `MISSION_HOME` were unaffected (the override
 * makes this a no-op); the ones that never touch config's env were not.
 *
 * A separate module fixes that by construction: nothing imports this but `index.ts`,
 * so no test, no hook, no MCP bridge, and no `tsx` one-liner can trigger a rename. It
 * still runs early enough, because ES modules evaluate their imports in source order,
 * depth-first - so this file's body runs before `./config.ts`'s, as long as the import
 * of it stays ABOVE the config import in `index.ts`. That ordering is the entire
 * mechanism; there is a test pinning it.
 */
migrateStateDir();
