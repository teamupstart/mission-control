import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, normalize, resolve } from "node:path";

const root = process.cwd();
const initialFiles = ["README.md", "AGENTS.md", "e2e/README.md"];

async function markdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && extname(entry.name) === ".md") files.push(path);
  }
  return files;
}

function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "");
}

function anchors(markdown) {
  const result = new Set();
  for (const line of markdown.split("\n")) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) result.add(slug(heading[2]));
    for (const match of line.matchAll(/<a\s+[^>]*\bid=["']([^"']+)["'][^>]*>/gi)) result.add(match[1]);
  }
  return result;
}

function destinations(markdown) {
  const found = [];
  for (const match of markdown.matchAll(/!?(?:\[[^\]]*\])\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g)) {
    found.push(match[1].replace(/^<|>$/g, ""));
  }
  return found;
}

const files = [...new Set([...initialFiles, ...await markdownFiles("docs")])];
const cache = new Map();
const failures = [];

for (const file of files) {
  const markdown = await readFile(file, "utf8");
  for (const destination of destinations(markdown)) {
    if (/^(?:[a-z][a-z+.-]*:|\/\/)/i.test(destination)) continue;
    const [rawPath, fragment] = destination.split("#", 2);
    const target = rawPath ? normalize(resolve(dirname(file), rawPath.split("?", 1)[0])) : resolve(file);
    if (!target.startsWith(`${root}/`) && target !== root) {
      failures.push(`${file}: outside repository: ${destination}`);
      continue;
    }
    try {
      await access(target);
    } catch {
      failures.push(`${file}: missing target: ${destination}`);
      continue;
    }
    if (!fragment || extname(target) !== ".md") continue;
    if (!cache.has(target)) cache.set(target, anchors(await readFile(target, "utf8")));
    if (!cache.get(target).has(fragment)) {
      failures.push(`${file}: missing anchor: ${destination}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Verified ${files.length} Markdown files and their intra-repository links.`);
}
