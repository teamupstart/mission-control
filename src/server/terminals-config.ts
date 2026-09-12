import {
  TerminalsConfigSchema,
  type TerminalsConfig,
  type TerminalsConfigPatch,
} from "@shared/protocol.ts";
import {
  resolveEmulatorBackend,
  type EmulatorId,
  type MultiplexerId,
} from "@shared/terminal.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { defaultTerminalDeps, type TerminalDeps } from "./terminal/registry.ts";
import {
  defaultTerminalTargetDeps,
  type TerminalTargetDeps,
} from "./terminal/targets.ts";
import { getAppConfig, setAppConfig } from "./db.ts";

// The "Terminals" settings blob, mirroring `harnesses.ts`: a schema-validated value over the
// `app_config` KV, so a new key needs no migration.
//
// Not the Harnesses panel's `terminalBackend`, which is keyed per agent and admits either
// axis. See docs/harnesses-and-terminals.md for how the two differ.

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.terminals;

/** The current config, with schema defaults applied over whatever was stored. */
export function getTerminalsConfig(): TerminalsConfig {
  return TerminalsConfigSchema.parse(getAppConfig(CONFIG_ENTRY) ?? {});
}

/**
 * Merge a patch over the current config, persist, and return the result.
 *
 * Merged per MULTIPLEXER KEY, exactly as `setHarnessesConfig` merges per agent key: the
 * panel edits one row at a time, so a patch naming tmux must not clear the Herdr preference
 * it never showed the operator.
 */
export function setTerminalsConfig(patch: TerminalsConfigPatch): TerminalsConfig {
  const cur = getTerminalsConfig();
  const next = TerminalsConfigSchema.parse({
    ...cur,
    ...patch,
    multiplexerTerminal: { ...cur.multiplexerTerminal, ...patch.multiplexerTerminal },
  });
  setAppConfig(CONFIG_ENTRY, next);
  return next;
}

/**
 * Which terminal app this multiplexer's sessions should open in, as stored right now.
 *
 * Takes the ID rather than the adapter, because the config map is keyed by id and this
 * module must not import a server-side adapter type to answer a question about a key. Every
 * caller passes `<adapter>.id`.
 *
 * Returns the PAIR rather than a bare id for the reason `resolveTerminalBackend` does:
 * collapsing to `EmulatorId | null` throws away the value a Setup row needs in order to say
 * it ignored a preference this build does not recognise. Policy callers read `.backend`; the
 * row reads `.unknown`.
 *
 * Server-only, because it reads server config. The browser runs the shared
 * `resolveEmulatorBackend` over the config its own hook fetched.
 */
export function resolveFocusEmulator(id: MultiplexerId): {
  backend: EmulatorId | null;
  unknown: string | null;
} {
  return resolveEmulatorBackend(getTerminalsConfig().multiplexerTerminal[id]);
}

/**
 * The `backend` half, as the terminal policy layer injects it.
 *
 * A plain function rather than a direct import at each call site so `TerminalDeps` and
 * `TerminalTargetDeps` keep one seam a test can drive without writing to the database.
 */
export function focusEmulatorFor(id: MultiplexerId): EmulatorId | null {
  const resolved = resolveFocusEmulator(id);
  if (resolved.unknown) {
    console.warn(
      `[mission-control] the stored terminal ${JSON.stringify(resolved.unknown)} for ` +
        `${id} sessions is not a terminal app this build knows - choosing one automatically instead`,
    );
  }
  return resolved.backend;
}

/**
 * The terminal mechanism deps with this daemon's stored preference bound in.
 *
 * Composed HERE and not in `src/server/terminal/`: reading a setting reaches `db.ts`, whose
 * module scope resolves the state directory, so binding the reader inside a mechanism module
 * opened the daemon's persistence on any import of a terminal adapter. Settings knows about
 * mechanism, never the reverse.
 *
 * Composing at module scope is safe because `focusEmulatorFor` is a function: what is bound
 * is the act of reading, not a value read.
 */
export const configuredTerminalDeps: TerminalDeps = {
  ...defaultTerminalDeps,
  focusEmulator: focusEmulatorFor,
};

export const configuredTerminalTargetDeps: TerminalTargetDeps = {
  ...defaultTerminalTargetDeps,
  focusEmulator: focusEmulatorFor,
};
