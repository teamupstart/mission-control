import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";

const evidence = join(process.cwd(), "e2e/.artifacts/diff-performance");
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

// Real Git, HTTP and rendering. Timing comparisons are opt-in on an otherwise idle host;
// ordinary CI still checks the complete list, first/last file and fresh reads on re-entry.
test("Diff loads a many-file checkout and re-reads edits on tab entry", async ({ dashboard: page, daemon }) => {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("measure diff loading");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  const sessions = async () => (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as { cwd: string }[];
  await expect.poll(async () => (await sessions())[0]?.cwd).toBeTruthy();
  const cwd = (await sessions())[0]!.cwd;
  writeFileSync(join(cwd, "README.md"), "first file changed\n");
  for (let i = 0; i < 80; i++) {
    writeFileSync(join(cwd, `change-${String(i).padStart(3, "0")}.txt`), `new file ${i}\n`.repeat(30));
  }
  await page.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout: "console" } });
  await page.reload();
  await page.getByRole("navigation", { name: "Sessions" }).getByRole("button", { name: /Measure Diff Loading/i }).click();
  const tabs = page.getByRole("tablist", { name: "Session detail" });
  const samples: number[] = [];
  const phase = process.env.MC_DIFF_BENCHMARK;
  const iterations = phase ? 7 : 2;
  for (let i = 0; i < iterations; i++) {
    // Start at the actual click event, end after the browser has had a paint opportunity
    // with both the first file's diff and the complete 81-file navigation mounted.
    await page.evaluate(() => {
      document.documentElement.removeAttribute("data-diff-elapsed");
      document.addEventListener("click", () => {
        const start = performance.now();
        const sample = () => {
          if (document.querySelector(".diff-lines") && document.querySelectorAll('[aria-label="Changed files"] button').length === 81) {
            requestAnimationFrame(() => {
              document.documentElement.setAttribute("data-diff-elapsed", String(performance.now() - start));
            });
          } else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, { once: true, capture: true });
    });
    await tabs.getByRole("tab", { name: /Diff$/ }).click();
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-diff-elapsed"));
    samples.push(Number(await page.locator("html").getAttribute("data-diff-elapsed")));
    const list = page.getByRole("navigation", { name: "Changed files" });
    await expect(list.getByRole("button")).toHaveCount(81);
    await expect(page.locator(".diff-lines")).toContainText(i === 0 ? "first file changed" : "fresh edit on re-entry");
    await list.getByRole("button", { name: /change-079.txt/ }).click();
    await expect(page.locator(".diff-lines")).toContainText("new file 79");
    if (i < iterations - 1) {
      await tabs.getByRole("tab", { name: /Conversation$/ }).click();
      await expect(list).toBeHidden();
      writeFileSync(join(cwd, "README.md"), "fresh edit on re-entry\n");
    }
  }
  if (phase || process.env.MC_E2E_EVIDENCE) {
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, `${phase ?? "verified"}.png`) });
  }
  if (phase) {
    const result = { samples, medianMs: median(samples), files: 81, metric: "tab click to painted first file and complete file list" };
    writeFileSync(join(evidence, `${phase}.json`), JSON.stringify(result, null, 2));
    console.log(`DIFF_BENCHMARK ${phase} ${JSON.stringify(result)}`);
    if (phase === "result") {
      const baseline = JSON.parse(readFileSync(join(evidence, "baseline.json"), "utf8")) as { medianMs: number };
      console.log(`DIFF_SPEEDUP ${(baseline.medianMs / result.medianMs).toFixed(2)}x; reduction ${(100 * (1 - result.medianMs / baseline.medianMs)).toFixed(1)}%`);
      expect(result.medianMs).toBeLessThanOrEqual(baseline.medianMs / 2);
    }
  }
});
