// The progress protocol shared by the install script and the app that watches it.
//
// `scripts/install-app.mjs` runs as plain node, from the updater-owned clone, and cannot
// import a `.ts` module; the renderer draws the progress bar and cannot import a `node:`
// module. This file is the one place both can reach, so the stage ids, their order, and the
// marker lines that carry them have a single owner rather than a copy per side.
//
// Keep it free of `node:` imports.

/**
 * Every stage the staged build reports, in the order it reports them.
 *
 * `fraction` is where the bar sits WHILE that stage runs, so the two long stages
 * (`dependencies` and `build`) deliberately start low: a bar parked at 90% for two minutes
 * reads as wedged, and the same wait at 30% reads as work remaining. The order here is the
 * order of the install script's own headings, which is what makes the mapping checkable.
 */
export const UPDATE_PREPARE_STAGES = [
  { id: "starting", label: "Starting the update", fraction: 0.02 },
  { id: "prerequisites", label: "Checking prerequisites", fraction: 0.06 },
  { id: "source", label: "Preparing the update source", fraction: 0.12 },
  { id: "release", label: "Selecting the release", fraction: 0.16 },
  { id: "checkout", label: "Checking out the release", fraction: 0.2 },
  { id: "dependencies", label: "Installing dependencies", fraction: 0.3 },
  { id: "build", label: "Building the new version", fraction: 0.55 },
  { id: "verify", label: "Verifying the build", fraction: 0.9 },
];

export const UPDATE_PROGRESS_MARKER = "##mission-update-progress";
export const UPDATE_STAGED_MARKER = "##mission-update-staged";

export function isUpdatePrepareStage(value) {
  return UPDATE_PREPARE_STAGES.some((stage) => stage.id === value);
}

/**
 * Where the bar sits for a stage, plus the words beside it.
 *
 * An unknown id resolves to the first stage rather than throwing. The emitter is a script in
 * a clone that a future release may extend, and a progress bar is not worth failing an update
 * over.
 */
export function updatePrepareProgress(stage) {
  const index = UPDATE_PREPARE_STAGES.findIndex((entry) => entry.id === stage);
  const resolved = index < 0 ? 0 : index;
  const entry = UPDATE_PREPARE_STAGES[resolved];
  return {
    label: entry.label,
    fraction: entry.fraction,
    step: resolved + 1,
    steps: UPDATE_PREPARE_STAGES.length,
    percent: Math.round(entry.fraction * 100),
  };
}

/**
 * Read one line of install-script output.
 *
 * Returns null for every ordinary line, which is almost all of them: npm and
 * electron-builder own that stream and only these two markers are addressed to us.
 */
export function parseUpdateProgressLine(line) {
  const text = String(line ?? "").trim();
  if (text.startsWith(`${UPDATE_PROGRESS_MARKER} `)) {
    const stage = text.slice(UPDATE_PROGRESS_MARKER.length + 1).trim();
    return stage ? { kind: "stage", stage } : null;
  }
  if (text.startsWith(`${UPDATE_STAGED_MARKER} `)) {
    // Version first, bundle path last and unquoted: the bundle is always named
    // "Mission Control.app", so a space-splitting parse would truncate every path.
    const rest = text.slice(UPDATE_STAGED_MARKER.length + 1).trim();
    const boundary = rest.indexOf(" ");
    if (boundary < 1) return null;
    const version = rest.slice(0, boundary);
    const bundlePath = rest.slice(boundary + 1).trim();
    return bundlePath ? { kind: "staged", version, bundlePath } : null;
  }
  return null;
}
