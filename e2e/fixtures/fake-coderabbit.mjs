#!/usr/bin/env node
// Vendor-shaped local protocol fake. Never contacts CodeRabbit or a model provider.
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
let script = {};
try { script = JSON.parse(readFileSync(process.env.MC_E2E_CODERABBIT_SCRIPT, "utf8")); } catch { /* defaults */ }
if (process.env.MC_E2E_RECORD_DIR) appendFileSync(`${process.env.MC_E2E_RECORD_DIR}/coderabbit.jsonl`, JSON.stringify({ args, cwd: process.cwd(), home: process.env.HOME, autoUpdate: process.env.CODERABBIT_CLI_DISABLE_AUTO_UPDATE }) + "\n");
if (args[0] === "--version") { console.log(script.old ? "0.9.0" : script.reviewedFiles ? "0.9.2" : "0.9.1"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") { console.log(JSON.stringify({ type: "status", phase: "auth", authenticated: !script.unauthenticated })); process.exit(0); }
if (args[0] !== "review" || !args.includes("--agent") || args.includes("--use-credits")) { process.exit(1); }
const emit = e => process.stdout.write(JSON.stringify(e) + "\n");
process.stderr.write("CodeRabbit diagnostic: deliberately not NDJSON\n");
emit({ type: "review_context", expectedDuration: "15 minutes" });
const findings = script.longTitles ? Array.from({ length: 8 }, (_, i) => ({
 type: "finding", severity: "major", fileName: "README.md", title: `Finding ${i + 1}: ${"x".repeat(250)}`, comment: "Retain this complete finding",
})) : script.mode === "findings" ? [
 { type: "finding", severity: "major", fileName: "README.md", title: "Early retained finding", comment: "Verify the actual behavior before changing it", codegenInstructions: "Inspect the complete retained findings", suggestions: ["untrusted suggestion"], startLine: 1, endLine: 2 },
 { type: "finding", severity: "minor", fileName: "README.md", title: "Advisory retained finding", comment: "Keep this advisory too" },
] : [];
for (const finding of findings) emit(finding);
if (script.largeRaw) for (let i = 0; i < 40; i++) emit({ type: "future_additive_event", diagnostic: "x".repeat(60000) });
if (script.mode === "incomplete") { emit({ type: "error", errorType: "rate_limit", retryAfterSeconds: script.retryAfterSeconds ?? 60 }); process.exit(1); }
const threshold = args[args.indexOf("--gate") + 1];
const blocking = findings.filter(f => ["critical","major","minor","trivial","info"].indexOf(f.severity) <= ["critical","major","minor","trivial","info"].indexOf(threshold)).length;
// CLI 0.9.1 reports an unreviewed-file count. 0.9.2 dropped it for the list of reviewed files,
// which this fake derives from the pinned comparison it was asked to review.
const coverage = () => {
 if (script.omitCoverage) return {};
 if (!script.reviewedFiles) return { unreviewedFileCount: 0 };
 const base = args[args.indexOf("--base-commit") + 1];
 const files = execFileSync("git", ["diff", "--name-only", "--no-renames", "--diff-filter=d", "-z", base, "HEAD", "--"], { encoding: "utf8" }).split("\0").filter(Boolean);
 return { reviewedFiles: script.reviewedFiles === "missing-one" ? files.slice(1) : files };
};
emit({ type: "complete", status: script.mode === "no-change" ? "review_skipped" : "review_completed", findings: findings.length,
 gate: { threshold, status: blocking ? "blocked" : "passed", blockingFindings: blocking }, ...coverage(), outcome: "completed" });
process.exitCode = blocking ? 2 : 0;
