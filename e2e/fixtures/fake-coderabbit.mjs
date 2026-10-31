#!/usr/bin/env node
// Vendor-shaped local protocol fake. Never contacts CodeRabbit or a model provider.
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
let script = {};
try { script = JSON.parse(readFileSync(process.env.MC_E2E_CODERABBIT_SCRIPT, "utf8")); } catch { /* defaults */ }
if (process.env.MC_E2E_RECORD_DIR) appendFileSync(`${process.env.MC_E2E_RECORD_DIR}/coderabbit.jsonl`, JSON.stringify({ args, cwd: process.cwd(), home: process.env.HOME, autoUpdate: process.env.CODERABBIT_CLI_DISABLE_AUTO_UPDATE }) + "\n");
if (args[0] === "--version") { console.log(script.old ? "0.9.0" : "0.9.1"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") { console.log(JSON.stringify({ type: "status", phase: "auth", authenticated: !script.unauthenticated })); process.exit(0); }
if (args[0] !== "review" || !args.includes("--agent") || args.includes("--use-credits")) { process.exit(1); }
const emit = e => process.stdout.write(JSON.stringify(e) + "\n");
process.stderr.write("CodeRabbit diagnostic: deliberately not NDJSON\n");
emit({ type: "review_context", expectedDuration: "15 minutes" });
const findings = script.mode === "findings" ? [
 { type: "finding", severity: "major", fileName: "README.md", title: "Early retained finding", comment: "Verify the actual behavior before changing it", codegenInstructions: "Inspect the complete retained findings", suggestions: ["untrusted suggestion"], startLine: 1, endLine: 2 },
 { type: "finding", severity: "minor", fileName: "README.md", title: "Advisory retained finding", comment: "Keep this advisory too" },
] : [];
for (const finding of findings) emit(finding);
if (script.largeRaw) for (let i = 0; i < 40; i++) emit({ type: "future_additive_event", diagnostic: "x".repeat(60000) });
if (script.mode === "incomplete") { emit({ type: "error", errorType: "rate_limit", retryAfterSeconds: script.retryAfterSeconds ?? 60 }); process.exit(1); }
const threshold = args[args.indexOf("--gate") + 1];
const blocking = findings.filter(f => ["critical","major","minor","trivial","info"].indexOf(f.severity) <= ["critical","major","minor","trivial","info"].indexOf(threshold)).length;
emit({ type: "complete", status: script.mode === "no-change" ? "review_skipped" : "review_completed", outcome: "completed", findings: findings.length, ...(script.omitCoverage ? {} : { unreviewedFileCount: 0 }),
 gate: { threshold, status: blocking ? "blocked" : "passed", blockingFindings: blocking } });
process.exitCode = blocking ? 2 : 0;
