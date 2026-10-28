import { build } from "esbuild";
import { join } from "node:path";

/** Real installer with a fixture app path; optional lookup interception injects a config race. */
export async function buildOwnedIntegrationInstaller(directory: string, beforeCliLookup = ""): Promise<string> {
  const outfile = join(directory, "install.cjs");
  await build({
    stdin: {contents: `import {installIntegrations, removeIntegrations} from './src/main/integrations.ts';
console.log(JSON.stringify(process.argv.includes('--remove') ? removeIntegrations() : installIntegrations()));`, resolveDir:process.cwd()},
    bundle:true, platform:"node", format:"cjs", outfile, mainFields:["module","main"],
    alias:{"@shared":"./src/shared"},
    plugins:[{name:"isolated-electron", setup(builder) {
      builder.onResolve({filter:/^electron$/}, () => ({path:"electron", namespace:"isolated"}));
      builder.onLoad({filter:/.*/, namespace:"isolated"}, () => ({contents:`export const app = {getAppPath:()=>process.env.MISSION_TEST_APP_ROOT};`, loader:"js"}));
      if (beforeCliLookup) {
        builder.onResolve({filter:/executables\/locator\.ts$/}, args => {
          if (args.namespace === "lookup-race") return {path: args.path, namespace: "file"};
          return args.importer.endsWith("/src/main/integrations.ts") ? {path: "locator", namespace: "lookup-race"} : undefined;
        });
        builder.onLoad({filter:/.*/, namespace:"lookup-race"}, () => ({
          contents: `import {locateCommandSync as locate} from ${JSON.stringify(join(process.cwd(), "src/server/executables/locator.ts"))};
export function locateCommandSync(command) { ${beforeCliLookup}; return locate(command); }`,
          loader: "js",
        }));
      }
    }}],
    logLevel:"silent",
  });
  return outfile;
}
