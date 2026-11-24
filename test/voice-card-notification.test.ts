import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { NotificationConstructorOptions } from "electron";
import { registerVoiceCardNotifications } from "../src/main/voice-card-notification.ts";

function notificationFixture({ focused = false, supported = true } = {}) {
  const notices: NativeNotice[] = [];
  class NativeNotice extends EventEmitter {
    static isSupported() { return supported; }
    shown = false;
    closed = false;
    constructor(readonly options: NotificationConstructorOptions) {
      super();
      notices.push(this);
    }
    show() { this.shown = true; }
    close() { this.closed = true; }
  }
  type Handler = (event: { sender: unknown }, input: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const register = (channel: string, handler: Handler) => handlers.set(channel, handler);
  const owner = { webContents: {}, isFocused: () => focused, show() {} };
  registerVoiceCardNotifications({ on: register, handle: register }, () => owner, NativeNotice);
  const input = { id: crypto.randomUUID(), title: "To Steve · sending in 4s", body: "check the build", deadline: Date.now() + 4000 };
  return {
    input, notices,
    show: (payload: unknown = input, sender = owner.webContents) => handlers.get("mission:voice-card-notice")!({ sender }, payload),
    dismiss: (sender = owner.webContents) => handlers.get("mission:voice-card-dismiss")!({ sender }, input.id),
  };
}

test("the registered Electron handler presents the words and maps each native button to its action", async () => {
  for (const [index, action] of ["cancel", "send-now"].entries()) {
    const fixture = notificationFixture();
    const result = fixture.show();
    const [notice] = fixture.notices;
    assert.ok(notice?.shown);
    assert.equal(notice.options.title, fixture.input.title);
    assert.equal(notice.options.body, fixture.input.body);
    assert.deepEqual(notice.options.actions, [{ type: "button", text: "Cancel" }, { type: "button", text: "Send now" }]);
    notice.emit("action", { actionIndex: index });
    assert.equal(await result, action);
    assert.ok(notice.closed);
  }
});

test("a different renderer cannot create or dismiss the owner's notification", async () => {
  const fixture = notificationFixture();
  const otherRenderer = {};
  assert.equal(fixture.show(fixture.input, otherRenderer), null);
  assert.equal(fixture.notices.length, 0);

  const result = fixture.show();
  const [notice] = fixture.notices;
  assert.ok(notice?.shown);
  assert.equal(fixture.dismiss(otherRenderer), undefined);
  assert.equal(fixture.notices.length, 1);
  assert.equal(notice.closed, false);
  notice.emit("action", { actionIndex: 0 });
  assert.equal(await result, "cancel");
  assert.equal(notice.closed, true);
});

test("a focused owner, unsupported notifications and a malformed request create no notification", () => {
  for (const fixture of [notificationFixture({ focused: true }), notificationFixture({ supported: false })]) {
    assert.equal(fixture.show(), null);
    assert.equal(fixture.notices.length, 0);
  }
  const fixture = notificationFixture();
  assert.equal(fixture.show({ ...fixture.input, id: "invalid" }), null);
  assert.equal(fixture.notices.length, 0);
});

test("the handler rejects late native clicks even before the expiry timer runs", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  for (const [index, lateness] of [0, 1].entries()) {
    const fixture = notificationFixture();
    const result = fixture.show();
    const [notice] = fixture.notices;
    assert.ok(notice?.shown);
    t.mock.timers.setTime(fixture.input.deadline + lateness);
    notice.emit("action", { actionIndex: index });
    assert.equal(await result, null);
    assert.ok(notice.closed);
    assert.equal(fixture.show(), null);
    assert.equal(fixture.notices.length, 1);
  }
});

test("expiry and renderer dismissal both close a pending notification without an action", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  for (const close of ["dismiss", "timeout"]) {
    const fixture = notificationFixture();
    const result = fixture.show();
    if (close === "dismiss") fixture.dismiss();
    else t.mock.timers.tick(4000);
    assert.equal(await result, null);
    assert.ok(fixture.notices[0]?.closed);
  }
});
