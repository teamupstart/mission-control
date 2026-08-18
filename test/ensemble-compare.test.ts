/**
 * What is at stake is honest side-by-side evidence: complete file stats must stay complete while
 * patches are cut one path at a time, a missing path must say it is missing, and unknown cost must
 * never become a reassuring zero. These tests pin the pure choices and the loaded render states so
 * a future visual refactor cannot quietly turn Compare back into inference.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  EnsembleArtifact,
  EnsembleEvaluation,
  EnsembleRun,
} from "../src/shared/ensemble.ts";
import {
  fetchArtifactFilePatch,
  fetchArtifactFiles,
} from "../src/web/lib/api.ts";
import {
  EnsembleCompareView,
  type CompareFilesCache,
  type ComparePatchCache,
} from "../src/web/ensembles/EnsembleCompare.tsx";
import {
  artifactTouchesPath,
  buildFileMatrix,
  capCompareSelection,
  chooseCompareArtifactIds,
  compareClaim,
  comparePatchKey,
  updateCompareSelection,
} from "../src/web/ensembles/compare.ts";
import { detectPathTokens } from "../src/web/lib/workspaceLinks.ts";
import { RationaleText } from "../src/web/ensembles/results/dossier.tsx";
import { ENSEMBLE_RESULT_RENDERERS } from "../src/web/ensembles/results/index.ts";
import type {
  EnsembleArtifactFile,
  EnsembleArtifactPatch,
  EnsembleRunDetailResponse,
} from "../src/web/ensembles/types.ts";

const run: EnsembleRun = {
  id: "run-compare",
  sourceKind: "manual",
  sourceKey: "compare",
  sourceId: null,
  strategyId: "best_of_n",
  strategyKey: "best_of_n@1",
  strategyVersion: 1,
  strategyLabel: "Best of N",
  title: "Compare scheduler fixes",
  intent: "Keep wakeups ordered across restart",
  repoRoot: "/repo",
  baseBranch: "main",
  baseSha: "1234567890abcdef",
  plan: null,
  strategyConfig: {},
  status: "awaiting_decision",
  activeStageId: "decide",
  outcome: null,
  workflowHandoff: null,
  unreadable: null,
  failureAcknowledgedAt: null,
  error: null,
  createdAt: 1,
  updatedAt: 2,
  completedAt: null,
};

function artifact(
  id: string,
  attemptId: string,
  metadata: EnsembleArtifact["metadata"] = {},
  over: Partial<EnsembleArtifact> = {},
): EnsembleArtifact {
  return {
    id,
    runId: run.id,
    attemptId,
    kind: "commit",
    formatVersion: 1,
    attempt: 1,
    status: "ready",
    locator: { ref: `refs/mission-control/ensembles/${run.id}/${id}` },
    digest: id,
    metadata,
    error: null,
    createdAt: 1,
    readyAt: 2,
    ...over,
  };
}

const comparison: EnsembleEvaluation = {
  id: "eval-1",
  runId: run.id,
  stageAttemptId: "stage-1",
  attempt: 1,
  method: "comparative_review",
  runnerId: "claude",
  modelId: "opus",
  inputFingerprint: "fp",
  subjectArtifactIds: ["art-1", "art-2", "art-3"],
  result: {
    payloadVersion: 1,
    body: {
      version: 1,
      recommendedArtifactId: "art-1",
      comparison: "One is safer.",
      caveats: [],
      evidenceTruncated: false,
      scorecards: [
        {
          artifactId: "art-1",
          score: 92,
          rank: 1,
          confidence: 0.86,
          rationale: "The regression is covered in test/scheduler/restart.test.ts.",
          strengths: [],
          risks: [],
        },
        {
          artifactId: "art-2",
          score: 78,
          rank: 2,
          confidence: 0.64,
          rationale: "Touches src/server/scheduler.ts without the same guard.",
          strengths: [],
          risks: [],
        },
        {
          artifactId: "art-3",
          score: 70,
          rank: 3,
          confidence: 0.51,
          rationale: "README.md describes the tradeoff.",
          strengths: [],
          risks: [],
        },
      ],
    },
  },
  status: "succeeded",
  error: null,
  createdAt: 2,
  updatedAt: 3,
  finishedAt: 3,
};

function detail(artifacts = [
  artifact("art-1", "attempt-1", {
    reported: { summary: "Adds restart ordering.\nMore detail.", checks: ["npm test"] },
    agentCostUsd: 0,
  }),
  artifact("art-2", "attempt-2", {
    reported: { summary: "Uses a generation guard.", checks: ["npm test", "npm run typecheck"] },
  }),
  artifact("art-3", "attempt-3", {
    reported: { summary: "Documents and narrows the fix.", checks: [] },
    agentCostUsd: 0.31,
  }),
]): EnsembleRunDetailResponse {
  return {
    run,
    members: [
      {
        id: "member-1",
        runId: run.id,
        roleKey: "candidate-1",
        roleLabel: "Candidate 1",
        ordinal: 1,
        wave: 1,
        taskId: null,
        status: "submitted",
        selectedAttemptId: "attempt-1",
        resultLabel: null,
        error: null,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: "member-2",
        runId: run.id,
        roleKey: "candidate-2",
        roleLabel: "Candidate 2",
        ordinal: 2,
        wave: 1,
        taskId: null,
        status: "submitted",
        selectedAttemptId: "attempt-2",
        resultLabel: null,
        error: null,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: "member-3",
        runId: run.id,
        roleKey: "candidate-3",
        roleLabel: "Candidate 3",
        ordinal: 3,
        wave: 1,
        taskId: null,
        status: "submitted",
        selectedAttemptId: "attempt-3",
        resultLabel: null,
        error: null,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    attempts: [],
    artifacts,
    stageAttempts: [],
    evaluations: [comparison],
    decisions: [],
    llmCalls: [],
    events: [],
    pagination: { eventsTotal: 0, eventsReturned: 0, attemptsTotal: 0, attemptsReturned: 0 },
  };
}

const file = (
  path: string,
  insertions: number,
  deletions: number,
  over: Partial<EnsembleArtifactFile> = {},
): EnsembleArtifactFile => ({
  path,
  oldPath: null,
  insertions,
  deletions,
  binary: false,
  ...over,
});

function patch(
  files: EnsembleArtifactFile[],
  over: Partial<EnsembleArtifactPatch> = {},
): EnsembleArtifactPatch {
  return {
    files,
    filesChanged: files.length,
    insertions: files.reduce((total, candidate) => total + candidate.insertions, 0),
    deletions: files.reduce((total, candidate) => total + candidate.deletions, 0),
    patchPaths: [],
    patch: "",
    truncated: false,
    omittedBytes: 0,
    ...over,
  };
}

const subjectLabel = (artifactId: string): string =>
  `Candidate ${artifactId.slice(-1)} (claude · opus)`;

test("the file matrix unions, orders, marks only-in files, and preserves rename/binary cells", () => {
  const rows = buildFileMatrix(
    new Map([
      ["art-1", [file("src/shared.ts", 8, 2), file("src/one.ts", 2, 0)]],
      [
        "art-2",
        [
          file("src/shared.ts", 3, 1),
          file("src/moved.ts", 1, 1, { oldPath: "src/old.ts" }),
        ],
      ],
      ["art-3", [file("assets/logo.png", 0, 0, { binary: true })]],
    ]),
  );
  assert.deepEqual(rows.map((row) => row.path), [
    "src/shared.ts",
    "src/moved.ts",
    "src/one.ts",
    "assets/logo.png",
  ]);
  assert.equal(rows[0]!.onlyIn, null);
  assert.equal(rows[1]!.onlyIn, "art-2");
  assert.equal(rows[1]!.cells["art-2"]?.renamedFrom, "src/old.ts");
  assert.equal(rows[3]!.cells["art-3"]?.binary, true);
  assert.equal(rows[3]!.cells["art-1"], undefined);
});

test("path touch evidence is candidate-scoped and includes both sides of a rename", () => {
  const files = [
    file("src/moved.ts", 1, 1, { oldPath: "src/old.ts" }),
    file("src/other.ts", 1, 0),
  ];
  assert.equal(artifactTouchesPath(files, "src/moved.ts"), true);
  assert.equal(artifactTouchesPath(files, "src/old.ts"), true);
  assert.equal(artifactTouchesPath(files, "src/missing.ts"), false);
});

test("selection is unique, eligible, and capped at three columns", () => {
  const eligible = ["a", "b", "c", "d"];
  assert.deepEqual(capCompareSelection(["a", "a", "missing", "b", "c", "d"], eligible), [
    "a",
    "b",
    "c",
  ]);
  assert.deepEqual(updateCompareSelection(["a", "b", "c"], "d", true, eligible), ["a", "b", "c"]);
  assert.deepEqual(updateCompareSelection(["a", "b", "c"], "b", false, eligible), ["a", "c"]);
});

test("rationale path detection is exact-token and shape-gated without a file union", () => {
  const text =
    "See `src/server/scheduler.ts`, README.md and config/retries; not scheduler, release.v2, ../escape.ts, /abs/file.ts, or https://example.test/a.ts.";
  assert.deepEqual(
    detectPathTokens(text).map((token) => token.path),
    ["src/server/scheduler.ts", "README.md", "config/retries"],
  );
});

test("rationale pair choice never degenerates to the same artifact twice", () => {
  const common = {
    currentSelection: [] as string[],
    recommendedArtifactId: "art-1",
    rankedArtifactIds: ["art-1", "art-2", "art-3"],
    eligibleArtifactIds: ["art-1", "art-2", "art-3"],
  };
  assert.deepEqual(
    chooseCompareArtifactIds({ ...common, scoredArtifactId: "art-2" }),
    ["art-2", "art-1"],
  );
  assert.deepEqual(
    chooseCompareArtifactIds({ ...common, scoredArtifactId: "art-1" }),
    ["art-1", "art-2"],
  );
  assert.deepEqual(
    chooseCompareArtifactIds({
      ...common,
      scoredArtifactId: "art-2",
      currentSelection: ["art-2", "art-3", "art-1"],
    }),
    ["art-2", "art-3", "art-1"],
  );
  assert.equal(
    chooseCompareArtifactIds({
      scoredArtifactId: "art-1",
      currentSelection: [],
      recommendedArtifactId: "art-1",
      rankedArtifactIds: ["art-1"],
      eligibleArtifactIds: ["art-1"],
    }),
    null,
  );
});

test("claims keep a reported zero separate from unknown cost", () => {
  const compared = detail();
  const zero = compareClaim(compared, "art-1");
  const unknown = compareClaim(compared, "art-2");
  assert.equal(zero.summary, "Adds restart ordering.");
  assert.equal(zero.checksCount, 1);
  assert.equal(zero.costUsd, 0);
  assert.equal(zero.rank, 1);
  assert.equal(zero.score, 92);
  assert.equal(zero.confidence, 0.86);
  assert.equal(unknown.costUsd, null);
});

test("three loaded candidates render a matrix, aligned panes, and truncation disclosure", () => {
  const compared = detail();
  const files: CompareFilesCache = new Map([
    ["art-1", { status: "ready", value: patch([file("src/shared.ts", 8, 2)]) }],
    [
      "art-2",
      {
        status: "ready",
        value: patch([file("src/shared.ts", 3, 1), file("src/only-two.ts", 1, 0)]),
      },
    ],
    ["art-3", { status: "ready", value: patch([file("README.md", 2, 0)]) }],
  ]);
  const patches: ComparePatchCache = new Map([
    [
      comparePatchKey("art-1", "src/shared.ts"),
      {
        status: "ready",
        value: patch([file("src/shared.ts", 8, 2)], {
          patchPaths: ["src/shared.ts"],
          patch: "diff --git a/src/shared.ts b/src/shared.ts\n+first",
          truncated: true,
          omittedBytes: 2048,
        }),
      },
    ],
    [
      comparePatchKey("art-2", "src/shared.ts"),
      {
        status: "ready",
        value: patch([file("src/shared.ts", 3, 1)], {
          patchPaths: ["src/shared.ts"],
          patch: "diff --git a/src/shared.ts b/src/shared.ts\n+second",
        }),
      },
    ],
    [
      comparePatchKey("art-3", "src/shared.ts"),
      {
        status: "ready",
        value: patch([file("README.md", 2, 0)], {
          patchPaths: ["src/shared.ts"],
        }),
      },
    ],
  ]);
  const html = renderToStaticMarkup(
    createElement(EnsembleCompareView, {
      detail: compared,
      subjectLabel,
      compare: { artifactIds: ["art-1", "art-2", "art-3"], path: "src/shared.ts" },
      onCompareChange: () => {},
      filesCache: files,
      patchCache: patches,
    }),
  );
  assert.match(html, /Candidate 1 \(claude · opus\)/);
  assert.match(html, /src\/only-two\.ts/);
  assert.match(html, /only #2/);
  assert.match(html, /Open in every snapshot/);
  assert.match(html, /Patch truncated · 2\.0 KiB omitted/);
  assert.match(html, /diff --git a\/src\/shared\.ts/);
  assert.match(html, /Not touched by this candidate/);
  assert.doesNotMatch(html, /Not touched by the selected candidates/);
  assert.doesNotMatch(html, /No text patch for this file/);
  assert.match(html, /cost \$0\.00|\$0\.00/);
  assert.match(html, /not reported/);
});

test("a failed file list stays unknown until the per-path response supplies touch evidence", () => {
  const files: CompareFilesCache = new Map([
    ["art-1", { status: "error", error: "file list unavailable" }],
    ["art-2", { status: "ready", value: patch([file("assets/logo.png", 0, 0)]) }],
  ]);
  const patches: ComparePatchCache = new Map([
    [
      comparePatchKey("art-1", "assets/logo.png"),
      {
        status: "ready",
        value: patch([file("assets/logo.png", 0, 0, { binary: true })], {
          patchPaths: ["assets/logo.png"],
        }),
      },
    ],
    [
      comparePatchKey("art-2", "assets/logo.png"),
      { status: "error", error: "patch unavailable" },
    ],
  ]);
  const html = renderToStaticMarkup(
    createElement(EnsembleCompareView, {
      detail: detail(),
      subjectLabel,
      compare: { artifactIds: ["art-1", "art-2"], path: "assets/logo.png" },
      onCompareChange: () => {},
      filesCache: files,
      patchCache: patches,
      onRetryFiles: () => {},
      onRetryPatch: () => {},
    }),
  );

  assert.match(html, /file list unavailable/);
  assert.match(html, /No text patch for this file/);
  assert.doesNotMatch(html, /Not touched by this candidate/);
  assert.match(html, /Retry file list/);
  assert.match(html, /patch unavailable/);
  assert.match(html, /Retry file/);
});

test("the section explains its two-snapshot gate", () => {
  const html = renderToStaticMarkup(
    createElement(EnsembleCompareView, {
      detail: detail([artifact("art-1", "attempt-1")]),
      subjectLabel,
      compare: null,
      onCompareChange: () => {},
      filesCache: new Map(),
      patchCache: new Map(),
    }),
  );
  assert.match(html, /Comparison opens when two snapshots are ready/);
});

test("an activated rationale path absent from every selected file list stays explicit", () => {
  const files: CompareFilesCache = new Map([
    ["art-1", { status: "ready", value: patch([file("src/one.ts", 1, 0)]) }],
    ["art-2", { status: "ready", value: patch([file("src/two.ts", 1, 0)]) }],
  ]);
  const patches: ComparePatchCache = new Map([
    [
      comparePatchKey("art-1", "src/not-touched.ts"),
      {
        status: "ready",
        value: patch([file("src/one.ts", 1, 0)], {
          patchPaths: ["src/not-touched.ts"],
        }),
      },
    ],
    [
      comparePatchKey("art-2", "src/not-touched.ts"),
      {
        status: "ready",
        value: patch([file("src/two.ts", 1, 0)], {
          patchPaths: ["src/not-touched.ts"],
        }),
      },
    ],
  ]);
  const html = renderToStaticMarkup(
    createElement(EnsembleCompareView, {
      detail: detail(),
      subjectLabel,
      compare: { artifactIds: ["art-1", "art-2"], path: "src/not-touched.ts" },
      onCompareChange: () => {},
      filesCache: files,
      patchCache: patches,
    }),
  );
  assert.match(html, /src\/not-touched\.ts/);
  assert.match(html, /Not touched by the selected candidates/);
  assert.match(html, /Not touched by this candidate/);
});

test("a rationale anchor activates the chosen pair and path before any matrix selection exists", () => {
  const calls: Array<{ artifactIds: string[]; path: string }> = [];
  const pair = chooseCompareArtifactIds({
    scoredArtifactId: "art-2",
    currentSelection: [],
    recommendedArtifactId: "art-1",
    rankedArtifactIds: ["art-1", "art-2", "art-3"],
    eligibleArtifactIds: ["art-1", "art-2", "art-3"],
  });
  assert.ok(pair);
  const element = RationaleText({
    rationale: "The guard belongs in src/server/scheduler.ts.",
    artifactIds: pair,
    onOpenCompare: (artifactIds, path) => calls.push({ artifactIds, path }),
  });
  const children = element.props.children as unknown[];
  const tooltip = children.find((child): child is ReactElement<{ children: unknown }> =>
    isValidElement(child),
  );
  const button =
    tooltip && isValidElement(tooltip.props.children)
      ? (tooltip.props.children as ReactElement<{ onClick: () => void }>)
      : null;
  assert.ok(button);
  button.props.onClick();
  assert.deepEqual(calls, [
    { artifactIds: ["art-2", "art-1"], path: "src/server/scheduler.ts" },
  ]);

  const initialDossier = renderToStaticMarkup(
    createElement(ENSEMBLE_RESULT_RENDERERS.best_of_n!, {
      detail: detail(),
      subjectLabel,
      onOpenCompare: () => {},
      decision: null,
    }),
  );
  assert.match(initialDossier, /class="ensemble-rationale-path"/);
});

test("a renderer with no compare controller leaves rationale paths as plain text", () => {
  const html = renderToStaticMarkup(
    createElement(ENSEMBLE_RESULT_RENDERERS.best_of_n!, {
      detail: detail(),
      subjectLabel,
      decision: null,
    }),
  );
  assert.match(html, /test\/scheduler\/restart\.test\.ts/);
  assert.doesNotMatch(html, /class="ensemble-rationale-path"/);
});

test("the API client uses filesOnly and one encoded path per compare request", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const body = patch([]);
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    assert.equal((await fetchArtifactFiles("run/1", "art 1")).ok, true);
    assert.equal(
      (await fetchArtifactFilePatch("run/1", "art 1", "src/a file.ts", 8192)).ok,
      true,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls[0], "/api/ensembles/run%2F1/artifacts/art%201/patch?filesOnly=1");
  assert.equal(
    calls[1],
    "/api/ensembles/run%2F1/artifacts/art%201/patch?path=src%2Fa+file.ts&maxBytes=8192",
  );
  assert.equal(new URL(`http://local${calls[1]}`).searchParams.getAll("path").length, 1);
});
