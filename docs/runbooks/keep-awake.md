# Keep Awake - real macOS verification runbook

Automated tests prove the daemon owns the native assertion lifecycle, that every window
converges over SSE through a Linux-safe command fixture, and that a restart returns the mode to off.
What they cannot prove is that the OPERATING SYSTEM honoured the assertion - that the Mac
really did stay up with the screen locked, and really did let go afterwards. This runbook
is that receipt. Perform it on a real Mac against a real daemon (no
`MISSION_KEEP_AWAKE_BIN` override) and record the observations in the change that needed
them.

## The exact guarantee being verified

- **On** prevents user-idle system sleep only, via a daemon-owned in-process IOKit
  `PreventUserIdleSystemSleep` assertion.
- The display still dims and locks on the normal schedule. Mission Control creates no
  display-sleep assertion and declares no user activity.
- Lid close, manual Sleep, shutdown, power loss, and thermal or low-battery safeguards
  still win.
- The mode is transient: off on every daemon start, released on quit, crash, and restart,
  never persisted, never reacquired.

## 1. Enable, and see the assertion

1. Open the dashboard, click the **live** segment in the fleet pulse, and switch
   **Keep this Mac awake** on. The indicator must read `live · awake`.
2. Record the daemon PID, then confirm the same process owns the assertion:

   ```sh
   curl -s 127.0.0.1:7317/api/health
   pmset -g assertions | grep -A4 "Mission Control is keeping"
   ```

   Expect the daemon PID, a `PreventUserIdleSystemSleep` assertion, and the bounded Mission
   Control reason. Confirm there is no Mission Control `PreventUserIdleDisplaySleep`
   assertion and no old command-provider child:

   ```sh
   ps -o pid,ppid,command -ax | grep "[c]affeinate -i -w"
   ```

   This command must print nothing.

## 2. The display locks while the system stays up

1. Leave Keep awake on. Lock the screen (Ctrl-Cmd-Q) and walk away past the display-sleep
   interval.
2. Observe: the display turns off and requires a password - and Mission Control keeps
   working. A running agent's transcript keeps growing, or a Recurring Mission fires on
   time; either is the observation. `pmset -g log | grep -i "PreventUserIdle" | tail`
   shows the assertion held across the window.

## 3. Disable releases it

1. Switch Keep awake off. The indicator returns to plain `live`.
2. `pmset -g assertions` no longer lists the Mission Control assertion. No
   `caffeinate -i -w` process should have existed before or after disable.

## 4. An abrupt daemon death releases it too

1. Switch Keep awake on and confirm the assertion as in step 1.
2. Kill the daemon without ceremony: `kill -9 <daemon PID>`.
3. `pmset -g assertions` shows the assertion gone after the process dies. IOKit removed
   the process-owned assertion without an orderly JavaScript cleanup path.

## 5. A restart returns the mode to off

1. Start the daemon again (or let the supervisor bring it back).
2. Reload the dashboard: the indicator reads plain `live`, the dropdown switch is off,
   and `pmset -g assertions` shows no Mission Control assertion. The mode was not persisted
   and was not reacquired - turning it back on is always an explicit operator action.

## Recording the receipt

Paste into the PR (or the change record) the four observations: the assertion line from
step 1, the locked-screen-while-working note from step 2, the empty assertion list from
step 3, and the post-crash/post-restart off states from steps 4 and 5, each with the
daemon PID visible. Repeat the enable/disable/restart checks through standalone `npm start`,
packaged Electron, an adopted daemon, and the LaunchAgent. The LaunchAgent entry builds the native
addon before it exec-replaces itself with the source daemon, so its PID remains launchd's exact
service PID. If IOKit denies or terminates the assertion, or endpoint policy prohibits it, stop and
record the exact return and policy evidence. Do not add a command, input, audio, display, or
automatic-retry fallback.
