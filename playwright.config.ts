// Playwright searches the current directory for this conventional filename. Keep bare
// commands on the browser suite instead of letting its fallback discovery import `test/`,
// whose files belong exclusively to Node's test runner and its state-isolation preload.
export { default } from "./e2e/playwright.config.ts";
