/** Real Pi terminal protocol against a deterministic loopback provider. No account is used. */
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [home, cli, ...args] = process.argv.slice(2);
if (!home || !cli) throw new Error("the plan proof needs its isolated fixture home and pinned CLI");
process.argv = [process.execPath, cli, ...args];
if (args.includes("--mode")) {
  // Catalog discovery retains the suite's fixed fake and its exact invocation contract.
  await import("./fake-pi.mjs");
} else {
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "pi-agent");
  process.env.PI_OFFLINE = "1";
  const provider = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    writeFileSync(join(home, "pi-plan-payload.json"), body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ id: "plan-proof", object: "chat.completion.chunk", model: "pi-probe", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    frame({ role: "assistant", content: "Pi plan dispatch proof complete." }, null);
    frame({}, "stop"); res.end("data: [DONE]\n\n");
  });
  await new Promise(done => provider.listen(0, "127.0.0.1", done));
  const port = provider.address().port;
  const extension = join(home, "pi-plan-provider.js");
  writeFileSync(extension, `export default function(pi) { pi.registerProvider("mission-test", {
    baseUrl: "http://127.0.0.1:${port}/v1", apiKey: "local-proof", api: "openai-completions",
    models: [{ id: "pi-probe", name: "Pi Plan Proof", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }]
  }); }`);
  // Appended flags select only our provider even when the dispatch carries its catalog model.
  // The Mission extension is NOT passed via -e: Pi discovers the installed link itself.
  process.argv.push("--offline", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-approve", "-e", extension, "--provider", "mission-test", "--model", "pi-probe");
  // Confirm the isolated setup exists before importing a CLI that can create sessions.
  JSON.parse(readFileSync(join(home, "pi-extension.json"), "utf8"));
  await import(pathToFileURL(cli).href);
}
