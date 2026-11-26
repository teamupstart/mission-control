import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { supportsSherpaHelpers } from "../../src/shared/sherpa-platform.ts";
import { voiceTestModel } from "../../test/helpers/voice-test-model.ts";
import { voiceHostTimeUs } from "../../src/server/voice/host-clock.ts";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { captureCard, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { beListener, say, startSpeech, voiceToken } from "../fixtures/voice.ts";

for (const switchFields of [false, true]) {
  test(switchFields ? "Sherpa discovers focus after onset and follows it to a second editor"
    : "Sherpa previews recorded speech in Dispatch and keeps the final addressed phrase in the draft", async ({ dashboard: page, daemon }) => {
    test.skip(!supportsSherpaHelpers(process.platform, process.arch), "Sherpa helper unavailable on this platform");
    const model = await voiceTestModel(false);
    test.skip(!model, "Requires the locally cached voice test model");
    await setupCards(page, daemon);
    await runningAgent(page, daemon, "Steve");
    await page.getByRole("button", { name: "Dispatch", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
    await expectContentClearsBorder(dialog);
    const task = dialog.getByPlaceholder("What should this agent do?");
    await expect(task).toBeFocused();
    const details = dialog.getByRole("button", { name: /^(Backlog|Task) details/ });
    const title = dialog.getByPlaceholder("summarized from the task if left blank");
    if (switchFields) {
      await details.click();
      await details.focus();
      // The onset probe returns its real no-editor snapshot. Focus enters Task
      // before the helper receives that response, then moves on the first live edit.
      await page.route("**/api/voice/open-cards?dictation=1", async route => {
        expect(route.request().postDataJSON().target).toBeUndefined();
        await task.focus();
        await route.continue();
      }, { times: 1 });
      await task.evaluate((field, next) => field.addEventListener("input", () => queueMicrotask(() => next.focus()), { once: true }),
        (await title.elementHandle())!);
    }

    const edits: string[] = [];
    await page.exposeFunction("recordSherpaEdit", (value: string) => edits.push(value));
    await task.evaluate((field: HTMLTextAreaElement) => {
      field.addEventListener("input", () => (window as Window & { recordSherpaEdit(value: string): void }).recordSherpaEdit(field.value));
    });
    await promisify(execFile)(process.execPath, ["dist/voice-listener/sherpa.mjs", "--test-model",
      "--input-file", "test/fixtures/voice/steve-check-the-build.wav"], { timeout: 45_000,
      env: { ...process.env, MISSION_VOICE_MODEL_DIR: model!, MISSION_VOICE_TOKEN_FILE: join(daemon.home, "token"),
        MISSION_VOICE_DAEMON_URL: daemon.baseURL } });
    const destination = switchFields ? title : task;
    await expect(destination).toHaveValue(/^Steve\W+check the build\W*$/i);
    const final = await destination.inputValue();
    expect(edits.some(text => text.trim() && text.length < final.length)).toBe(true);
    expect((await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries).toHaveLength(0);
    await captureCard(dialog, switchFields ? "sherpa-mid-phrase-switch" : "sherpa-final-draft");
  });
}

test("one Sherpa listener previews and finalizes the second phrase after a focus refusal", async ({ dashboard: page, daemon }) => {
  test.skip(!supportsSherpaHelpers(process.platform, process.arch), "Sherpa helper unavailable on this platform");
  const model = await voiceTestModel(false);
  test.skip(!model, "Requires the locally cached voice test model");
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expectContentClearsBorder(dialog);
  const field = dialog.getByPlaceholder("What should this agent do?");
  await expect(field).toBeFocused();
  const wav = readFileSync("test/fixtures/voice/steve-check-the-build.wav");
  const twoPhrases = Buffer.concat([wav, Buffer.alloc(3 * 16000 * 2), wav.subarray(44)]);
  twoPhrases.writeUInt32LE(twoPhrases.length - 8, 4);
  twoPhrases.writeUInt32LE(twoPhrases.length - 44, 40);
  const path = join(daemon.home, "two-phrases.wav");
  writeFileSync(path, twoPhrases);

  let recovered = false;
  let missed = 0;
  await page.route("**/api/voice/open-cards?dictation=1", route => {
    if (recovered) return route.continue();
    missed++;
    return route.abort();
  });
  const frames: { interim: boolean; text: string }[] = [];
  await page.exposeFunction("recordDictationFrame", (frame: typeof frames[number]) => frames.push(frame));
  await page.evaluate(() => window.addEventListener("voice-dictation", event => {
    const { interim, text } = (event as CustomEvent).detail;
    (window as Window & { recordDictationFrame(frame: { interim: boolean; text: string }): void }).recordDictationFrame({ interim, text });
  }));
  const playback = promisify(execFile)(process.execPath, ["dist/voice-listener/sherpa.mjs", "--test-model", "--input-file", path],
    { timeout: 60_000, env: { ...process.env, MISSION_VOICE_MODEL_DIR: model!, MISSION_VOICE_TOKEN_FILE: join(daemon.home, "token"),
      MISSION_VOICE_DAEMON_URL: daemon.baseURL } });
  let stderr = "";
  playback.child.stderr!.on("data", chunk => {
    stderr += chunk;
    recovered = stderr.includes("focus could not be confirmed");
  });
  await playback;
  expect(recovered).toBe(true);
  expect(missed).toBeGreaterThan(0);
  await expect(field).toHaveValue(/^Steve\W+check the build\W*$/i);
  await expect.poll(() => frames.filter(frame => !frame.interim).length).toBe(1);
  const final = await field.inputValue();
  expect(frames.some(frame => frame.interim && frame.text.length < final.length)).toBe(true);
  expect((await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries).toHaveLength(0);
  await captureCard(dialog, "sherpa-focus-recovered-second-phrase");
});

test("dictation replaces the selection and keeps addressed speech in the focused draft", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const listener = await beListener(daemon);
  try {
    const steve = await runningAgent(page, daemon, "Steve");
    const focusReport = (editing: boolean) => page.waitForResponse(response =>
      response.ok() && response.url().endsWith("/api/voice/open-cards") &&
      Boolean(response.request().postDataJSON().dictationTarget) === editing);
    // Hold unsolicited focus reports past both recognition paths. Only a fresh
    // probe from the daemon can discover that the cursor is now in Dispatch.
    let delayedReports = 0;
    const release = Promise.withResolvers<void>();
    await page.route("**/api/voice/open-cards", async route => {
      if (route.request().postDataJSON().dictationTarget) {
        delayedReports++;
        await release.promise;
      }
      await route.continue().catch(() => {});
    });
    await page.getByRole("button", { name: "Dispatch", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
    await expectContentClearsBorder(dialog);
    const task = dialog.getByPlaceholder("What should this agent do?");
    await expect(task).toBeFocused();
    await task.fill("Review OLD today");
    await task.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(7, 10));
    const speech = await startSpeech(daemon);
    expect((await (await speech.preview("Steve, check")).json()).accepted).toBe(true);
    await expect(task).toHaveValue("Review Steve, check today");
    const id = crypto.randomUUID();
    for (let i = 0; i < 2; i++) {
      expect((await (await speech.finish("Steve, check the build", id)).json()).accepted).toBe(true);
    }
    await expect(task).toHaveValue("Review Steve, check the build today");
    await say(daemon, "Steve, also check tests");
    await expect(task).toHaveValue("Review Steve, check the build Steve, also check tests today");
    expect(delayedReports).toBeGreaterThan(0);
    release.resolve();
    await captureCard(dialog, "dictation-selection");
    await dialog.getByRole("button", { name: /^(Backlog|Task) details/ }).click();
    const title = dialog.getByPlaceholder("summarized from the task if left blank");
    await Promise.all([focusReport(true), title.focus()]);
    await say(daemon, "cancel");
    await expect(title).toHaveValue("cancel");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    const session = page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: steve.name }).first();
    await session.click();
    const reply = page.getByPlaceholder(/^Reply to this session/);
    if (!await reply.evaluate(field => field === document.activeElement)) {
      await Promise.all([focusReport(true), reply.focus()]);
    }
    await say(daemon, "Steve, leave this as a draft");
    await expect(reply).toHaveValue("Steve, leave this as a draft");
    const history = await page.request.get(daemon.baseURL + "/api/voice/heard");
    expect((await history.json()).entries).toHaveLength(0);
    await Promise.all([focusReport(false), session.focus()]);
    await say(daemon, "Steve, resume routing");
    await expect(page.getByRole("status").filter({ hasText: "To Steve" })).toContainText("resume routing");
  } finally {
    listener.stop();
  }
});

test("a user edit to an interim transcript survives the next preview and final result", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const listener = await beListener(daemon);
  try {
    await runningAgent(page, daemon, "Steve");
    await page.getByRole("button", { name: "Dispatch", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
    await expectContentClearsBorder(dialog);
    const task = dialog.getByPlaceholder("What should this agent do?");
    await expect(task).toBeFocused();
    const speech = await startSpeech(daemon);
    expect((await (await speech.preview("Steve, ship")).json()).accepted).toBe(true);
    await expect(task).toHaveValue("Steve, ship");
    await task.selectText();
    await page.keyboard.insertText("Steve, wait");

    // Wait for each frame in the browser before checking that it preserved the correction.
    const received: { text: string; interim: boolean }[] = [];
    await page.exposeFunction("recordDictationUpdate", (text: string, interim: boolean) => received.push({ text, interim }));
    await page.evaluate(() => window.addEventListener("voice-dictation", event => {
      const { text, interim } = (event as CustomEvent).detail;
      (window as Window & { recordDictationUpdate(text: string, interim: boolean): void }).recordDictationUpdate(text, interim);
    }));
    const preview = "Steve, ship the patch";
    const final = "Steve, ship the patch today";
    expect((await (await speech.preview(preview)).json()).accepted).toBe(true);
    await expect.poll(() => received).toContainEqual({ text: preview, interim: true });
    await expect(task).toHaveValue("Steve, wait");
    expect((await (await speech.finish(final)).json()).accepted).toBe(true);
    await expect.poll(() => received).toContainEqual({ text: final, interim: false });
    await expect(task).toHaveValue("Steve, wait");
    expect((await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries).toHaveLength(0);
    await captureCard(dialog, "dictation-user-correction");
  } finally {
    listener.stop();
  }
});

test("contenteditable file editor replaces interim dictation with the final addressed phrase", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const listener = await beListener(daemon);
  try {
    const steve = await runningAgent(page, daemon, "Steve");
    const file = "build-notes.md";
    const path = join(steve.cwd!, file);
    writeFileSync(path, "Message for\n\n.\nKeep this line");
    await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: steve.name }).first().click();
    await page.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }).click();
    await page.getByRole("listbox", { name: "Session files" }).getByRole("option", { name: file }).click();
    await page.getByRole("group", { name: "File view mode" }).getByRole("button", { name: "Editor" }).click();
    const editor = page.getByRole("textbox", { name: "Editor for " + file });
    await expect(editor).toHaveAttribute("contenteditable", "true");
    const lines = editor.locator(".cm-line");
    await lines.first().click();
    await editor.press("End");
    await expect(editor).toBeFocused();

    const speech = await startSpeech(daemon);
    expect((await (await speech.preview("Steve, ship")).json()).accepted).toBe(true);
    await expect(lines.first()).toHaveText("Message for Steve, ship");
    expect((await (await speech.finish("Steve, check the build")).json()).accepted).toBe(true);
    const firstLine = "Message for Steve, check the build";
    await expect(lines.first()).toHaveText(firstLine);
    await lines.nth(2).click();
    await editor.press("Home");
    const next = await startSpeech(daemon);
    await next.preview("Steve, run");
    await expect(lines).toHaveText([firstLine, "", "Steve, run.", "Keep this line"]);
    await next.preview("Steve, run tests");
    await expect(lines).toHaveText([firstLine, "", "Steve, run tests.", "Keep this line"]);
    await captureCard(page.locator(".file-content"), "contenteditable-multiline-interim");
    await next.finish("Steve, review the tests");
    const expected = [firstLine, "", "Steve, review the tests.", "Keep this line"];
    await expect(lines).toHaveText(expected);
    await expect.poll(() => readFileSync(path, "utf8")).toBe(expected.join("\n"));
    expect((await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries).toHaveLength(0);
    await captureCard(page.locator(".file-content"), "contenteditable-multiline-final");
  } finally {
    listener.stop();
  }
});

test("addressed speech stays in the file comment until the operator sends it", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const listener = await beListener(daemon);
  try {
    const steve = await runningAgent(page, daemon, "Steve");
    const file = "build-notes.md";
    writeFileSync(join(steve.cwd!, file), "# Build notes\n\nCheck the compiler output.\n");
    await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: steve.name }).first().click();
    await page.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }).click();
    await page.getByRole("listbox", { name: "Session files" }).getByRole("option", { name: file }).click();
    const preview = page.getByLabel("Preview of " + file);
    await page.getByRole("button", { name: "Comment mode" }).click();
    await preview.getByText("Check the compiler output.").hover();
    await preview.getByRole("button", { name: "Comment on line 3" }).click();
    const comment = page.getByRole("textbox", { name: "Comment on line 3" });
    await expect(comment).toBeFocused();
    await say(daemon, "Steve, check this line");
    await expect(comment).toHaveValue("Steve, check this line");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    expect((await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries).toHaveLength(0);
    await captureCard(page.locator(".file-content"), "dictation-comment");
  } finally {
    listener.stop();
  }
});

for (const [type, prefix, preview, final] of [
  ["email", "demo@", "exam", "example.org"],
  ["number", "1", "23", "24"],
] as const) {
  test(`held speech updates a native ${type} input before key release`, async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon);
    const listener = await beListener(daemon);
    try {
      // Exercise native controls with no script-visible selection range on the dashboard.
      await page.evaluate(({ type, prefix }) => {
        const field = document.createElement("input");
        field.setAttribute("aria-label", "Dictation control");
        field.type = type;
        field.value = prefix;
        document.body.prepend(field);
        field.focus();
      }, { type, prefix });
      const field = page.getByLabel("Dictation control");
      await field.press("End");
      expect(await field.evaluate((element: HTMLInputElement) => element.selectionStart)).toBeNull();
      const hold = (down: boolean) => {
        const stamp = voiceHostTimeUs();
        return page.request.post(daemon.baseURL + "/voice/shell-report", { headers: { "x-harness-token": voiceToken(daemon) },
          data: { reportedAtHostUs: stamp, callActive: true, pushToTalk: down,
            [down ? "pushToTalkPressedAtHostUs" : "pushToTalkReleasedAtHostUs"]: stamp } });
      };
      expect((await hold(true)).ok()).toBe(true);
      const speech = await startSpeech(daemon);
      expect((await (await speech.preview(preview)).json()).accepted).toBe(true);
      await expect(field).toHaveValue(prefix + preview);
      expect((await (await speech.preview(final)).json()).accepted).toBe(true);
      await expect(field).toHaveValue(prefix + final);
      const endHostMs = Math.floor(voiceHostTimeUs() / 1000);
      expect((await hold(false)).ok()).toBe(true);
      expect((await (await speech.preview(preview)).json()).accepted).toBe(false);
      expect((await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries).toHaveLength(0);
      expect((await (await speech.finish(final, crypto.randomUUID(), endHostMs)).json()).accepted).toBe(true);
      await expect(field).toHaveValue(prefix + final);
      await captureCard(field, "held-dictation-" + type);
    } finally {
      listener.stop();
    }
  });
}

test("a phrase follows focus into Dispatch and between editors through the final result", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const listener = await beListener(daemon);
  try {
    await runningAgent(page, daemon, "Steve");
    const dispatch = page.getByRole("button", { name: "Dispatch", exact: true });
    await dispatch.focus();
    const speech = await startSpeech(daemon);
    await dispatch.click();
    const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
    await expectContentClearsBorder(dialog);
    const task = dialog.getByPlaceholder("What should this agent do?");
    await expect(task).toBeFocused();
    expect((await (await speech.preview("Steve")).json()).accepted).toBe(true);
    await expect(task).toHaveValue("Steve");
    await dialog.getByRole("button", { name: /^(Backlog|Task) details/ }).click();
    const title = dialog.getByPlaceholder("summarized from the task if left blank");
    await title.focus();
    expect((await (await speech.preview("Steve, check")).json()).accepted).toBe(true);
    await expect(title).toHaveValue("Steve, check");
    await expect(task).toHaveValue("Steve");
    // Returning to a field at its old caret replaces its own previous preview.
    await task.focus();
    expect((await (await speech.preview("Steve, check the")).json()).accepted).toBe(true);
    await expect(task).toHaveValue("Steve, check the");
    // Focus changes again after the last preview. Honor the user's new selection.
    await title.focus();
    await title.evaluate((field: HTMLInputElement) => field.select());
    expect((await (await speech.finish("Steve, check the build")).json()).accepted).toBe(true);
    await expect(task).toHaveValue("Steve, check the");
    await expect(title).toHaveValue("Steve, check the build");
    expect((await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries).toHaveLength(0);
    await captureCard(dialog, "mid-phrase-editor-switch");
  } finally {
    listener.stop();
  }
});

test("a stalled background dashboard allows live dictation into the confirmed Dispatch field", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const listener = await beListener(daemon);
  const background = await page.context().newPage();
  try {
    await runningAgent(page, daemon, "Steve");
    let missedProbes = 0;
    await background.route("**/api/voice/open-cards?dictation=1", route => {
      missedProbes++;
      return route.abort();
    });
    await Promise.all([
      background.waitForResponse(r => r.ok() && r.url().endsWith("/api/voice/open-cards")),
      background.goto(daemon.baseURL + "/#/fleet"),
    ]);
    await page.bringToFront();
    await page.getByRole("button", { name: "Dispatch", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
    await expectContentClearsBorder(dialog);
    const task = dialog.getByPlaceholder("What should this agent do?");
    await expect(task).toBeFocused();
    const speech = await startSpeech(daemon);
    expect((await (await speech.preview("Steve, check")).json()).accepted).toBe(true);
    await expect(task).toHaveValue("Steve, check");
    await captureCard(dialog, "stalled-dashboard-preview");
    expect((await (await speech.finish("Steve, check the build")).json()).accepted).toBe(true);
    await expect(task).toHaveValue("Steve, check the build");
    expect(missedProbes).toBe(3);
    expect((await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries).toHaveLength(0);
    await captureCard(dialog, "stalled-dashboard-final");
  } finally {
    listener.stop();
    await background.close();
  }
});

test("addressed speech reaches its session when the editor's blur report is delayed", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const listener = await beListener(daemon);
  const release = Promise.withResolvers<void>();
  try {
    const steve = await runningAgent(page, daemon, "Steve");
    const session = page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: steve.name }).first();
    await session.click();
    await session.focus();
    const reply = page.getByPlaceholder(/^Reply to this session/);
    const editing = page.waitForResponse(response => response.ok() && response.url().endsWith("/api/voice/open-cards") &&
      Boolean(response.request().postDataJSON().dictationTarget));
    await reply.fill("Keep this draft");
    await editing;
    const blurred = Promise.withResolvers<void>();
    await page.route("**/api/voice/open-cards", async route => {
      if (!route.request().postDataJSON().dictationTarget) {
        blurred.resolve();
        await release.promise;
      }
      await route.continue().catch(() => {});
    });
    await session.focus();
    await blurred.promise;
    const speech = await startSpeech(daemon);
    expect((await (await speech.finish("Steve, resume routing")).json()).accepted).toBe(true);
    const card = page.getByRole("status").filter({ hasText: "To Steve" });
    await expect(card).toContainText("resume routing", { timeout: 5000 });
    await expect(reply).toHaveValue("Keep this draft");
    await captureCard(page, "delayed-blur-routing");
    await card.getByRole("button", { name: "Send now" }).click();
    await expect(page.getByText(/Mock reply to: resume routing/).first()).toBeVisible();
    await expect(reply).toHaveValue("Keep this draft");
  } finally {
    release.resolve();
    listener.stop();
  }
});

for (const scenario of ["split text nodes", "explicit line break", "blurred draft", "overlapping phrases", "refocused correction", "moved number caret", "moved email caret"] as const) {
  test("dictation preserves the editing range across " + scenario, async ({ dashboard: page, daemon }) => {
    await setupCards(page, daemon);
    const listener = await beListener(daemon);
    try {
      await page.evaluate(scenario => {
        const field = document.createElement((scenario === "split text nodes" || scenario === "explicit line break") ? "div" : "input");
        if (field instanceof HTMLInputElement) {
          if (scenario === "moved number caret" || scenario === "moved email caret") {
            field.type = scenario === "moved number caret" ? "number" : "email";
            field.value = "11";
          }
        } else {
          field.contentEditable = "true";
          field.setAttribute("role", "textbox");
        }
        field.setAttribute("aria-label", "Draft for dictation");
        document.body.prepend(field);
        field.focus();
      }, scenario);
      const draft = page.getByLabel("Draft for dictation");
      const frames: string[] = [];
      await page.exposeFunction("heardDraftFrame", (text: string) => frames.push(text));
      await page.evaluate(() => window.addEventListener("voice-dictation", event => {
        (window as Window & { heardDraftFrame(text: string): void }).heardDraftFrame((event as CustomEvent).detail.text);
      }));
      const speech = await startSpeech(daemon);
      if (scenario === "split text nodes") {
        await draft.evaluate(field => {
          const heading = document.createElement("div");
          heading.textContent = "Fruit:";
          const line = document.createElement("div");
          line.append(document.createElement("br"));
          field.replaceChildren(heading, line);
          document.getSelection()!.collapse(line, 0);
        });
        const lines = draft.locator(":scope > div");
        await speech.preview("green apples");
        await expect(lines).toHaveText(["Fruit:", "green apples"]);
        // Syntax decoration splits the text without moving the logical caret.
        await lines.last().evaluate(field => {
          const tail = (field.firstChild as Text).splitText(6);
          const span = document.createElement("span");
          tail.replaceWith(span);
          span.append(tail);
          document.getSelection()!.collapse(tail, tail.length);
        });
        await speech.finish("red pears");
        await expect(lines).toHaveText(["Fruit:", "red pears"]);
      } else if (scenario === "explicit line break") {
        await draft.evaluate(field => {
          const tail = document.createTextNode("tail");
          field.replaceChildren("abc:", document.createElement("br"), tail);
          document.getSelection()!.collapse(tail, 0);
        });
        await speech.preview("hello");
        await expect(draft).toHaveText("abc:hellotail");
        await speech.finish("world");
        await expect.poll(() => draft.innerText()).toBe("abc:\nworldtail");
      } else if (scenario === "blurred draft") {
        await speech.preview("Steve, check");
        await expect(draft).toHaveValue("Steve, check");
        const button = page.getByRole("button", { name: "Dispatch", exact: true });
        await button.focus();
        await speech.finish("Steve, check the build");
        await expect.poll(() => frames).toContain("Steve, check the build");
        await expect(button).toBeFocused();
        await expect(draft).toHaveValue("Steve, check");
        expect((await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries).toHaveLength(0);
      } else if (scenario === "overlapping phrases") {
        await speech.preview("one");
        await expect(draft).toHaveValue("one");
        const second = await startSpeech(daemon);
        await second.preview("two");
        await expect(draft).toHaveValue("one two");
        await speech.finish("first phrase");
        await expect(draft).toHaveValue("first phrase two");
        await second.finish("second phrase");
        await expect(draft).toHaveValue("first phrase second phrase");
      } else if (scenario === "refocused correction") {
        await speech.preview("ship");
        await expect(draft).toHaveValue("ship");
        await draft.fill("wait");
        await page.getByRole("button", { name: "Dispatch", exact: true }).focus();
        await draft.focus();
        await speech.finish("ship today");
        await expect.poll(() => frames).toContain("ship today");
        await expect(draft).toHaveValue("wait");
      } else {
        await draft.press("End");
        await speech.preview("1");
        await expect(draft).toHaveValue("111");
        await draft.press("ArrowLeft");
        await draft.press("ArrowLeft");
        await speech.finish("2");
        await expect.poll(() => frames).toContain("2");
        await expect(draft).toHaveValue("111");
        await page.keyboard.insertText("3");
        await expect(draft).toHaveValue("1311");
      }
      await captureCard(draft, "dictation-" + scenario.replaceAll(" ", "-"));
    } finally {
      listener.stop();
    }
  });
}

test("hands-free FluidAudio updates Dispatch before the microphone ends the phrase", async ({ dashboard: page, daemon }) => {
  test.skip(process.platform !== "darwin", "Requires the macOS Swift listener");
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expectContentClearsBorder(dialog);
  const task = dialog.getByPlaceholder("What should this agent do?");
  await expect(task).toBeFocused();
  expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: {
    inputDevice: "hands-free-dictation", backend: "fluidaudio", showTranscript: false,
  } })).ok()).toBe(true);
  const binary = join(daemon.home, "fixture-listener");
  await promisify(execFile)("swiftc", ["-parse-as-library", "native/voice-listener/Sources/VoiceListener/Listener.swift",
    "native/voice-listener/Sources/VoiceListener/Playback.swift", "native/voice-listener/Tests/Fixtures/LifecycleDevices.swift", "-o", binary]);
  const listener = promisify(execFile)(binary, [], { env: { ...process.env, MISSION_VOICE_DAEMON_URL: daemon.baseURL,
    MISSION_VOICE_TOKEN_FILE: join(daemon.home, "token"), MISSION_VOICE_MODEL_DIR: daemon.home } });
  const stopped = listener.then(() => null, error => error);
  try {
    await expect(task).toHaveValue("Steve, check");
    await captureCard(dialog, "fluidaudio-hands-free-interim");
    listener.child.kill("SIGUSR1");
    await expect(task).toHaveValue("Steve, check the build");
    expect((await (await page.request.get(daemon.baseURL + "/api/voice/heard")).json()).entries).toHaveLength(0);
  } finally {
    listener.child.kill();
    await stopped;
  }
  const error = await stopped;
  if (error && error.signal !== "SIGTERM") throw error;
});
