import { applyPiExtensionConfig } from "../src/server/extensions/config.ts";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--uninstall")) {
  console.error("Usage: npm run install-pi-extension [-- --uninstall]");
  process.exitCode = 1;
} else {
  const result = applyPiExtensionConfig({ enabled: !args.includes("--uninstall") });
  console.log(JSON.stringify(result, null, 2));
  if (result.blocked.length) process.exitCode = 1;
}
