# 2026-10-19 — Setup: root-owned npm prefix, broken claude, and Ulanzi-only onboarding

**What the tester saw.** Ulanzi Studio QA ran `npx @agentdeck/setup` on a Mac
with system-installed Node v24.16.0, whose global prefix is `/usr/local`, owned
by root. Setup printed `[OK] Claude Code CLI found`, but that `claude` could not
run: "claude native binary not installed… postinstall did not run". The bridge
install then failed with `EACCES: mkdir '/usr/local/lib/node_modules/@agentdeck'`.
Setup printed "Prebuilt install failed — retrying with a source build of
node-pty" and ran the same root-owned install again. npm warned
`Unknown env config "build-from-source"`, failed with the same EACCES, and setup
ended with `[FAIL] Unexpected error: Command failed: npm install -g @agentdeck/bridge`.
After the tester set an npm prefix by hand, setup completed, but it printed
Stream Deck next steps to a D200H user and left `agentdeck daemon install` for
them to discover while the keys sat OFFLINE. On Windows the same tester was
warned "Stream Deck app not found — Stream Deck keys will be unavailable"; they
use only Ulanzi Studio.

**Causes.**

- The install's `catch {}` discarded npm's error and treated every failure as a
  node-pty prebuild failure.
- Writability of the npm prefix was never checked.
- `which claude` was taken as proof that `claude` works. The npm package's
  launcher exists even when its native binary does not.
- Surface detection knew only the Elgato app.
- Next steps were hard-coded to Stream Deck on macOS and Windows.

**What changed** (`setup/src/onboarding.ts`, pure and unit-tested;
`setup/src/setup.ts` performs the I/O).

- npm's stderr is shown and captured, then classified. A permission error is
  never retried as a source build. Only a native-build marker earns the single
  source-build retry, and any other failure prints the tail of npm's output.
- An unwritable prefix (checked up front, or reported by EACCES) installs into
  `~/.agentdeck/npm` without sudo. Setup prepends its `bin` to this run's PATH,
  so `agentdeck diag native` and `daemon install` resolve it. On macOS and
  Linux, one marked line is appended to the login profile.
- Windows' persistent PATH is deliberately not edited, and setup prints the
  directory instead. `setx` truncates, and a `reg`/.NET read-modify-write can
  flatten `%VAR%` entries on a machine we could not test.
- The LaunchAgent, Scheduled Task and systemd unit already bake absolute
  `process.execPath` + `cli.js` (`getDaemonNodeTarget`). New bridge tests pin
  this, so autostart never depends on PATH.
- `claude --version` must exit 0 within 5 s. A `claude` that is present but
  broken gets one WARN line, and hooks are still installed.
  `seedCompatibility` reuses that result and no longer prints the raw error
  again.
- Ulanzi Studio is detected (macOS paths verified on this machine).
  `--surface=ulanzi|streamdeck` forces the deck host. The next steps cover only
  the host that is present, and a host the user does not use is never a
  warning.
- Daemon autostart stays opt-in (an owner-level product decision), but an
  interactive run asks `[y/N]`. Every run that ends without the daemon closes
  with a plain warning that keys stay OFFLINE until it is installed. With
  `--yes`, setup installs it as before.

**Not verified.**

- No fresh-Mac or Windows run with the real registry. The flows were exercised
  with a temporary HOME and a fake `npm`/`claude`/`agentdeck` on a restricted
  PATH: up-front fallback, EACCES-then-fallback, `--yes`, and the TTY prompt
  under `script(1)` answered y and n.
- The Windows Ulanzi Studio paths (`%APPDATA%\Ulanzi\UlanziDeck`, `%ProgramFiles%\Ulanzi Studio`, …)
  are guesses that no real install has confirmed. A miss lists both hosts.
- The Windows per-user-prefix branch (`npm.cmd` through a shell, quoting a
  `%USERPROFILE%` that contains a space) was not run on Windows.
- Linux login-profile behaviour is inferred from bash's documented file order,
  not observed on a desktop session.
- In the `script(1)` harness, input written before the prompt appeared was lost
  (read as No). An answer typed after the prompt worked.
