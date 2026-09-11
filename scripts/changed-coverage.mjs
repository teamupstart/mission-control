/**
 * Changed-executable coverage for a `.tsx`, measured against the text V8 actually compiled.
 *
 * Every earlier attempt at this failed the same way: the offsets and the source disagreed.
 * Node's LCOV reporter maps V8 ranges back through the loader's source map and, for JSX, gets
 * it wrong - esbuild collapses a multi-line element into one call, so lines inside a rendered
 * element come back unhit. In this repository `runEvidenceCitations` reported hits while its
 * ONLY call site reported zero, which cannot both be true. Reproducing the loader's output to
 * map the ranges by hand does not work either, because `tsx` strips comments and embeds the
 * filename in every `jsxDEV` call, and a reproduction off by one byte is off by every offset
 * after it. Capturing the output from a `load` hook does not work because the hook that runs
 * first sees the source before the transform, not after.
 *
 * So this asks V8 for both halves and reproduces nothing. `Profiler.takePreciseCoverage` gives
 * exact character ranges, and `Debugger.getScriptSource` gives the exact text those ranges
 * index, inline source map and all. The two are self-consistent by construction.
 *
 * The denominator is every statement and every function-like node the compiler finds on a
 * changed line - arrows passed to `onClick`, callbacks handed to `.then`, and the branches
 * inside them included, because those are the changed runtime behaviour.
 */
import { Session } from "node:inspector/promises";
import { run } from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { TraceMap, allGeneratedPositionsFor } from "@jridgewell/trace-mapping";
import ts from "typescript";

const argv = process.argv.slice(2);
const browserDir = (() => {
  const at = argv.indexOf("--browser");
  return at === -1 ? null : argv[at + 1];
})();
const rest = browserDir === null
  ? argv
  : argv.filter((a, i) => a !== "--browser" && i !== argv.indexOf("--browser") + 1);
const base = rest[0];
const testFiles = rest.slice(1).filter((a) => a.startsWith("test/"));
const targets = rest.slice(1).filter((a) => !a.startsWith("test/"));

/**
 * The source map entry for one target file, matched on its repository-relative PATH.
 *
 * By path and not by basename, which is the difference between measuring this file and measuring
 * one that happens to share its name. `src/web/workflows/run-model.ts` and a `run-model.ts`
 * anywhere else both end with the same basename, and a bundle carries hundreds of sources - the
 * first `endsWith` hit is not the file that was asked for, and nothing downstream can tell.
 * Returns null rather than guessing, so the caller reports the file as unmeasurable.
 */
function sourceEntryFor(tracer, file) {
  return tracer.sources.find((src) => src && (src === file || src.endsWith(`/${file}`))) ?? null;
}

/**
 * Lines a BROWSER executed, mapped back through the built bundle's source map.
 *
 * A JSX event handler and a dependency-injection adapter run nowhere else, so a node-only
 * measurement reports them unexercised however hard the Playwright specs press them. The bundle
 * is built with `--sourcemap` for measurement only - no committed configuration changes - and
 * every original position is asked of that map the same way the in-process half asks the
 * loader's.
 */
async function browserCovered(dir, targetFiles) {
  const { readdirSync, existsSync } = await import("node:fs");
  // Keyed by unit, valued by whether the browser RAN it. A unit the browser measured and did not
  // run is `false`, which is a different answer from absent: absent means this half could not
  // see it at all, and only absent may be dropped from the denominator.
  const covered = new Map(targetFiles.map((f) => [f, new Map()]));
  if (!dir) return covered;
  // Told to read a directory and finding none is a mistake, not an absence. Returning empty here
  // would measure the node half alone and print it against the same floor.
  if (!existsSync(dir)) {
    throw new Error(
      `--browser ${dir} does not exist. Run the Playwright specs with MC_COVERAGE=1 and`
      + ` MC_COVERAGE_DIR set to that path first.`,
    );
  }
  const bundles = new Map();
  const missingMaps = new Set();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    for (const entry of JSON.parse(readFileSync(join(dir, name), "utf8"))) {
      if (!entry.url.includes("/assets/")) continue;
      const asset = entry.url.split("/assets/")[1]?.split("?")[0];
      if (!asset) continue;
      const mapPath = join("dist/web/assets", `${asset}.map`);
      if (!existsSync(mapPath)) {
        // Loudly, because the failure is silent otherwise: a production `npm run build` between
        // the Playwright run and this one replaces the bundle and takes its map with it, and the
        // browser half then contributes nothing while still printing a plausible number.
        missingMaps.add(asset);
        continue;
      }
      let bundle = bundles.get(asset);
      if (!bundle) {
        const map = JSON.parse(readFileSync(mapPath, "utf8"));
        const code = readFileSync(join("dist/web/assets", asset), "utf8");
        const lineStarts = [0];
        for (let i = 0; i < code.length; i++) if (code[i] === "\n") lineStarts.push(i + 1);
        bundle = { tracer: new TraceMap(map), lineStarts, ranges: new Map() };
        bundles.set(asset, bundle);
      }
      /*
       * SUMMED per range, never overwritten. Playwright runs these specs across four workers,
       * so the same bundle is measured several times over and the same range arrives once per
       * page that loaded it. Keeping whichever arrived first would report a handler as never
       * run because the worker that did not click it happened to be read first, and it would
       * also break the arithmetic an absent outcome depends on: "reached more often than the
       * arm ran" is only true of the totals.
       */
      for (const fn of entry.functions) {
        for (const range of fn.ranges) {
          const key = `${range.startOffset}:${range.endOffset}`;
          const seen = bundle.ranges.get(key);
          if (seen) seen.count += range.count;
          else bundle.ranges.set(key, { ...range });
        }
      }
    }
  }
  for (const bundle of bundles.values()) {
    const countOffset = (offset) => {
      let best = null;
      for (const range of bundle.ranges.values()) {
        if (offset < range.startOffset || offset >= range.endOffset) continue;
        const extent = range.endOffset - range.startOffset;
        if (best === null || extent < best.extent) best = { extent, count: range.count };
      }
      return best === null ? null : best.count;
    };
    for (const file of targetFiles) {
      const sourceName = sourceEntryFor(bundle.tracer, file);
      if (sourceName === null) continue;
      // The highest count across candidate mappings: a position can map to several places in a
      // bundle, and the construct ran if any of them did.
      const count = (pos) => {
        const generated = allGeneratedPositionsFor(bundle.tracer, {
          source: sourceName,
          line: pos.line,
          column: pos.column,
        });
        let best = null;
        for (const g of generated) {
          if (g.line === null) continue;
          const seen = countOffset((bundle.lineStarts[g.line - 1] ?? 0) + g.column);
          if (seen === null) continue;
          best = best === null ? seen : Math.max(best, seen);
        }
        return best;
      };
      const changed = changedLines(file);
      const answers = covered.get(file);
      for (const unit of executableUnits(file)) {
        if (!changed.has(unit.at.line)) continue;
        const answer = resolveUnit(unit, count);
        if (answer === null) continue;
        // Several bundles can each carry the file; running in any one of them is running.
        answers.set(unit.key, answers.get(unit.key) === true || answer);
      }
    }
  }
  // ANY missing map, not only all of them: one asset without a map silently drops whatever the
  // browser ran inside it, and the run would still print a number computed from the rest.
  if (missingMaps.size > 0) {
    throw new Error(
      `The browser coverage in ${dir} names ${[...missingMaps].join(", ")}, and dist/web/assets`
      + ` holds no source map for ${missingMaps.size === 1 ? "it" : "them"}. Rebuild with`
      + ` \`npx vite build --sourcemap\` before measuring, or the browser half is dropped and`
      + ` the number is wrong.`,
    );
  }
  return covered;
}

const session = new Session();
session.connect();
const scripts = new Map();
session.on("Debugger.scriptParsed", (event) => {
  if (event.params.url) scripts.set(event.params.url, event.params.scriptId);
});
await session.post("Debugger.enable");
await session.post("Profiler.enable");
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });

// `isolation: "none"` keeps the tests in THIS process, which is the whole point: coverage taken
// from a child process would be coverage of a V8 this session never spoke to.
const stream = run({ files: testFiles, isolation: "none", concurrency: 1 });
let failures = 0;
stream.on("test:fail", () => { failures += 1; });
for await (const _event of stream) void _event;

const { result } = await session.post("Profiler.takePreciseCoverage");

/**
 * How many times this generated offset ran. The innermost range containing it decides.
 *
 * The COUNT rather than a yes/no, because an absent branch outcome has no range of its own: an
 * `if` with no `else` never emits an else-range, and `a && b` never emits a range for "the left
 * was falsy". Those outcomes are the arithmetic between two counts - the times the construct was
 * reached minus the times its arm ran - so a boolean cannot express them.
 */
function countAt(entry, offset) {
  let best = null;
  for (const fn of entry.functions) {
    for (const range of fn.ranges) {
      if (offset < range.startOffset || offset >= range.endOffset) continue;
      const extent = range.endOffset - range.startOffset;
      if (best === null || extent < best.extent) best = { extent, count: range.count };
    }
  }
  return best === null ? null : best.count;
}

/**
 * Every outcome that can execute on its own, including the ones with no code of their own.
 *
 * A statement or a function is one unit. So is each arm of a conditional - and that includes the
 * arms nothing is written for. `if (x) return;` has a false outcome even though there is no
 * `else` to point at, and `a && b` has an outcome where `a` was falsy and `b` never evaluated.
 * The changed pane is full of both: guard clauses, and `{cond && <element/>}` in JSX. Crediting
 * those through the enclosing statement is exactly how a covered line hides an unexercised path.
 *
 * An absent outcome has no range of its own, so it is measured as arithmetic instead: it ran if
 * the construct was reached MORE times than its written arm ran. A unit carrying `outer` is one
 * of these, and is resolved by comparing two counts rather than by asking whether one is above
 * zero.
 */
function executableUnits(file) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const units = [];
  const posOf = (node) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return { line: line + 1, column: character };
  };
  /** A written unit: it ran if its own range ran. */
  const explicit = (node) => {
    const at = posOf(node);
    units.push({ key: `${at.line}:${at.column}`, at });
  };
  /** An unwritten outcome: it ran if `outer` was reached more often than `arm` ran. */
  const implicit = (outerNode, armNode, label) => {
    const outer = posOf(outerNode);
    const at = posOf(armNode);
    units.push({ key: `${outer.line}:${outer.column}:${label}`, at, outer });
  };
  const SHORT_CIRCUIT = new Set([
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
  ]);
  const walk = (node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isTypeNode(node)) {
      return;
    }
    if ((ts.isStatement(node) && !ts.isBlock(node)) || ts.isFunctionLike(node)) explicit(node);
    if (ts.isIfStatement(node)) {
      explicit(node.thenStatement);
      // The false outcome either has an `else` to point at or is the skip, which is counted by
      // reaching the `if` more often than the then-arm ran.
      if (node.elseStatement) explicit(node.elseStatement);
      else implicit(node, node.thenStatement, "else");
    }
    if (ts.isConditionalExpression(node)) {
      explicit(node.whenTrue);
      explicit(node.whenFalse);
    }
    if (ts.isBinaryExpression(node) && SHORT_CIRCUIT.has(node.operatorToken.kind)) {
      explicit(node.right);
      // And the outcome where the operator short-circuited and the right side never evaluated.
      implicit(node, node.right, "short");
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)
        || ts.isElementAccessExpression(node))
      && node.questionDotToken
    ) {
      explicit(node.questionDotToken);
      implicit(node, node.questionDotToken, "absent");
    }
    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) explicit(node);
    if ((ts.isParameter(node) || ts.isBindingElement(node)) && node.initializer) {
      explicit(node.initializer);
    }
    node.forEachChild(walk);
  };
  source.forEachChild(walk);
  return units;
}

/** Resolve one unit against a coverage source, or null when that source never saw the file. */
function resolveUnit(unit, count) {
  const arm = count(unit.at);
  if (!unit.outer) return arm === null ? null : arm > 0;
  const outer = count(unit.outer);
  if (arm === null || outer === null) return null;
  return outer > arm;
}

function changedLines(file) {
  const diff = execFileSync("git", ["diff", "-U0", base, "--", file], { encoding: "utf8" });
  const changed = new Set();
  for (const raw of diff.split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (!m) continue;
    const start = Number(m[1]);
    const span = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < span; i++) changed.add(start + i);
  }
  return changed;
}

const fromBrowser = await browserCovered(browserDir, targets);

let total = 0;
let hit = 0;
const rows = [];
for (const file of targets) {
  const url = pathToFileURL(file).href;
  const entry = result.find((e) => e.url === url);
  const scriptId = scripts.get(url);
  const browserNodes = fromBrowser.get(file) ?? new Map();
  const changed = changedLines(file);
  /*
   * The node half, or nothing - and nothing is survivable.
   *
   * A file the in-process tests never loaded is not unmeasured: the browser may have run all of
   * it, which is the whole reason the browser half exists. So this resolves to a counting
   * function when node can measure the file and to null when it cannot, and the merge below
   * reads whichever halves answered rather than giving up on the first that did not.
   */
  const nodeCount = await (async () => {
    if (!entry || !scriptId) return { count: null, why: "the in-process tests never loaded it" };
    const { scriptSource } = await session.post("Debugger.getScriptSource", { scriptId });
    const mapComment = /\/\/# sourceMappingURL=data:application\/json[^,]*,([A-Za-z0-9+/=]+)/
      .exec(scriptSource);
    if (!mapComment) {
      return { count: null, why: "the compiled text carries no inline source map" };
    }
    const tracer = new TraceMap(JSON.parse(Buffer.from(mapComment[1], "base64").toString("utf8")));
    // No `?? sources[0]` fallback: the first source in a loader's map is whatever it happened to
    // compile, and measuring it while printing this file's name is worse than measuring nothing.
    const sourceName = sourceEntryFor(tracer, file);
    if (sourceName === null) {
      return { count: null, why: "its source map names no entry for this path" };
    }
    const lineStarts = [0];
    for (let i = 0; i < scriptSource.length; i++) {
      if (scriptSource[i] === "\n") lineStarts.push(i + 1);
    }
    return {
      why: null,
      count: (pos) => {
        const generated = allGeneratedPositionsFor(tracer, {
          source: sourceName,
          line: pos.line,
          column: pos.column,
        });
        let best = null;
        for (const g of generated) {
          if (g.line === null) continue;
          const seen = countAt(entry, (lineStarts[g.line - 1] ?? 0) + g.column);
          if (seen === null) continue;
          best = best === null ? seen : Math.max(best, seen);
        }
        return best;
      },
    };
  })();
  if (nodeCount.count === null && browserNodes.size === 0) {
    rows.push(`${file}\n  not measurable: ${nodeCount.why}, and no browser run covers it`);
    continue;
  }
  /*
   * KEYED BY NODE, never by line.
   *
   * An earlier revision collapsed every executable node on a source line into one result, so
   * `onLoaded: (id, url) => setBodies(...)` - a property, an arrow and a call on one line -
   * counted once, and one of the three running credited the other two. A line is not the unit
   * of execution; a statement or a function is. Each position is its own entry, so a callback
   * that never ran cannot hide behind a sibling that did.
   */
  const perNode = new Map();
  for (const unit of executableUnits(file)) {
    if (!changed.has(unit.at.line)) continue;
    const key = unit.key;
    const fromNode = nodeCount.count === null ? null : resolveUnit(unit, nodeCount.count);
    const ranInBrowser = browserNodes.get(key);
    /*
     * Merged, not replaced, and consulted before anything is dropped.
     *
     * A unit either half saw run is exercised by the test suite, which is the question; the two
     * halves reach different code by construction, one rendering the module and the other
     * clicking it. Only a unit NEITHER half could resolve leaves the denominator - an earlier
     * revision skipped on the node half's `null` alone, which deleted every JSX handler the
     * browser proved from both the numerator and the denominator.
     */
    if (fromNode === null && ranInBrowser === undefined) continue;
    perNode.set(key, fromNode === true || ranInBrowser === true);
  }
  const covered = [...perNode.values()].filter(Boolean).length;
  total += perNode.size;
  hit += covered;
  const pct = perNode.size === 0 ? 100 : (covered / perNode.size) * 100;
  const missed = [...perNode]
    .filter(([, ok]) => !ok)
    .map(([key]) => key)
    .sort((a, b) => Number(a.split(":")[0]) - Number(b.split(":")[0]));
  const src = readFileSync(file, "utf8").split("\n");
  rows.push(
    `${file}\n  changed executable units ${perNode.size} | covered ${covered} | ${pct.toFixed(2)}%`
    + (missed.length
      ? `\n  uncovered: ${missed.map((key) => {
        const [line, column, label] = key.split(":");
        // A label names an outcome nothing is written for: the skip past an `if` with no
        // `else`, or the short-circuit that never evaluated a right-hand side.
        const suffix = label ? ` [${label}]` : "";
        return `${line}:${column}${suffix} ${src[Number(line) - 1].trim().slice(0, 40)}`;
      }).join("\n             ")}`
      : ""),
  );
}

session.disconnect();
console.log(rows.join("\n"));
const pct = total === 0 ? 100 : (hit / total) * 100;
console.log(
  `\nCHANGED EXECUTABLE UNITS, measured against the text V8 compiled`
  + `\n(each statement, arrow, handler, callback and BRANCH ARM counted separately):`,
);
console.log(`  ${hit}/${total} = ${pct.toFixed(2)}%`);
console.log(`  test failures during measurement: ${failures}`);
console.log(pct >= 80 ? "PASS: at or above the 80% floor" : "BELOW the 80% floor");
