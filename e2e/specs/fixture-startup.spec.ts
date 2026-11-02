import { expect, test as base } from "../fixtures/test.ts";

// Observe before dashboard setup, so the measurement includes fixture navigation.
const test = base.extend<{ dashboardBoots: () => number }>({
  dashboardBoots: [async ({ page }, use) => {
    let boots = 0;
    page.on("request", (request) => {
      if (request.isNavigationRequest() && new URL(request.url()).pathname === "/") boots++;
    });
    await use(() => boots);
  }, { auto: true }],
});

test("dashboard preference preparation starts the application and its probes once", async ({ dashboard, dashboardBoots }) => {
  await expect(dashboard.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
  await expect(dashboard.getByRole("button", { name: "Condense the Line" })).toBeVisible();
  expect(dashboardBoots(), "a discarded app boot still spends daemon probe deadlines and host CPU").toBe(1);
});
