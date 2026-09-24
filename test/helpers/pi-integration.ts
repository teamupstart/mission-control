import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { piIntegrationManifest } from "../../src/server/extensions/pi-artifact.ts";
import { MISSION_MCP_TOOLS } from "../../src/server/mission-mcp.ts";

export const piMetadataSource = `import {readFileSync,realpathSync} from 'node:fs';
import {dirname,join} from 'node:path'; import {fileURLToPath} from 'node:url';
const dir = dirname(realpathSync(fileURLToPath(import.meta.url)));
export default () => {}; export const missionControlBuild = {
version:JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8')).buildId,
mcpServerPath:join(dir,'mcp-server.mjs')};`;
export const piBridgeSource = (tools: readonly string[] = MISSION_MCP_TOOLS) => `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line', l => { const m=JSON.parse(l); if(m.id) console.log(JSON.stringify({jsonrpc:'2.0', id:m.id, result:m.method==='tools/list'?{tools:${JSON.stringify(tools.map(name => ({ name })))} }:{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'fixture',version:'1'}}})); });`;
export function sealPiIntegration(dir: string) {
  const manifest = piIntegrationManifest(readFileSync(join(dir, "extension.js")), readFileSync(join(dir, "mcp-server.mjs")));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest) + "\n");
  return manifest;
}
export function writePiIntegration(dir: string, source = piMetadataSource, bridge = piBridgeSource()) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "extension.js"), source);
  writeFileSync(join(dir, "mcp-server.mjs"), bridge);
  return sealPiIntegration(dir);
}
