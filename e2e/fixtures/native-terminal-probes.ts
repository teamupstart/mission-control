import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellCommand } from "../../src/server/terminal/shell.ts";

/** Native CLI health reads must not inherit a JavaScript VM's cold-start cost. */
export function writeNativeTerminalProbe(binDir: string, name: "cmux" | "herdr", runtime: string): string {
  const bin = join(binDir, `fake-${name}`);
  const script = join(binDir, `fake-${name}.cjs`);
  writeFileSync(script, runtime);
  const probe = name === "cmux" ? cmuxProbe : herdrProbe(binDir);
  writeFileSync(bin, `#!/bin/sh\n${probe}\nexec ${shellCommand([process.execPath, script])} "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const cmuxProbe = `if [ "$1" = capabilities ]; then
  case "$MC_E2E_CMUX_CONTROL" in
    stopped) printf 'Error: Socket not found at %s/cmux.sock\\n' "\${MISSION_HOME:-/tmp}" >&2; exit 1 ;;
    refused) printf '%s\\n' 'Error: ERROR: Access denied - only processes started inside cmux can connect' >&2; exit 1 ;;
    *) printf '%s\\n' '{"access_mode":"allowAll","methods":[]}'; exit 0 ;;
  esac
fi`;

function herdrProbe(binDir: string): string {
  const variants = [
    { name: "stable", version: "0.8.2", protocol: 20 },
    { name: "newer", version: "0.9.0", protocol: 22 },
    { name: "incompatible", version: "0.7.0", protocol: 19 },
  ];
  for (const variant of variants) {
    for (const running of [false, true]) {
      writeFileSync(join(binDir, `herdr-${variant.name}-${running}.json`), JSON.stringify({
        status: running ? "running" : "not_running", running,
        version: running ? variant.version : null, protocol: running ? variant.protocol : null,
        capabilities: running ? {} : null, compatible: running ? variant.name !== "incompatible" : null,
        socket: join(binDir, "..", "fake-herdr.sock"), session: null,
        restart_needed: variant.name === "incompatible",
      }) + "\n");
    }
  }
  return `if [ "$1" = status ] && [ "$2" = server ]; then
  case "$MC_E2E_HERDR_MODE" in
    incompatible) snapshot=${shellCommand([join(binDir, "herdr-incompatible-true.json")])} ;;
    *)
      case "$MC_E2E_HERDR_MODE" in newer) variant=newer ;; *) variant=stable ;; esac
      if [ -e "$MISSION_HOME/fake-herdr.sock" ]; then running=true; else running=false; fi
      snapshot=${shellCommand([binDir])}/herdr-"$variant"-"$running".json ;;
  esac
  IFS= read -r status < "$snapshot"
  printf '%s\\n' "$status"
  exit 0
fi`;
}
