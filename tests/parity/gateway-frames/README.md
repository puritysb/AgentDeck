# Gateway parity fixtures

Canonical JSON frames for the OpenClaw Gateway protocol. Both the Node adapter (`bridge/src/adapters/openclaw.ts`) and the Swift adapter (`apple/AgentDeck/Daemon/Gateway/OpenClawAdapter.swift`) must accept these same frames and produce equivalent observable behavior.

Each fixture conforms to the `GatewayFrame` union declared in [`shared/src/gateway-protocol.ts`](../../../shared/src/gateway-protocol.ts). Regenerate the JSON schema with `pnpm generate-protocol`; the Vitest test `bridge/src/__tests__/gateway-parity-fixtures.test.ts` validates every fixture loads and — for the frames a parser reads — asserts on that **parser's output**.

## These frames are captured, not composed

Every `chat` / `session.*` / `exec.approval.*` fixture here was taken off a live Gateway (`openclaw@2026.7.1-2`) and then content-scrubbed: paths and free text are replaced, the session snapshot the `session.*` frames also carry is trimmed to the identifying fields, and **every field a parser reads is verbatim**.

That rule exists because the previous fixtures were composed from an assumption and were wrong for months without anything going red. A fixture, a TypeScript interface, and a test assertion authored together from one guess are three mutually-consistent copies of that guess — they agree with each other forever, and nothing in the loop had ever been compared against OpenClaw. Concretely:

- `chat` carried a `prompt`, a `tools[]`, `modelId` and token counts. The real frame (`emitChatDelta` / `emitChatTerminal`) is **assistant-only** and carries none of them. Reading `payload.prompt` is why no APME turn was ever opened for a conversation started in the OpenClaw app.
- `session.message` was a flat `{role, text}`. The real payload nests `{role, content, provider, model, usage}` under `message`, with `content` a string for user messages and typed blocks otherwise.
- `session.tool` was a flat `{name, status, input, output}`. The real facts live under `data` as `{phase, name, toolCallId, args, result, isError}`.
- `exec.approval.requested` still carried the flat `{tool, command, reason, options:[{key:'allow'}]}` shape *after* `shared/src/openclaw-approval.ts` had been rewritten to document that shape as disproven — including the `'allow'` decision the Gateway rejects.

So a fixture earns its place by driving the real parser to the right output, never by restating its own fields.

## Coverage

| Fixture                                    | Frame                    | Scenario |
|--------------------------------------------|--------------------------|----------|
| `connect-challenge.json`                    | event                    | handshake start — Gateway sends nonce |
| `connect-ok.json`                           | res                      | handshake reply accepting the signed device auth |
| `connect-hello-ok-device-token.json`        | res                      | handshake reply carrying a device token |
| `auth-pairing-required-error.json`          | res                      | handshake refused until the device is paired |
| `chat-delta.json`                           | event (chat)             | streaming delta — assistant message only, no prompt |
| `chat-final.json`                           | event (chat)             | terminal turn — assistant message + `stopReason` |
| `session-message-user.json`                 | event (session.message)  | **the user prompt** — the only channel that carries it |
| `session-message-assistant-text.json`       | event (session.message)  | assistant reply + per-turn `provider`/`model`/`usage` |
| `session-message-assistant-toolcall.json`   | event (session.message)  | assistant message whose content is a `toolCall` block |
| `session-tool-start.json`                   | event (session.tool)     | tool invoked, with its arguments |
| `session-tool-result.json`                  | event (session.tool)     | tool finished, with its result |
| `exec-approval-requested.json`              | event                    | bash approval, everything nested under `request` |
| `sessions-changed.json`                     | event                    | session list invalidated |
| `health-event.json`                         | event                    | gateway health report |
| `models-list-response.json`                 | res                      | model catalog |
| `logs-tail-response.json`                   | res                      | gateway log tail |
| `rpc-error.json`                            | res                      | error response (NOT_PAIRED code) |
| `tick.json`                                 | event                    | server heartbeat |

**`session.message` and `session.tool` only arrive after `sessions.subscribe`.** The Gateway's recipient set for both is `sessionEventSubscribers ∪ sessionMessageSubscribers`; a connection in neither set receives no frame at all, which is how the handlers for both events existed for months without ever running.

## Adding a fixture

1. Capture the frame from a real Gateway — do not compose it from the TypeScript type.
2. Scrub free text and paths, and trim the session snapshot; leave every parsed field verbatim.
3. Drop the JSON file in this directory.
4. Add an assertion in `gateway-parity-fixtures.test.ts` that runs it through the parser that consumes it in production.
5. Update the table above.
6. When adding Swift parity coverage (Phase 4-B follow-up), add a sibling `XCTest` case under `apple/AgentDeckTests/GatewayParityTests.swift` that decodes the same file and asserts the same observable shape.
