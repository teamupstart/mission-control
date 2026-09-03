import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  after,
  test,
} from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Product reports can publish publicly, so this file exercises the service through injected
// subprocesses and an isolated upload root. No test may inherit the operator's state or gh.
const home = mkdtempSync(join(tmpdir(), "mission-product-issues-"));
process.env.MISSION_HOME = home;

const {
  McpProductIssueRequestSchema,
  ProductIssueRequestSchema,
} = await import("../src/shared/protocol.ts");
const {
  PRODUCT_ISSUE_BODY_MARKER,
  PRODUCT_ISSUE_CLIENT_ENV,
  PRODUCT_ISSUE_LIMITS,
  PRODUCT_ISSUE_MINIMUM_GH_VERSION,
  PRODUCT_ISSUE_REQUIRED_LABELS,
  PRODUCT_ISSUE_SOURCE_LABELS,
  PRODUCT_ISSUE_STATUS_LABEL,
  PRODUCT_ISSUE_TYPE_LABELS,
  PRODUCT_ISSUE_TYPES,
  productIssueClientFromEnvironment,
} = await import("../src/shared/product-issues.ts");
const {
  DEFAULT_PRODUCT_ISSUES_REPO,
  productIssuesRepo,
} = await import("../src/server/config.ts");
const {
  ProductIssueService,
  PRODUCT_ISSUE_ATTACHMENTS_DISABLED,
  productIssueCreateArgs,
  productIssueLabels,
  renderProductIssueBody,
  supportsProductIssueAttachments,
} = await import("../src/server/product-issues.ts");
const {
  UPLOADS_DIR,
  resolveImageUpload,
  saveImageUpload,
} = await import("../src/server/uploads.ts");
const { stubRun } = await import("../src/server/util/exec.ts");
import type { SavedUpload } from "../src/server/uploads.ts";
import type { ProductIssueRunner } from "../src/server/product-issues.ts";
import type { ProductIssueRequest } from "../src/shared/product-issues.ts";

after(() => rmSync(home, { recursive: true, force: true }));

const target = () => ({ ok: true as const, repo: "acme/public-issues" });

/**
 * Somebody is at the machine and answers the publish dialog.
 *
 * Every service below gets one, because a service WITHOUT one refuses to publish and reports
 * `consent-unavailable` from preflight before it ever runs `gh` - which is correct behaviour
 * for a daemon nobody can ask, and would quietly turn each case here into a test of that one
 * thing. `product-issue-consent.test.ts` and `product-issues-http.test.ts` own that path.
 */
const CONSENTS = { unavailable: null, ask: () => Promise.resolve(true) };

function request(overrides: Partial<ProductIssueRequest> = {}): ProductIssueRequest {
  return {
    type: "bug",
    title: "The board loses focus",
    details: "Observed: focus disappears.\n\nExpected: the selected card stays active.",
    attachmentUploadIds: [],
    requestId: randomUUID(),
    client: "browser",
    ...overrides,
  };
}

test("the append-only vocabulary, maps, and bounded schemas agree", () => {
  assert.deepEqual(PRODUCT_ISSUE_TYPES, [
    "bug",
    "feature-request",
    "documentation",
    "usability",
    "other",
  ]);
  assert.deepEqual(Object.keys(PRODUCT_ISSUE_TYPE_LABELS), [...PRODUCT_ISSUE_TYPES]);
  assert.equal(PRODUCT_ISSUE_STATUS_LABEL, "status:needs-triage");
  assert.equal(PRODUCT_ISSUE_SOURCE_LABELS.dashboard, "source:dashboard");
  assert.equal(PRODUCT_ISSUE_SOURCE_LABELS.agent, "source:agent");
  assert.equal(PRODUCT_ISSUE_CLIENT_ENV, "MISSION_PRODUCT_ISSUE_CLIENT");
  assert.equal(PRODUCT_ISSUE_MINIMUM_GH_VERSION, "2.99.0");
  assert.equal(productIssueClientFromEnvironment("electron"), "electron");
  assert.equal(productIssueClientFromEnvironment("browser"), "browser");
  assert.equal(productIssueClientFromEnvironment("forged"), "browser");
  assert.equal(productIssueClientFromEnvironment(undefined), "browser");

  const parsed = ProductIssueRequestSchema.parse({
    ...request(),
    title: "  A title  ",
    details: "  Details  ",
    attachmentUploadIds: undefined,
  });
  assert.equal(parsed.title, "A title");
  assert.equal(parsed.details, "Details");
  assert.deepEqual(parsed.attachmentUploadIds, []);
  assert.equal(
    ProductIssueRequestSchema.safeParse({ ...request(), repo: "somewhere/else" }).success,
    false,
    "caller-owned repositories are rejected rather than merely ignored",
  );
  assert.equal(
    ProductIssueRequestSchema.safeParse({
      ...request(),
      title: "😀".repeat(51),
    }).success,
    false,
    "title bounds count UTF-8 bytes",
  );
  assert.equal(
    ProductIssueRequestSchema.safeParse({
      ...request(),
      attachmentUploadIds: ["same.png", "same.png"],
    }).success,
    false,
  );
  assert.equal(
    McpProductIssueRequestSchema.safeParse({
      ...request(),
      env: {},
      labels: ["caller-owned"],
    }).success,
    false,
  );
});

test("attachment support accepts stable gh 2.99.0 and newer, but not previews or older releases", () => {
  assert.equal(supportsProductIssueAttachments("gh version 2.99.0 (2026-09-01)\n"), true);
  assert.equal(supportsProductIssueAttachments("gh version 2.100.0 (2026-09-08)\n"), true);
  assert.equal(supportsProductIssueAttachments("gh version 3.0.0 (2027-01-01)\n"), true);
  assert.equal(supportsProductIssueAttachments("gh version 2.98.0 (2026-08-20)\n"), false);
  assert.equal(supportsProductIssueAttachments("gh version 2.99.0-attach-preview\n"), false);
  assert.equal(supportsProductIssueAttachments("unreadable\n"), false);
});

test("target configuration accepts only exact owner/name and defaults safely", () => {
  assert.deepEqual(productIssuesRepo(undefined), {
    ok: true,
    repo: DEFAULT_PRODUCT_ISSUES_REPO,
  });
  assert.deepEqual(productIssuesRepo("downstream/reports"), {
    ok: true,
    repo: "downstream/reports",
  });
  for (const invalid of [
    "downstream",
    "downstream/reports/extra",
    " downstream/reports",
    "-owner/reports",
    "owner/..",
    "owner/reports?tab=1",
  ]) {
    assert.equal(productIssuesRepo(invalid).ok, false, invalid);
  }
});

test("body, labels, and argv are deterministic and keep details off argv", () => {
  const draft = request({ title: "Use `$(safe)`", details: "Reporter **Markdown** stays." });
  const environment = {
    missionControlVersion: "1.2.3",
    platform: "macOS" as const,
    architecture: "arm64" as const,
    client: "electron" as const,
  };
  const body = renderProductIssueBody(draft, environment);
  assert.equal(
    body,
    [
      "## Details",
      "",
      "Reporter **Markdown** stays.",
      "",
      "## Environment",
      "",
      "- Mission Control: 1.2.3",
      "- Platform: macOS / arm64",
      "- Client: electron",
      "",
      PRODUCT_ISSUE_BODY_MARKER,
    ].join("\n"),
  );
  const labels = productIssueLabels("usability", "agent");
  assert.deepEqual(labels, ["usability", "status:needs-triage", "source:agent"]);
  const args = productIssueCreateArgs("acme/public-issues", draft, labels);
  assert.deepEqual(args, [
    "issue",
    "create",
    "--repo",
    "acme/public-issues",
    "--title",
    "Use `$(safe)`",
    "--body-file",
    "-",
    "--label",
    "usability",
    "--label",
    "status:needs-triage",
    "--label",
    "source:agent",
  ]);
  assert.ok(!args.includes(draft.details));
});

test("preview and submission re-derive the agent source and send the body on stdin", async () => {
  const calls: Array<{
    bin: string;
    args: string[];
    options: Parameters<ProductIssueRunner>[2];
  }> = [];
  const runner: ProductIssueRunner = async (bin, args, options) => {
    calls.push({ bin, args, options });
    return stubRun({
      stdout: "Creating issue\nhttps://github.com/acme/public-issues/issues/42\n",
      stderr: "",
      code: 0,
    });
  };
  const service = new ProductIssueService({
      consent: CONSENTS,
    runner,
    target,
    version: "9.8.7",
    platform: "linux",
    architecture: "x64",
  });
  const input = request({ client: "electron" });
  const preview = service.preview("agent", input);
  assert.equal(preview.outcome, "preview");
  assert.equal(preview.outcome === "preview" ? preview.target : null, "acme/public-issues");
  assert.deepEqual(
    preview.outcome === "preview" ? preview.labels : [],
    ["bug", "status:needs-triage", "source:agent"],
  );
  assert.deepEqual(
    preview.outcome === "preview" ? preview.environment : null,
    {
      missionControlVersion: "9.8.7",
      platform: "Linux",
      architecture: "x64",
      client: "electron",
    },
  );

  const result = await service.submit("agent", input);
  assert.deepEqual(result, {
    outcome: "created",
    issueUrl: "https://github.com/acme/public-issues/issues/42",
    target: "acme/public-issues",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.bin.endsWith("gh"), true);
  assert.deepEqual(
    calls[0]!.args.filter((value, index, all) => all[index - 1] === "--label"),
    ["bug", "status:needs-triage", "source:agent"],
  );
  assert.match(calls[0]!.options?.input ?? "", /Observed: focus disappears/);
  assert.match(calls[0]!.options?.input ?? "", /<!-- mission-control-product-report:v1 -->/);
  assert.ok(!calls[0]!.args.join("\n").includes("Observed: focus disappears"));
});

test("retry-safe refusals release a request while unknown outcomes block duplicates", async () => {
  let attempts = 0;
  const retrying = new ProductIssueService({
      consent: CONSENTS,
    target,
    runner: async () => {
      attempts++;
      return attempts === 1
        ? stubRun({ stdout: "", stderr: "label missing", code: 1 })
        : stubRun({
            stdout: "https://github.com/acme/public-issues/issues/7\n",
            stderr: "",
            code: 0,
          });
    },
  });
  const retryRequest = request();
  retrying.preview("dashboard", retryRequest);
  assert.deepEqual(await retrying.submit("dashboard", retryRequest), {
    outcome: "refused",
    message: "GitHub CLI refused the issue: label missing",
    retrySafe: true,
  });
  assert.equal((await retrying.submit("dashboard", retryRequest)).outcome, "created");
  assert.equal(attempts, 2);

  let unknownCalls = 0;
  const uncertain = new ProductIssueService({
      consent: CONSENTS,
    target,
    runner: async () => {
      unknownCalls++;
      return { ...stubRun({ stdout: "", stderr: "", code: 1 }), outcomeUnknown: true };
    },
  });
  const unknownRequest = request();
  uncertain.preview("dashboard", unknownRequest);
  assert.equal((await uncertain.submit("dashboard", unknownRequest)).outcome, "unknown");
  assert.equal((await uncertain.submit("dashboard", unknownRequest)).outcome, "unknown");
  assert.equal(unknownCalls, 1, "an uncertain opening cannot launch gh twice");
});

test("a concurrent double submit runs one external writer", async () => {
  let release!: (value: ReturnType<typeof stubRun>) => void;
  const pending = new Promise<ReturnType<typeof stubRun>>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const service = new ProductIssueService({
      consent: CONSENTS,
    target,
    runner: async () => {
      calls++;
      return pending;
    },
  });
  const input = request();
  service.preview("dashboard", input);
  const first = service.submit("dashboard", input);
  const second = await service.submit("dashboard", input);
  assert.equal(second.outcome, "unknown");
  assert.equal(calls, 1);
  release(stubRun({
    stdout: "https://github.com/acme/public-issues/issues/9\n",
    stderr: "",
    code: 0,
  }));
  assert.equal((await first).outcome, "created");
});

test("production rejects attachments and demo mode remains inert before any gh call", async () => {
  let calls = 0;
  const runner: ProductIssueRunner = async () => {
    calls++;
    return stubRun({ stdout: "", stderr: "", code: 0 });
  };
  const production = new ProductIssueService({
      consent: CONSENTS,
    target,
    runner,
    attachments: PRODUCT_ISSUE_ATTACHMENTS_DISABLED,
  });
  const withImage = request({ attachmentUploadIds: ["image.png"] });
  assert.equal(production.preview("dashboard", withImage).outcome, "refused");
  assert.equal((await production.submit("dashboard", withImage)).outcome, "refused");

  const demo = new ProductIssueService({ target, runner, demoMode: true });
  const demoRequest = request();
  assert.equal(demo.preview("agent", demoRequest).outcome, "configuration");
  assert.equal((await demo.submit("agent", demoRequest)).outcome, "configuration");
  const preflight = await demo.preflight();
  assert.equal(preflight.ready, false);
  assert.equal(preflight.problems[0]?.code, "demo-mode");
  assert.equal(calls, 0);
});

test("preflight distinguishes binary, auth, repository, and label failures", async (t) => {
  const ok = stubRun({ stdout: "ok\n", stderr: "", code: 0 });
  const labels = stubRun({
    stdout: JSON.stringify([
      Array.from({ length: 100 }, (_, index) => ({ name: `extra-${index}` })),
      PRODUCT_ISSUE_REQUIRED_LABELS.map((name) => ({ name })),
    ]),
    stderr: "",
    code: 0,
  });

  async function preflightWith(results: ReturnType<typeof stubRun>[]) {
    let calls = 0;
    const args: string[][] = [];
    const service = new ProductIssueService({
      consent: CONSENTS,
      target,
      runner: async (_bin, argv) => {
        args.push(argv);
        return results[calls++] ?? ok;
      },
    });
    return { result: await service.preflight(), calls, args };
  }

  await t.test("invalid target", async () => {
    let calls = 0;
    const service = new ProductIssueService({
      consent: CONSENTS,
      target: () => productIssuesRepo("not-a-repo"),
      runner: async () => {
        calls++;
        return ok;
      },
    });
    const result = await service.preflight();
    assert.equal(result.problems[0]?.code, "invalid-target");
    assert.equal(calls, 0);
  });
  for (const [name, results, code] of [
    ["binary", [stubRun({ stdout: "", stderr: "not found", code: 1 })], "gh-unavailable"],
    ["auth", [ok, stubRun({ stdout: "", stderr: "login", code: 1 })], "gh-auth"],
    ["repository", [ok, ok, stubRun({ stdout: "", stderr: "missing", code: 1 })], "repository"],
    ["labels", [ok, ok, ok, stubRun({ stdout: "", stderr: "denied", code: 1 })], "labels"],
  ] as const) {
    await t.test(name, async () => {
      const { result } = await preflightWith([...results]);
      assert.equal(result.ready, false);
      assert.equal(result.problems[0]?.code, code);
    });
  }
  await t.test("missing labels", async () => {
    const { result } = await preflightWith([
      ok,
      ok,
      ok,
      stubRun({ stdout: JSON.stringify([[{ name: "bug" }]]), stderr: "", code: 0 }),
    ]);
    assert.equal(result.ready, false);
    assert.equal(result.problems[0]?.code, "labels");
    assert.match(result.problems[0]?.message ?? "", /source:agent/);
  });
  await t.test("ready when required labels are after the first page", async () => {
    const { result, calls, args } = await preflightWith([ok, ok, ok, labels]);
    assert.deepEqual(result, {
      ready: true,
      target: "acme/public-issues",
      attachments: {
        enabled: false,
        reason: "Screenshot upload is waiting for first-party GitHub CLI support",
      },
      problems: [],
    });
    assert.equal(calls, 4);
    assert.deepEqual(args[3], [
      "api",
      "--paginate",
      "--slurp",
      "repos/acme/public-issues/labels?per_page=100",
    ]);
  });
});

test("preflight enables attachments only for stable gh 2.99.0 or newer", async (t) => {
  for (const [version, enabled] of [
    ["2.99.0", true],
    ["2.98.0", false],
  ] as const) {
    await t.test(version, async () => {
      const service = new ProductIssueService({
        consent: CONSENTS,
        target,
        attachments: { enabled: true, uploadRoot: UPLOADS_DIR, resolveUpload: () => null },
        runner: async (_bin, args) => {
          if (args[0] === "--version") {
            return stubRun({ stdout: `gh version ${version} (test)\n`, stderr: "", code: 0 });
          }
          if (args[0] === "api") {
            return stubRun({
              stdout: JSON.stringify([PRODUCT_ISSUE_REQUIRED_LABELS.map((name) => ({ name }))]),
              stderr: "",
              code: 0,
            });
          }
          return stubRun({ stdout: "ok\n", stderr: "", code: 0 });
        },
      });
      const result = await service.preflight();
      assert.equal(result.ready, true);
      assert.equal(result.attachments.enabled, enabled);
      if (!enabled) assert.match(result.attachments.reason ?? "", /2\.99\.0 or newer/);
    });
  }
});

const pngHead = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function raster(name: string, bytes = pngHead.byteLength): SavedUpload {
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const path = join(UPLOADS_DIR, name);
  writeFileSync(path, pngHead);
  if (bytes > pngHead.byteLength) truncateSync(path, bytes);
  return { path, name, uploadId: name, bytes: statSync(path).size };
}

test("the injected attachment capability re-resolves, sniffs, bounds, and isolates argv", async (t) => {
  mkdirSync(UPLOADS_DIR, { recursive: true });

  await t.test("valid uploads become repeated first-party attach pairs", async () => {
    const first = saveImageUpload(pngHead, "first.png");
    const second = saveImageUpload(pngHead, "second.png");
    let argv: string[] = [];
    const service = new ProductIssueService({
      consent: CONSENTS,
      target,
      attachments: { enabled: true, uploadRoot: UPLOADS_DIR, resolveUpload: resolveImageUpload },
      runner: async (_bin, args) => {
        if (args[0] === "--version") {
          return stubRun({ stdout: "gh version 2.99.0 (test)\n", stderr: "", code: 0 });
        }
        argv = args;
        return stubRun({
          stdout: "https://github.com/acme/public-issues/issues/55\n",
          stderr: "",
          code: 0,
        });
      },
    });
    const input = request({ attachmentUploadIds: [first.uploadId, second.uploadId] });
    assert.equal(service.preview("dashboard", input).outcome, "preview");
    assert.equal((await service.submit("dashboard", input)).outcome, "created");
    assert.deepEqual(
      argv.flatMap((value, index) => value === "--attach" ? [argv[index + 1]!] : []),
      [realpathSync(first.path), realpathSync(second.path)],
    );
  });

  await t.test("concurrent attachment submits reserve before the version probe", async () => {
    const upload = saveImageUpload(pngHead, "concurrent.png");
    let releaseVersion!: (value: ReturnType<typeof stubRun>) => void;
    const versionPending = new Promise<ReturnType<typeof stubRun>>((resolve) => {
      releaseVersion = resolve;
    });
    let versionCalls = 0;
    let issueCreates = 0;
    const service = new ProductIssueService({
      consent: CONSENTS,
      target,
      attachments: { enabled: true, uploadRoot: UPLOADS_DIR, resolveUpload: resolveImageUpload },
      runner: async (_bin, args) => {
        if (args[0] === "--version") {
          versionCalls++;
          return versionPending;
        }
        issueCreates++;
        return stubRun({
          stdout: "https://github.com/acme/public-issues/issues/57\n",
          stderr: "",
          code: 0,
        });
      },
    });
    const input = request({ attachmentUploadIds: [upload.uploadId] });
    assert.equal(service.preview("dashboard", input).outcome, "preview");
    const first = service.submit("dashboard", input);
    const second = await service.submit("dashboard", input);
    assert.equal(second.outcome, "unknown");
    assert.equal(versionCalls, 1);
    assert.equal(issueCreates, 0);
    releaseVersion(stubRun({ stdout: "gh version 2.99.0 (test)\n", stderr: "", code: 0 }));
    assert.equal((await first).outcome, "created");
    assert.equal(issueCreates, 1);
  });

  await t.test("an older gh release cannot receive attachment argv", async () => {
    const upload = saveImageUpload(pngHead, "old-gh.png");
    let versionChecks = 0;
    let issueCreates = 0;
    const service = new ProductIssueService({
      consent: CONSENTS,
      target,
      attachments: { enabled: true, uploadRoot: UPLOADS_DIR, resolveUpload: resolveImageUpload },
      runner: async (_bin, args) => {
        if (args[0] === "--version") {
          versionChecks++;
          return stubRun({ stdout: "gh version 2.98.0 (test)\n", stderr: "", code: 0 });
        }
        issueCreates++;
        return stubRun({ stdout: "", stderr: "", code: 0 });
      },
    });
    const input = request({ attachmentUploadIds: [upload.uploadId] });
    assert.equal(service.preview("dashboard", input).outcome, "preview");
    const result = await service.submit("dashboard", input);
    assert.equal(result.outcome, "configuration");
    assert.match(result.outcome === "configuration" ? result.message : "", /2\.99\.0 or newer/);
    assert.equal(issueCreates, 0);
    assert.equal((await service.submit("dashboard", input)).outcome, "configuration");
    assert.equal(versionChecks, 2, "a read-only version refusal releases the submission claim");
  });

  await t.test("a partial upload is created once and returns a warning", async () => {
    const upload = saveImageUpload(pngHead, "partial.png");
    let issueCreates = 0;
    const service = new ProductIssueService({
      consent: CONSENTS,
      target,
      attachments: { enabled: true, uploadRoot: UPLOADS_DIR, resolveUpload: resolveImageUpload },
      runner: async (_bin, args) => {
        if (args[0] === "--version") {
          return stubRun({ stdout: "gh version 2.99.0 (test)\n", stderr: "", code: 0 });
        }
        issueCreates++;
        return stubRun({
          stdout: "https://github.com/acme/public-issues/issues/56\n",
          stderr: "failed to upload /private/tmp/mission-control/uploads/partial.png",
          code: 1,
        });
      },
    });
    const input = request({ attachmentUploadIds: [upload.uploadId] });
    assert.equal(service.preview("dashboard", input).outcome, "preview");
    const result = await service.submit("dashboard", input);
    assert.deepEqual(result, {
      outcome: "created",
      issueUrl: "https://github.com/acme/public-issues/issues/56",
      target: "acme/public-issues",
      warning:
        "The issue was created, but GitHub CLI reported that one or more screenshots were " +
        "not attached.",
    });
    assert.doesNotMatch(
      result.outcome === "created" ? result.warning ?? "" : "",
      /private\/tmp|partial\.png/,
    );
    assert.equal(issueCreates, 1);
    assert.equal((await service.submit("dashboard", input)).outcome, "unknown");
    assert.equal(issueCreates, 1);
  });

  await t.test("an attachment failure without the target URL blocks retry", async () => {
    const upload = saveImageUpload(pngHead, "partial-no-url.png");
    let issueCreates = 0;
    const service = new ProductIssueService({
      consent: CONSENTS,
      target,
      attachments: { enabled: true, uploadRoot: UPLOADS_DIR, resolveUpload: resolveImageUpload },
      runner: async (_bin, args) => {
        if (args[0] === "--version") {
          return stubRun({ stdout: "gh version 2.99.0 (test)\n", stderr: "", code: 0 });
        }
        issueCreates++;
        return stubRun({
          stdout: "https://cli.github.com/manual/gh_issue_create\n",
          stderr: "attachment publication failed",
          code: 1,
        });
      },
    });
    const input = request({ attachmentUploadIds: [upload.uploadId] });
    assert.equal(service.preview("dashboard", input).outcome, "preview");
    const result = await service.submit("dashboard", input);
    assert.equal(result.outcome, "unknown");
    assert.match(result.outcome === "unknown" ? result.message : "", /issue may exist/);
    assert.equal(issueCreates, 1);
    assert.equal((await service.submit("dashboard", input)).outcome, "unknown");
    assert.equal(issueCreates, 1);
  });

  async function attachmentRefusal(
    ids: string[],
    resolveUpload: (id: string, now: number) => SavedUpload | null,
  ): Promise<string> {
    let issueCreates = 0;
    const service = new ProductIssueService({
      consent: CONSENTS,
      target,
      attachments: { enabled: true, uploadRoot: UPLOADS_DIR, resolveUpload },
      runner: async (_bin, args) => {
        if (args[0] === "--version") {
          return stubRun({ stdout: "gh version 2.99.0 (test)\n", stderr: "", code: 0 });
        }
        issueCreates++;
        return stubRun({ stdout: "", stderr: "", code: 0 });
      },
    });
    const input = request({ attachmentUploadIds: ids });
    const preview = service.preview("dashboard", input);
    if (preview.outcome !== "preview") return preview.message;
    const result = await service.submit("dashboard", input);
    assert.equal(issueCreates, 0, "attachment validation must finish before issue creation");
    assert.equal(result.outcome, "refused");
    assert.equal((await service.submit("dashboard", input)).outcome, "refused");
    return result.outcome === "refused" ? result.message : "";
  }

  await t.test("stale locator", async () => {
    assert.match(await attachmentRefusal(["stale.png"], () => null), /missing, stale, or invalid/);
  });
  await t.test("path outside upload storage", async () => {
    const outside = join(home, "outside.png");
    writeFileSync(outside, pngHead);
    assert.match(
      await attachmentRefusal(["outside.png"], () => ({
        path: outside,
        name: "outside.png",
        uploadId: "outside.png",
        bytes: pngHead.byteLength,
      })),
      /outside Mission Control storage/,
    );
  });
  await t.test("symlink escaping upload storage", async () => {
    const outside = join(home, "symlink-target.png");
    const link = join(UPLOADS_DIR, "escape.png");
    writeFileSync(outside, pngHead);
    symlinkSync(outside, link);
    assert.match(
      await attachmentRefusal(["escape.png"], () => ({
        path: link,
        name: "escape.png",
        uploadId: "escape.png",
        bytes: pngHead.byteLength,
      })),
      /symbolic link/,
    );
  });
  await t.test("symlink inside upload storage", async () => {
    const targetPath = join(UPLOADS_DIR, "inside-target.png");
    const link = join(UPLOADS_DIR, "inside-link.png");
    writeFileSync(targetPath, pngHead);
    symlinkSync(targetPath, link);
    assert.match(
      await attachmentRefusal(["inside-link.png"], () => ({
        path: link,
        name: "inside-link.png",
        uploadId: "inside-link.png",
        bytes: pngHead.byteLength,
      })),
      /symbolic link/,
    );
  });
  await t.test("non-image bytes", async () => {
    const bad = raster("not-image.png");
    writeFileSync(bad.path, "not an image");
    assert.match(await attachmentRefusal([bad.uploadId], () => bad), /not a PNG/);
  });
  await t.test("per-image bound", async () => {
    const huge = raster("huge.png", PRODUCT_ISSUE_LIMITS.attachmentBytes + 1);
    assert.match(await attachmentRefusal([huge.uploadId], () => huge), /Each screenshot/);
  });
  await t.test("aggregate bound", async () => {
    const items = ["aggregate-1.png", "aggregate-2.png", "aggregate-3.png"].map((name) =>
      raster(name, 9 * 1024 * 1024));
    const byId = new Map(items.map((item) => [item.uploadId, item]));
    assert.match(
      await attachmentRefusal(items.map((item) => item.uploadId), (id) => byId.get(id) ?? null),
      /Screenshots must total/,
    );
  });
  await t.test("count bound", async () => {
    const service = new ProductIssueService({
      consent: CONSENTS,
      target,
      attachments: { enabled: true, uploadRoot: UPLOADS_DIR, resolveUpload: () => null },
    });
    const result = service.preview("dashboard", request({
      attachmentUploadIds: Array.from(
        { length: PRODUCT_ISSUE_LIMITS.attachmentCount + 1 },
        (_, index) => `image-${index}.png`,
      ),
    }));
    assert.equal(result.outcome, "refused");
  });
});
