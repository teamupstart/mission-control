import { execFile } from "node:child_process";
import { delimiter, dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { MIN_NODE_MAJOR, nodePrerequisiteMessage } from "../../scripts/init-prerequisites.mjs";
import { locateExecutable, refreshExecutableEnvironment } from "../server/executables/locator.ts";
import { FIXED_OS_EXECUTABLES } from "../server/executables/catalog.ts";

export type UpdateRuntime =
  | { ok: true; node: string; env: NodeJS.ProcessEnv }
  | { ok: false; message: string };

const NodeIdentity = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  execPath: z.string().refine(isAbsolute),
});
const NODE_IDENTITY = "JSON.stringify({version:process.versions.node,execPath:process.execPath})";
const NpmIdentity = z.object({ node: z.string().regex(/^\d+\.\d+\.\d+$/), npm: z.string().regex(/^\d+\.\d+\.\d+$/) });

function probe(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd, env, timeout: 5_000, maxBuffer: 16_384, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

function nodeRemediation(withNpm = false): string {
  return `Install or select Node.js ${MIN_NODE_MAJOR}+${withNpm ? " with npm" : ""}, then choose Check again. Mission Control will keep running. If this warning persists after changing Node in another terminal, restart Mission Control with the corrected Node.js environment.`;
}

export function updateNodeProblem(version: string): string | null {
  if (!nodePrerequisiteMessage(version)) return null;
  return `This update requires Node.js ${MIN_NODE_MAJOR} or newer (found ${version || "an unknown version"}). ${nodeRemediation()}`;
}

/** Probe in the build directory: version-manager shims can change with cwd. */
export async function inspectUpdateRuntime(
  node: { path: string; env: NodeJS.ProcessEnv } | null,
  npm: { path: string } | null,
  cwd: string,
  needsBuildTools = true,
): Promise<UpdateRuntime> {
  const unavailable = (detail: string): UpdateRuntime => ({
    ok: false,
    message: `${detail} ${nodeRemediation(true)}`,
  });
  if (!node) return unavailable("A system Node.js installation is required to prepare this update.");
  try {
    const identity = NodeIdentity.parse(JSON.parse(await probe(node.path, ["-p", NODE_IDENTITY], cwd, node.env)));
    const problem = updateNodeProblem(identity.version);
    if (problem) return { ok: false, message: problem };
    // A shim's path is not its selected runtime. Use the process identity it actually ran,
    // and put that runtime first for npm's env-node shebang and package lifecycle scripts.
    const env = {
      ...node.env,
      PATH: [dirname(identity.execPath), node.env.PATH].filter(Boolean).join(delimiter),
      ...(npm ? { MISSION_NPM_BIN: npm.path } : {}),
    };
    const child = NodeIdentity.parse(JSON.parse(await probe(FIXED_OS_EXECUTABLES.env, ["node", "-p", NODE_IDENTITY], cwd, env)));
    if (child.execPath !== identity.execPath || child.version !== identity.version) {
      return unavailable("The selected Node.js runtime does not match the Node.js used by build commands.");
    }
    if (!needsBuildTools) return { ok: true, node: identity.execPath, env };
    if (!npm) return unavailable("npm could not be found for this update.");
    // With no version argument this is read-only and reports npm's own Node runtime.
    const npmIdentity = NpmIdentity.parse(JSON.parse(await probe(npm.path, ["version", "--json"], cwd, env)));
    const npmProblem = updateNodeProblem(npmIdentity.node);
    if (npmProblem) return { ok: false, message: `npm is using an incompatible Node.js runtime. ${npmProblem}` };
    if (npmIdentity.node !== identity.version) {
      return unavailable("npm is using a different Node.js version from the selected runtime.");
    }
    return { ok: true, node: identity.execPath, env };
  } catch {
    return unavailable("Mission Control could not verify Node.js and npm for this update.");
  }
}

export async function checkUpdateRuntime(sourceClone: string, needsBuildTools = true): Promise<UpdateRuntime> {
  // Explicit refresh also drops positive cached paths after the user changes installations.
  await refreshExecutableEnvironment({ force: true });
  const [node, npm] = await Promise.all([locateExecutable("node"), locateExecutable("npm")]);
  return inspectUpdateRuntime(node, npm, sourceClone, needsBuildTools);
}
