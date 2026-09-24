import { applyPiExtensionConfig } from "../src/server/extensions/config.ts";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--uninstall")) {
  console.error("Usage: pi-installer [--uninstall]");
  process.exitCode = 1;
} else {
  const result = await applyPiExtensionConfig({ enabled: !args.includes("--uninstall") });
  console.log(JSON.stringify(result, null, 2));
  if (result.blocked.length) process.exitCode = 1;
}
