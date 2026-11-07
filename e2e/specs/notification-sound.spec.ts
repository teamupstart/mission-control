import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Session } from "../../src/shared/types.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

test.use({ daemonEnv: { MC_E2E_HOLD_FIRST_TURN: "1" } });

type SoundWindow = Window & {
  soundProbe: {
    toasts: Array<{ title: string; body?: string; tag?: string; silent?: boolean | null }>;
    notes: number;
    audioState?: AudioContextState;
    stream: EventSource;
    reconnect: () => Promise<void>;
  };
};

async function observeDelivery(page: Page, audioState?: AudioContextState): Promise<void> {
  await page.addInitScript((initialAudioState) => {
    const state = { toasts: [], notes: 0, audioState: initialAudioState } as unknown as SoundWindow["soundProbe"];
    (window as SoundWindow).soundProbe = state;
    // Capture the OS API boundary without raising real desktop alerts during a test.
    window.Notification = class {
      static permission = "granted";
      static requestPermission = async () => "granted";
      constructor(title: string, options: NotificationOptions = {}) {
        state.toasts.push({ title, ...options });
      }
      close(): void {}
    } as unknown as typeof Notification;
    // Record oscillator playback requests without making sound on the test host.
    // Stub stop as well: the native method rejects an oscillator we never started.
    OscillatorNode.prototype.start = function () {
      state.notes++;
    };
    OscillatorNode.prototype.stop = function () {};
    if (initialAudioState) {
      // Model autoplay suspension deterministically, including browsers that remember
      // prior interaction with this origin. A real dashboard gesture unlocks this port.
      Object.defineProperty(AudioContext.prototype, "state", { get: () => state.audioState });
      AudioContext.prototype.resume = async function () { state.audioState = "running"; };
    }
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (String(url) === "/events") state.stream = this;
      }
    };
    // Deterministically model a lost stream, then forward the REAL daemon's new snapshot
    // into the existing hook. No session or notification payload is manufactured here.
    state.reconnect = () => new Promise<void>((resolve, reject) => {
      const replacement = new NativeEventSource("/events");
      replacement.onerror = () => { replacement.close(); reject(new Error("reconnect failed")); };
      replacement.onmessage = (event) => {
        if (JSON.parse(event.data).type !== "snapshot") return;
        state.stream.dispatchEvent(new Event("open"));
        state.stream.dispatchEvent(new MessageEvent("message", { data: event.data }));
        replacement.close();
        resolve();
      };
    });
  }, audioState);
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<Session> {
  const sessions = async () => (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Session[];
  const existing = new Set((await sessions()).map((s) => s.id));
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expectContentClearsBorder(dialog);
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Check notification delivery");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  const created = async () => (await sessions()).find((s) => s.runtime === "sdk" && !existing.has(s.id));
  await expect.poll(async () => (await created())?.agentSessionId).toBeTruthy();
  return (await created())!;
}

async function disconnect(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { stream } = (window as SoundWindow).soundProbe;
    stream.close();
    stream.dispatchEvent(new Event("error"));
  });
  await expect(page.locator(".pulse")).toHaveClass(/is-down/);
}

async function hook(daemon: DaemonHandle, session: Session, event: string): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/hooks/${event}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": readFileSync(join(daemon.home, "token"), "utf8").trim(),
    },
    body: JSON.stringify({
      agent: "claude", cwd: session.cwd, sessionId: session.agentSessionId, env: {},
      message: "Claude needs your permission to use Bash", prompt: "carry on",
    }),
  });
  expect(response.status).toBe(204);
}

async function savedSound(daemon: DaemonHandle): Promise<boolean> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`);
  expect(response.ok).toBe(true);
  return (await response.json()).config.alerts.sound;
}

const delivery = (page: Page) => page.evaluate(() => {
  const { toasts, notes } = (window as SoundWindow).soundProbe;
  return { toasts, notes };
});

for (const mode of ["live", "reconnect"] as const) {
  test(`Sound off silences ${mode} desktop alerts and survives reload`, async ({ dashboard: page, daemon }) => {
    await observeDelivery(page);
    await page.reload();
    await page.getByRole("button", { name: /^Alerts & away mode/ }).click();
    const panel = page.getByRole("dialog", { name: "Alert settings" });
    const sound = panel.getByRole("switch", { name: "Sound", exact: true });
    await expect(sound).toHaveAttribute("aria-checked", "true");
    await panel.getByRole("switch", { name: "Desktop notifications", exact: true }).click();
    await sound.click();
    await expect(sound).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => savedSound(daemon)).toBe(false);
    await page.reload();
    await page.getByRole("button", { name: /^Alerts & away mode/ }).click();
    await expect(sound).toHaveAttribute("aria-checked", "false");
    await expect(panel.getByRole("switch", { name: "Desktop notifications", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    if (process.env.MC_E2E_EVIDENCE) {
      const dir = artifactsDir("notification-sound");
      mkdirSync(dir, { recursive: true });
      await page.mouse.move(0, 0);
      await panel.screenshot({ path: join(dir, `${mode}-sound-disabled.png`) });
    }
    await page.keyboard.press("Escape");

    const session = await dispatch(page, daemon);
    await expect(page.getByRole("navigation", { name: "Sessions", exact: true }).locator(".rail-row")).toHaveCount(1);
    expect(await delivery(page)).toEqual({ toasts: [], notes: 0 });

    if (mode === "reconnect") {
      await disconnect(page);
    }
    await hook(daemon, session, "Notification");
    if (mode === "reconnect") {
      await page.evaluate(() => (window as SoundWindow).soundProbe.reconnect());
    }
    await expect.poll(async () => (await delivery(page)).toasts.length).toBe(1);
    const muted = await delivery(page);
    expect(muted.notes).toBe(0);
    expect(muted.toasts[0]).toMatchObject({
      silent: true,
      tag: mode === "reconnect" ? "reconnect-catchup" : `input:${session.id}`,
    });

    if (mode === "reconnect") return;
    // Enabling sound must still produce the app's chime, with no second OS tone.
    await hook(daemon, session, "UserPromptSubmit");
    await expect(page.locator(".rail-row")).toHaveClass(/tone-working/);
    await page.getByRole("button", { name: /^Alerts & away mode/ }).click();
    await sound.click();
    await expect.poll(() => savedSound(daemon)).toBe(true);
    await expect.poll(async () => (await delivery(page)).notes).toBe(1);
    await page.keyboard.press("Escape");
    await hook(daemon, session, "Notification");
    await expect.poll(async () => (await delivery(page)).toasts.length).toBe(2);
    expect((await delivery(page)).toasts[1]?.silent).toBe(true);
    expect((await delivery(page)).notes).toBe(3);

    // Turning Sound off again takes effect on the mounted dashboard, without a reload.
    await hook(daemon, session, "UserPromptSubmit");
    await expect(page.locator(".rail-row")).toHaveClass(/tone-working/);
    await page.getByRole("button", { name: /^Alerts & away mode/ }).click();
    await sound.click();
    await expect.poll(() => savedSound(daemon)).toBe(false);
    await page.keyboard.press("Escape");
    // Outlive the 1200ms chime rate gate so it cannot hide an erroneous muted chime.
    await page.waitForTimeout(1_300);
    await hook(daemon, session, "Notification");
    await expect.poll(async () => (await delivery(page)).toasts.length).toBe(3);
    expect((await delivery(page)).toasts[2]?.silent).toBe(true);
    expect((await delivery(page)).notes).toBe(3);
  });

  for (const sound of [true, false]) {
    test(`suspended audio respects Sound ${sound ? "on" : "off"} for ${mode} alerts`, async ({ dashboard: page, daemon }) => {
      const session = await dispatch(page, daemon);
      const saved = await fetch(`${daemon.baseURL}/api/ui/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alerts: { notifications: true, sound } }),
      });
      expect(saved.ok).toBe(true);
      await observeDelivery(page, "suspended");
      await page.reload();
      await expect(page.locator(".rail-row")).toHaveClass(/tone-working/);
      // No gesture after reload: an incoming alert must use the OS fallback only
      // when Sound is enabled, and must not queue a chime to play on later unlock.
      if (mode === "reconnect") await disconnect(page);
      await hook(daemon, session, "Notification");
      if (mode === "reconnect") await page.evaluate(() => (window as SoundWindow).soundProbe.reconnect());
      await expect.poll(async () => (await delivery(page)).toasts.length).toBe(1);
      expect((await delivery(page)).toasts[0]?.silent).toBe(!sound);
      expect((await delivery(page)).notes).toBe(0);

      if (!sound || mode === "reconnect") return;
      await page.getByRole("button", { name: /^Alerts & away mode/ }).click();
      await page.keyboard.press("Escape");
      expect((await delivery(page)).notes).toBe(0);
      // The earlier OS tone consumes the same burst gate as a chime.
      await page.clock.setFixedTime(new Date(Date.now() + 1_300));
      await hook(daemon, session, "UserPromptSubmit");
      await expect(page.locator(".rail-row")).toHaveClass(/tone-working/);
      await hook(daemon, session, "Notification");
      await expect.poll(async () => (await delivery(page)).toasts.length).toBe(2);
      expect((await delivery(page)).toasts[1]?.silent).toBe(true);
      expect((await delivery(page)).notes).toBe(2);

      // A rate-limited chime is deliberate silence, not an unavailable audio device.
      await hook(daemon, session, "UserPromptSubmit");
      await expect(page.locator(".rail-row")).toHaveClass(/tone-working/);
      await hook(daemon, session, "Notification");
      await expect.poll(async () => (await delivery(page)).toasts.length).toBe(3);
      expect((await delivery(page)).toasts[2]?.silent).toBe(true);
      expect((await delivery(page)).notes).toBe(2);
    });
  }
}

for (const mode of ["live", "reconnect"] as const) {
  test(`suspended audio rate-limits separate ${mode} fallback alerts`, async ({ dashboard: page, daemon }) => {
    const session = await dispatch(page, daemon);
    const saved = await fetch(`${daemon.baseURL}/api/ui/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alerts: { notifications: true, sound: true } }),
    });
    expect(saved.ok).toBe(true);
    await observeDelivery(page, "suspended");
    await page.reload();
    await expect(page.locator(".rail-row")).toHaveClass(/tone-working/);
    const start = Date.now();
    for (const [index, offset] of [0, 400, 1_200].entries()) {
      await page.clock.setFixedTime(new Date(start + offset));
      if (index > 0) {
        await hook(daemon, session, "UserPromptSubmit");
        if (mode === "reconnect") await page.evaluate(() => (window as SoundWindow).soundProbe.reconnect());
        await expect(page.locator(".rail-row")).toHaveClass(/tone-working/);
      }
      if (mode === "reconnect") await disconnect(page);
      await hook(daemon, session, "Notification");
      if (mode === "reconnect") await page.evaluate(() => (window as SoundWindow).soundProbe.reconnect());
      await expect.poll(async () => (await delivery(page)).toasts.length).toBe(index + 1);
      expect((await delivery(page)).toasts[index]?.silent).toBe(index === 1);
      expect((await delivery(page)).notes).toBe(0);
    }
  });
}

test("suspended audio permits only the first system tone in a multiple-alert batch", async ({ dashboard: page, daemon }) => {
  const first = await dispatch(page, daemon);
  const second = await dispatch(page, daemon);
  const saved = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alerts: { notifications: true, sound: true } }),
  });
  expect(saved.ok).toBe(true);
  await observeDelivery(page, "suspended");
  await page.reload();
  await expect(page.locator(".rail-row.tone-working")).toHaveCount(2);
  // Pause event delivery without signalling a disconnect. Forwarding the daemon's
  // next snapshot then supplies both real transitions in one live batch.
  await page.evaluate(() => (window as SoundWindow).soundProbe.stream.close());
  await hook(daemon, first, "Notification");
  await hook(daemon, second, "Notification");
  await page.evaluate(() => (window as SoundWindow).soundProbe.reconnect());
  await expect.poll(async () => (await delivery(page)).toasts.length).toBe(2);
  const batch = await delivery(page);
  expect(batch.toasts.map((toast) => toast.tag).sort()).toEqual([`input:${first.id}`, `input:${second.id}`].sort());
  expect(batch.toasts.map((toast) => toast.silent)).toEqual([false, true]);
  expect(batch.notes).toBe(0);
});

test("reconnect with Sound on and running audio plays a chime with a silent notification", async ({ dashboard: page, daemon }) => {
  const session = await dispatch(page, daemon);
  const saved = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alerts: { notifications: true, sound: true } }),
  });
  expect(saved.ok).toBe(true);
  await observeDelivery(page, "running");
  await page.reload();
  await expect(page.locator(".rail-row")).toHaveClass(/tone-working/);
  await disconnect(page);
  await hook(daemon, session, "Notification");
  await page.evaluate(() => (window as SoundWindow).soundProbe.reconnect());
  await expect.poll(async () => (await delivery(page)).toasts.length).toBe(1);
  expect((await delivery(page)).toasts[0]).toMatchObject({ tag: "reconnect-catchup", silent: true });
  expect((await delivery(page)).notes).toBe(2);
});
