# 2026-10-06 — Deck control in each agent's own words (#463)

Deck control had drifted toward monitoring once agents moved to auto mode. The redesign in [#463](https://github.com/puritysb/AgentDeck/issues/463) follows four rules. It works inside the sandboxed Swift daemon, with no PTY parsing or keystroke injection. Button-only decks come first. Every level, list and default is the agent's own value, read at request time. The deck never sets or writes a default.

### Measured facts

- **Claude Code 2.1.289**
  - `SessionStart` carries `model`, `Stop` carries `effort.level`, and every event carries `permission_mode`. `effort.level` follows a live `/effort`.
  - Changing `model` in settings.json does not reach a running session. Hooks cannot change model, effort or mode.
  - Running `/effort` in *any* session, including one in a scratch directory, persists `modelSettings.<model>.effortLevel` to the **user-global** settings. Back up global settings before experimenting with it.
- **Codex 0.156**
  - Hooks carry only `model`. Their `permission_mode` is a Claude-compatible label that Codex derives from `approval_policy`.
  - Effort and mode come from the rollout's latest `turn_context`: `effort`, and `plan` or `sandbox_policy.type`.
- **OpenClaw 2026.9.8**
  - `sessions.list` rows carry per-model `thinkingLevels` (`{id,label}`), `thinkingDefault` and `modelOverrideSource`.
  - `sessions.patch {key, model: "provider/model" | null, thinkingLevel | null}` applies to subsequent turns. It refuses an invalid level with a message that names the allowed ones.
- **OpenCode** offers only per-prompt `model` / `agent` / `variant` overrides. The deck therefore does not offer it as a session switch.

### Shipped as a stack

- [#464](https://github.com/puritysb/AgentDeck/pull/464): observed model · effort · mode readout on both daemons and both decks.
- [#465](https://github.com/puritysb/AgentDeck/pull/465): OpenClaw MODEL / THINKING picker.
  - New commands `query_session_settings` / `set_session_setting` and event `session_settings`. They stay off `sessions_list`, because every board receives that frame.
  - Shared projection `openClawSessionSettings`, mirrored in Swift.
  - Also fixes the Swift `send_prompt`, which sent `chat.send` with no `message`.
- [#466](https://github.com/puritysb/AgentDeck/pull/466): NOW card built from row facts.

### Known limits

- The sandboxed Swift daemon has no Claude transcript bookmark, so it keeps the SessionStart model.
- Hardware validation on Stream Deck+ and D200H is still pending.
