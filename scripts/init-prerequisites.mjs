export const MIN_NODE_MAJOR = 24;

export function nodeMajor(version) {
  const match = /^v?(\d+)/.exec(version);
  return match ? Number(match[1]) : null;
}

export function nodePrerequisiteMessage(version) {
  const major = nodeMajor(version);
  if (major !== null && major >= MIN_NODE_MAJOR) return null;
  return `Mission Control requires Node.js ${MIN_NODE_MAJOR} or newer (found ${version || "an unknown version"}). Install Node.js ${MIN_NODE_MAJOR}+ and rerun \`make init\`.`;
}

export function chromiumPrerequisiteMessage() {
  return "Playwright Chromium is required for end-to-end tests. Run `npx playwright install chromium`, then rerun `make init ARGS=\"--with-e2e\"`.";
}
