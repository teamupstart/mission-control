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

// GitHub lowercases a heading, hyphenates its whitespace, and keeps `[\w-]`, so an underscore
// survives into the anchor. It is the one marker character that is also an ordinary identifier
// character - `MODULE_NOT_FOUND` and `app_config` reach the slugger intact - so stripping it
// alongside the emphasis markers produced anchors GitHub never renders.
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*~]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
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

function maskInlineCode(line) {
  let masked = "";
  let cursor = 0;

  while (cursor < line.length) {
    if (line[cursor] !== "`") {
      masked += line[cursor];
      cursor += 1;
      continue;
    }

    let openerEnd = cursor + 1;
    while (line[openerEnd] === "`") openerEnd += 1;
    const width = openerEnd - cursor;
    let closerStart = openerEnd;

    while (closerStart < line.length) {
      if (line[closerStart] !== "`") {
        closerStart += 1;
        continue;
      }
      let closerEnd = closerStart + 1;
      while (line[closerEnd] === "`") closerEnd += 1;
      if (closerEnd - closerStart === width) break;
      closerStart = closerEnd;
    }

    if (closerStart >= line.length) {
      masked += line.slice(cursor, openerEnd);
      cursor = openerEnd;
      continue;
    }

    const closerEnd = closerStart + width;
    masked += " ".repeat(closerEnd - cursor);
    cursor = closerEnd;
  }

  return masked;
}

function withoutCode(markdown) {
  let fence = null;
  const visible = [];

  for (const line of markdown.split("\n")) {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (fence) {
      if (
        marker?.[0] === fence.character
        && marker.length >= fence.width
        && new RegExp(`^[ \\t]{0,3}${fence.character}{${fence.width},}[ \\t]*$`).test(line)
      ) {
        fence = null;
      }
      visible.push("");
      continue;
    }

    if (marker) {
      fence = { character: marker[0], width: marker.length };
      visible.push("");
      continue;
    }

    visible.push(line);
  }

  return maskInlineCode(visible.join("\n"));
}

function destinations(markdown) {
  const found = [];
  for (const match of withoutCode(markdown).matchAll(/!?(?:\[[^\]]*\])\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g)) {
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
