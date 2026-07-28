import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertElectronGuiLaunchAllowed,
  ELECTRON_GUI_SANDBOX_ERROR,
} from "./helpers/electron-gui.ts";

test("Electron GUI fixtures reject Codex Seatbelt on macOS before launch", () => {
  assert.throws(
    () => assertElectronGuiLaunchAllowed("darwin", "seatbelt"),
    { message: ELECTRON_GUI_SANDBOX_ERROR },
  );
});

test("Electron GUI fixtures allow supported launch environments", () => {
  assert.doesNotThrow(() => assertElectronGuiLaunchAllowed("darwin", ""));
  assert.doesNotThrow(() => assertElectronGuiLaunchAllowed("linux", "seatbelt"));
});
