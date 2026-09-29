# 2026-09-20 — z.ai GLM Coding Plan usage provider (#348)

A GLM Coding Plan user (Claude Code pointed at `https://api.z.ai/api/anthropic`)
had no usage gauges anywhere: the Claude 5h/7d gauges are meaningless without an
Anthropic subscription, so the usage area read as dead space, and plan
exhaustion (the MCP tool window hitting 100%) was invisible until requests
failed with `code 1310`.

**The data source, measured before building.** `GET
https://api.z.ai/api/monitor/usage/quota/limit` with the coding-plan key (raw
`Authorization`, Bearer also accepted; undocumented — the same status as
Codex's account endpoint). Live-verified against a Max-plan account: `level`
stamps the tier per snapshot, `limits[]` carries the 5h credits window
(TOKENS_LIMIT), the monthly MCP window (TIME_LIMIT), or a credit-only schema on
lite (CREDIT_LIMIT unit=3/6); `nextResetTime` is epoch-ms. Weekly credits are
not exposed on the standard schema, so the secondary window renders only when
present. Community parsers (TokenStep, opencode-bar) corroborate the shapes and
the pay-as-you-go key markers (`sk-pay`/`payg`).

**Design: a provider account, not a harness feature.** One key serves Claude
Code, Codex and any other CLI from one quota, so z.ai is modeled like the
Anthropic/OpenAI accounts behind the existing gauges. Key custody is
AgentDeck-owned: the Node daemon resolves `AGENTDECK_ZAI_API_KEY` → daemon
settings `zaiApiKey` → a Claude-settings z.ai-redirect hint; the Swift app
stores a Keychain key pasted in Settings (the Admin-API-key pattern). No
subprocess anywhere — Swift daemon-only works by construction.

**Wire + SSOT.** A namespaced `zaiRateLimits` block mirroring `CodexRateLimits`
(primary 5h / secondary long window by length, planType=level,
limitId=schema family, capturedAt). Classification is a new generated SSOT
(`shared/src/zai-quota.ts` → `ZaiQuotaRules.generated.swift`, vectors replayed
by both suites) — the fourth Codex axis ("which limit") exists here as the
standard-vs-credit schema split. Display retirement after 10 minutes ships as
an explicit windowless block (retain-on-absent); PAYG keys ship `{limitId:
"payg"}` — absence of windows is never 0%.

**Surfaces, zero-regression.** Glance rows cap 3→4 with compact flow (a
provider with no numbers leaves no gap); the D200H usage strip gained a third
compaction step — all three providers live is six windows on three pair tiles,
nothing dropped, and a GLM-only user gets the strip to themselves; the Pixoo
usage HUD keeps its two 7px rows (third provider stays on surfaces that can
compose three — geometry is not renegotiated per provider count); Apple
TopologyRail gains a z.ai row + Settings key editor; Android's card and rail
follow the same neutral-row grammar (no upstream z.ai brand mark ships in
design/brand/, and marks are never redrawn — identity is text until one does).

Deferred to #348 phase 3: Stream Deck usage action (new UUID — marketplace
decision), ESP32 firmware parse+render (fleet-gated OTA), model/tool-usage
timeseries detail, cross-daemon z.ai relay over the sibling `/usage` path.

**MCP is a different quantity, and now says so (owner direction, same day).**
The 30d window meters MCP TOOL CALLS, not tokens, and rendering it with the
window-length grammar let it read as token usage. The wire windows now carry
`quantity: "tokens" | "mcp"` (SSOT-classified, vectors replayed by both
suites), and every surface labels the MCP gauge by its quantity — "MCP" —
never by its length. A first cut of measured 24h token volume
(`tokensUsed24h` from the provider's `model-usage` report) shipped and was
then withdrawn at owner direction — the credits windows are the signal; the
extra request per poll bought a number nobody read.

**The real z.ai mark (owner direction).** The upstream logo
(z-cdn.chatglm.cn/z-ai/static/logo.svg, captured 2026-09-20) ships as
`design/brand/zai.svg`: the Z's three strokes verbatim, mark without the
app-icon plate, matching the mark-without-background convention of every
other file there. Brand.zai (#1F63EC, measured from the same asset) joins the
token chain; the D200H usage tile, the Pixoo HUD row and the Android usage
card carry the mark (dot-matrix masks regenerated); the brand-assets contract
test pins the geometry to both vector registries and RESOURCES.md records the
source and trademark holder.

**Free-space usage expansion (#349, owner direction).** When the session
roster leaves keys free, the usage area grows into them — one window per key
instead of compacted pairs — and never at the cost of a session key: `spare`
is computed after the roster (overflow ⇒ no spare by construction), and the
compaction cascade re-runs at the larger budget so partial spare relaxes
compaction exactly as far as it fits. The strip-contract tests keep their
compaction intent by filling their rosters; the new free-space suite pins the
expansion (six windows on six keys), the sessions-win invariant, and the
no-spare shape. Hardware verification stays a main-checkout step: the plugin
link from a worktree is refused by the install guard (the Stream Deck
dark-key incident), and the DRM marketplace loop is external by nature.
