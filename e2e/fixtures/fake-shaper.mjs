// A `command` shaper for the browser suite. Run as `node fake-shaper.mjs <mode> [ms] [--wait <file>]`:
// it reads one shaping request from stdin and answers on stdout the way its mode says. No
// network, no model, no tokens.
//
//   ok        two guidance entries for the select stage
//   degraded  one fallback entry, and says it is degraded
//   slow      waits `ms` (default 20 s) before answering, so its call times out
//   garbage   prints something that is not JSON
//   route     a router: `route <name>:<point>[,<name>:<point>...]` answers those skills, each
//             with a fixed reason id, as FR-04's `route_skills` would
//
// `--wait <file>` holds the answer until that file exists, so a spec can look at the dispatch
// while it is still shaping context, then release it.
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const waitAt = args.indexOf("--wait");
const gate = waitAt === -1 ? null : args[waitAt + 1];
const [mode = "ok", ms] = waitAt === -1 ? args : args.slice(0, waitAt);
const sleep = (delay) => new Promise((done) => setTimeout(done, delay));

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const reply = (value) => process.stdout.write(JSON.stringify(value));

if (gate) while (!existsSync(gate)) await sleep(50);

switch (mode) {
  case "ok":
    reply({
      version: "e2e-1",
      guidance: [
        { id: "payments/idempotency", title: "Idempotent charges", body: `Charge each key once in ${request.repo.name}.` },
        { id: "payments/retries", title: "Retry budget", body: "Back off exponentially and stop after five attempts." },
      ],
    });
    break;
  case "degraded":
    reply({ degraded: true, notes: ["The guidance index is stale."], guidance: [{ id: "fallback", title: "Fallback", body: "Use the defaults." }] });
    break;
  case "slow":
    await sleep(Number(ms ?? 20_000));
    reply({ guidance: [{ id: "late", body: "This arrives too late to be used." }] });
    break;
  case "garbage":
    process.stdout.write("this is not json");
    break;
  case "route":
    reply({
      version: "e2e-route-1",
      skills: String(ms ?? "").split(",").filter(Boolean).map((pair) => {
        const [name, point] = pair.split(":");
        return { name, lifecycle_point: point, reason_id: `e2e/${name}` };
      }),
    });
    break;
  default:
    process.stderr.write(`unknown mode ${mode}`);
    process.exit(2);
}
