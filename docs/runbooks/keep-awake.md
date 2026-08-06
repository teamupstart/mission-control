# Keep Awake - real macOS verification runbook

Automated tests prove the daemon spawns `caffeinate` with exactly `-i -w <daemon PID>`,
that every window converges over SSE, and that a crash or restart returns the mode to off.
What they cannot prove is that the OPERATING SYSTEM honoured the assertion - that the Mac
really did stay up with the screen locked, and really did let go afterwards. This runbook
is that receipt. Perform it on a real Mac against a real daemon (no
`MISSION_KEEP_AWAKE_BIN` override) and record the observations in the change that needed
them.

## The exact guarantee being verified

- **On** prevents user-idle system sleep only, via
  `/usr/bin/caffeinate -i -w <daemon PID>`.
- The display still dims and locks on the normal schedule; `-d`, `-u` and `-s` are never
  passed.
- Lid close, manual Sleep, shutdown, power loss, and thermal or low-battery safeguards
  still win.
- The mode is transient: off on every daemon start, released on quit, crash, and restart,
  never persisted, never reacquired.

## 1. Enable, and see the assertion

1. Open the dashboard, click the **live** segment in the fleet pulse, and switch
   **Keep this Mac awake** on. The indicator must read `live · awake`.
2. Confirm the OS holds the assertion, bound to `caffeinate`:

   ```sh
   pmset -g assertions | grep -A2 caffeinate
   ```

   Expect a `PreventUserIdleSystemSleep` assertion named for the `caffeinate` process, and
   the process itself watching the daemon:

   ```sh
   ps -o pid,ppid,command -ax | grep "[c]affeinate -i -w"
   ```

   The `-w` argument must be the daemon's PID (`curl -s 127.0.0.1:7317/api/health`).
   Confirm `PreventUserIdleDisplaySleep` is NOT asserted by this process.

## 2. The display locks while the system stays up

1. Leave Keep awake on. Lock the screen (Ctrl-Cmd-Q) and walk away past the display-sleep
   interval.
2. Observe: the display turns off and requires a password - and Mission Control keeps
   working. A running agent's transcript keeps growing, or a Recurring Mission fires on
   time; either is the observation. `pmset -g log | grep -i "PreventUserIdle" | tail`
   shows the assertion held across the window.

## 3. Disable releases it

1. Switch Keep awake off. The indicator returns to plain `live`.
2. `pmset -g assertions` no longer lists the caffeinate assertion, and the
   `caffeinate -i -w` process is gone.

## 4. An abrupt daemon death releases it too

1. Switch Keep awake on and confirm the assertion as in step 1.
2. Kill the daemon without ceremony: `kill -9 <daemon PID>`.
3. Within a few seconds the `caffeinate` child exits on its own (`-w` watched the daemon)
   and `pmset -g assertions` shows the assertion gone. Nothing needed the orderly
   shutdown path.

## 5. A restart returns the mode to off

1. Start the daemon again (or let the supervisor bring it back).
2. Reload the dashboard: the indicator reads plain `live`, the dropdown switch is off,
   and `pmset -g assertions` shows no caffeinate assertion. The mode was not persisted
   and was not reacquired - turning it back on is always an explicit operator action.

## Recording the receipt

Paste into the PR (or the change record) the four observations: the assertion line from
step 1, the locked-screen-while-working note from step 2, the empty assertion list from
step 3, and the post-crash/post-restart off states from steps 4 and 5, each with the
daemon PID visible so the `-w` binding is checkable.
