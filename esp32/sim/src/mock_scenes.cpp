// Named mock DashboardState presets for the host simulator. These populate the
// same g_state the firmware fills from the daemon's `state_update` — the
// terrarium reads it identically, so a scene here exercises the real creature
// derivation (session → octopus/cloud/opencode/antigravity/kiro + crayfish
// gateway).
#include "sim.h"
#include "config.h"
#include "state/agent_state.h"
#include <cstdio>
#include <cstring>

namespace {

void setStr(char* dst, size_t cap, const char* src) {
  std::strncpy(dst, src, cap - 1);
  dst[cap - 1] = '\0';
}

// Append one alive session (with a distinct project/display name) and bump the
// matching derived creature count + per-type display-name array the way the
// daemon's sessions_list does, so the HUD list and creature tags read distinctly.
void addSession(const char* agentType, const char* state, const char* project) {
  if (g_state.sessionCount >= 10) return;
  SessionInfo& s = g_state.sessions[g_state.sessionCount];
  std::memset(&s, 0, sizeof(s));
  // Unique per-session id (real sessions are UUIDs); same-project sessions must
  // still be distinct so per-card timeline attribution can be exercised.
  std::snprintf(s.id, sizeof(s.id), "s%u-%s", (unsigned)g_state.sessionCount, project);
  g_state.sessionCount++;
  setStr(s.agentType, sizeof(s.agentType), agentType);
  setStr(s.state, sizeof(s.state), state);
  setStr(s.projectName, sizeof(s.projectName), project);
  setStr(s.modelName, sizeof(s.modelName), "opus-4.8");
  s.alive = true;
  if (std::strcmp(agentType, "claude-code") == 0)
    setStr(g_state.sessionNames[g_state.octopusCount++], 24, project);
  else if (std::strcmp(agentType, "codex-cli") == 0 || std::strcmp(agentType, "codex-app") == 0)
    setStr(g_state.cloudNames[g_state.cloudCount++], 24, project);
  else if (std::strcmp(agentType, "opencode") == 0)
    setStr(g_state.opencodeNames[g_state.opencodeCount++], 24, project);
  else if (std::strcmp(agentType, "antigravity") == 0)
    setStr(g_state.antigravityNames[g_state.antigravityCount++], 24, project);
  // Prefix match, exactly as protocol.cpp does: kiro-cli and kiro-ide are the
  // same product on two surfaces and share one creature. This whole chain is a
  // hand copy of protocol.cpp's classifier and it had already drifted — Kiro
  // landed on the boards while the simulator kept rendering it as nothing, so
  // every pixel-exact board frame on the demo page was missing an agent the
  // firmware supports.
  else if (std::strncmp(agentType, "kiro", 4) == 0)
    setStr(g_state.kiroNames[g_state.kiroCount++], 24, project);
}

// Append a timeline row the way protocol.cpp handleTimelineEvent does, so card
// bodies / tickers exercise the real per-session attribution + compose paths.
void addTimeline(const char* type, const char* sid, const char* raw, const char* taskId) {
  TimelineEntry e;
  std::memset(&e, 0, sizeof(e));
  setStr(e.type, sizeof(e.type), type);
  setStr(e.raw, sizeof(e.raw), raw);
  setStr(e.sessionId, sizeof(e.sessionId), sid);
  if (taskId) setStr(e.taskId, sizeof(e.taskId), taskId);
  setStr(e.hm, sizeof(e.hm), "12:34");
  e.ts = 12 * 3600 + 34 * 60;
  g_state.addTimelineEntry(e);
}

void base(CreatureState cs) {
  g_state.reset();
  g_state.dataReceived = true;
  g_state.wsConnected = true;
  g_state.state = AgentState::IDLE;
  g_state.creatureState = cs;
  g_state.crayfishState = CrayfishState::DORMANT;
  g_state.tetraState = TetraState::HOVERING;
  setStr(g_state.agentType, sizeof(g_state.agentType), "daemon");
  setStr(g_state.projectName, sizeof(g_state.projectName), "AgentDeck");
  setStr(g_state.modelName, sizeof(g_state.modelName), "opus-4.8");
  g_state.hostDisplayOn = true;      // host-awake baseline for display-sync scenes
  g_state.userBrightness = 255;
  // Usage — drives the 5H/7D rate gauges (matrix usage page, HUD, e-ink).
  g_state.fiveHourPercent = 42.0f;
  g_state.sevenDayPercent = 68.0f;
  setStr(g_state.fiveHourReset, sizeof(g_state.fiveHourReset), "2h 15m");
  setStr(g_state.sevenDayReset, sizeof(g_state.sevenDayReset), "3d 4h");
  g_state.inputTokens = 128000; g_state.outputTokens = 41000;
  g_state.toolCalls = 87; g_state.sessionDurationSec = 5400;
  g_state.estimatedCostUsd = 3.42f;
  g_state.codexPrimaryMinutes = 300;
  g_state.codexSecondaryMinutes = 10080;
  g_state.zaiPrimaryMinutes = 300;
  g_state.zaiSecondaryMinutes = 10080;
  g_state.codexPrimaryPercent = -1.0f;   // no Codex-window data by default
  g_state.codexSecondaryPercent = -1.0f;
  g_state.zaiPrimaryPercent = g_state.zaiSecondaryPercent = -1.0f;
  g_state.antigravityCredits = -1.0f;
  setStr(g_state.subscriptions[0].name, sizeof(g_state.subscriptions[0].name), "Claude Max");
  setStr(g_state.subscriptions[0].until, sizeof(g_state.subscriptions[0].until), "~7/28");
  g_state.subscriptionCount = 1;
}

// `demo:<agent>:<state>` — the creature-simulator web demo's agent × state
// matrix (agents: claude|codex|opencode|openclaw|antigravity|kiro, states:
// idle|working|asking|sleeping). Session shape and usage values mirror
// scripts/render-creature-simulator.mjs buildSessions()/buildUsage() so the
// ESP32 panels on the demo page stay visually coherent with the LED-matrix /
// deck panels rendered from the Node-side canonical renderers. State mapping
// follows the demo's simStateToBridge(): working→processing,
// asking→awaiting_permission, sleeping/idle→idle. OpenClaw is not a PTY
// session on-device — it surfaces as the gateway crayfish.
bool applyDemoScene(const char* agent, const char* state) {
  const bool working = std::strcmp(state, "working") == 0;
  const bool asking = std::strcmp(state, "asking") == 0;
  base(working ? CreatureState::WORKING
               : asking ? CreatureState::ASKING
                        : CreatureState::FLOATING);
  g_state.state = working ? AgentState::PROCESSING
                          : asking ? AgentState::AWAITING_PERMISSION
                                   : AgentState::IDLE;
  // Usage parity with the demo's buildUsage().
  g_state.fiveHourPercent = 46.0f;
  g_state.sevenDayPercent = 72.0f;
  setStr(g_state.fiveHourReset, sizeof(g_state.fiveHourReset), "1h 30m");
  setStr(g_state.sevenDayReset, sizeof(g_state.sevenDayReset), "1d 4h");
  g_state.codexPrimaryPercent = 38.0f;
  g_state.codexSecondaryPercent = 64.0f;
  setStr(g_state.codexPrimaryReset, sizeof(g_state.codexPrimaryReset), "2h 30m");
  setStr(g_state.codexSecondaryReset, sizeof(g_state.codexSecondaryReset), "2d 4h");

  struct Row { const char* key; const char* agentType; const char* project; };
  const Row rows[] = {
      {"claude", "claude-code", "Claude"},
      {"codex", "codex-cli", "Codex"},
      {"opencode", "opencode", "OpenCode"},
      {"antigravity", "antigravity", "Antigravity"},
      {"kiro", "kiro-cli", "Kiro"},
  };
  bool known = std::strcmp(agent, "openclaw") == 0;
  const char* selectedState = working ? "processing"
                                      : asking ? "awaiting_permission" : "idle";
  // Selected agent first (demo ordering), then the rest idle.
  for (const Row& r : rows)
    if (std::strcmp(agent, r.key) == 0) {
      addSession(r.agentType, selectedState, r.project);
      if (asking)
        setStr(g_state.sessions[0].question, sizeof(g_state.sessions[0].question),
               "Allow Bash command? rm -rf build/");
      known = true;
    }
  for (const Row& r : rows)
    if (std::strcmp(agent, r.key) != 0) addSession(r.agentType, "idle", r.project);

  // Gateway crayfish — visible in every demo scene; routing when OpenClaw works.
  g_state.gatewayAvailable = true;
  g_state.gatewayConnected = true;
  g_state.crayfishCount = 1;
  g_state.crayfishState = (std::strcmp(agent, "openclaw") == 0 && working)
                              ? CrayfishState::ROUTING
                              : CrayfishState::DORMANT;
  return known;
}

}  // namespace

bool SimScenes::apply(const char* name) {
  if (std::strncmp(name, "demo:", 5) == 0) {
    char agent[16] = {0};
    const char* sep = std::strchr(name + 5, ':');
    if (!sep || (size_t)(sep - (name + 5)) >= sizeof(agent)) return false;
    std::memcpy(agent, name + 5, (size_t)(sep - (name + 5)));
    const char* state = sep + 1;
    if (std::strcmp(state, "idle") && std::strcmp(state, "working") &&
        std::strcmp(state, "asking") && std::strcmp(state, "sleeping"))
      return false;
    return applyDemoScene(agent, state);
  }
  if (std::strcmp(name, "empty") == 0) {
    g_state.reset();
    g_state.fiveHourPercent = g_state.sevenDayPercent = -1;
    g_state.codexPrimaryPercent = g_state.codexSecondaryPercent = -1;
    g_state.zaiPrimaryPercent = g_state.zaiSecondaryPercent = -1;
    g_state.dataReceived = false;   // pre-connection: no quota data or creatures
    return true;
  }
  if (std::strcmp(name, "offline") == 0) {
    base(CreatureState::FLOATING);
    g_state.wsConnected = false;
    g_state.dataReceived = true;  // previously connected, daemon now absent
    g_state.lastMessageMs = 1;
    g_state.sessionCount = 0;
    return true;
  }
  if (std::strcmp(name, "usage-none") == 0 ||
      std::strcmp(name, "usage-zero") == 0 ||
      std::strcmp(name, "usage-stale") == 0) {
    base(CreatureState::FLOATING);
    g_state.fiveHourPercent = g_state.sevenDayPercent = -1;
    if (std::strcmp(name, "usage-zero") == 0) g_state.codexPrimaryPercent = 0;
    if (std::strcmp(name, "usage-stale") == 0) {
      g_state.fiveHourPercent = 82;
      g_state.usageStale = true;
      g_state.codexSecondaryPercent = 37;
    }
    return true;
  }
  if (std::strcmp(name, "usage-all") == 0 || std::strcmp(name, "zai-only") == 0) {
    base(CreatureState::FLOATING);
    g_state.zaiPrimaryPercent = 36;
    setStr(g_state.zaiPrimaryReset, sizeof(g_state.zaiPrimaryReset), "2h 15m");
    g_state.zaiSecondaryPercent = 100;
    g_state.zaiSecondaryIsMcp = true;
    if (std::strcmp(name, "zai-only") == 0) {
      g_state.fiveHourPercent = g_state.sevenDayPercent = -1;
      g_state.subscriptionCount = 0;
    } else {
      g_state.codexPrimaryPercent = 15;
      g_state.codexSecondaryPercent = 30;
      setStr(g_state.codexSecondaryReset, sizeof(g_state.codexSecondaryReset), "6d 1h");
    }
    return true;
  }
  if (std::strcmp(name, "codex-only") == 0) {
    base(CreatureState::FLOATING);
    addSession("openclaw", "idle", "OpenClaw");
    g_state.fiveHourPercent = g_state.sevenDayPercent = -1;
    g_state.codexSecondaryPercent = 37;
    setStr(g_state.codexSecondaryReset, sizeof(g_state.codexSecondaryReset), "6d 1h");
    setStr(g_state.subscriptions[0].name, sizeof(g_state.subscriptions[0].name), "ChatGPT Pro");
    addTimeline("chat_response", "s0-OpenClaw", "Long first line\nSecond line must stay within its row", nullptr);
    addTimeline("chat_response", "s0-OpenClaw", "사용량 표시를 개선했습니다.\n다음 줄도 같은 행에 표시합니다.", nullptr);
    return true;
  }
  // Codex account window exhausted with a Luna reserve reported: every
  // USAGE surface swaps the Codex windows for the reserve ("% left"), and the
  // plan fills the slot the second window leaves.
  if (std::strcmp(name, "codex-luna") == 0) {
    base(CreatureState::FLOATING);
    g_state.codexPrimaryPercent = 100;
    setStr(g_state.codexPrimaryReset, sizeof(g_state.codexPrimaryReset), "1h 10m");
    g_state.codexSecondaryPercent = 62;
    g_state.codexLunaPercent = 32;
    setStr(g_state.codexLunaReset, sizeof(g_state.codexLunaReset), "4h 50m");
    setStr(g_state.subscriptions[1].name, sizeof(g_state.subscriptions[1].name), "ChatGPT Pro");
    setStr(g_state.subscriptions[1].until, sizeof(g_state.subscriptions[1].until), "~8/14");
    g_state.subscriptionCount = 2;
    return true;
  }
  // The live daemon mix measured 2026-09-26: Claude reported as a bare
  // "Claude" subscription (no tier), Codex Pro with no 5h window, z.ai MCP
  // exhausted, Antigravity plan-only.
  if (std::strcmp(name, "live-mix") == 0) {
    base(CreatureState::FLOATING);
    g_state.fiveHourPercent = 12; g_state.sevenDayPercent = 87;
    g_state.codexPrimaryPercent = -1; g_state.codexSecondaryPercent = 83;
    setStr(g_state.codexSecondaryReset, sizeof(g_state.codexSecondaryReset), "4d 2h");
    g_state.zaiPrimaryPercent = 7; g_state.zaiSecondaryPercent = 100; g_state.zaiSecondaryIsMcp = true;
    const char* subs[][2] = {{"ChatGPT Pro", "~10/10"}, {"Claude", ""}, {"GLM Coding Plan \xC2\xB7 Max", ""}, {"Google AI Pro", ""}};
    for (int i = 0; i < 4; ++i) {
      setStr(g_state.subscriptions[i].name, sizeof(g_state.subscriptions[i].name), subs[i][0]);
      setStr(g_state.subscriptions[i].until, sizeof(g_state.subscriptions[i].until), subs[i][1]);
    }
    g_state.subscriptionCount = 4;
    setStr(g_state.antigravityPlan, sizeof(g_state.antigravityPlan), "Google AI Pro");
    return true;
  }
  if (std::strcmp(name, "idle") == 0) {
    base(CreatureState::FLOATING);
    addSession("claude-code", "idle", "AgentDeck");
    return true;
  }
  if (std::strcmp(name, "display-off") == 0) {
    base(CreatureState::FLOATING);
    addSession("claude-code", "idle", "AgentDeck");
    g_state.hostDisplayOn = false;
    return true;
  }
  if (std::strcmp(name, "working") == 0) {
    base(CreatureState::WORKING);
    addSession("claude-code", "processing", "AgentDeck");
    addSession("claude-code", "processing", "bridge");
    addSession("codex-cli", "processing", "firmware");
    return true;
  }
  // Regression scene for the capped agent strip: five Claudes + Codex fill six
  // slots exactly, so a single-pass fill drops Kiro (lowest agentType rank)
  // entirely. `crowded` is what that bug looked like on the real deck.
  if (std::strcmp(name, "crowded") == 0) {
    base(CreatureState::WORKING);
    addSession("claude-code", "processing", "AgentDeck");
    addSession("claude-code", "idle", "epoch");
    addSession("claude-code", "processing", "OpenClaw");
    addSession("claude-code", "idle", "foundby");
    addSession("claude-code", "idle", "site");
    addSession("codex-app", "idle", "epoch");
    addSession("kiro-cli", "idle", "AgentDeck");
    return true;
  }
  if (std::strcmp(name, "multi") == 0) {
    base(CreatureState::WORKING);
    addSession("claude-code", "processing", "AgentDeck");
    addSession("codex-cli", "processing", "esp32");
    addSession("opencode", "idle", "docs");
    addSession("antigravity", "idle", "apple");
    addSession("kiro-cli", "idle", "hooks");
    g_state.crayfishState = CrayfishState::ROUTING;
    g_state.gatewayConnected = true;   // OpenClaw gateway → crayfish visible
    g_state.crayfishCount = 1;
    // Codex with BOTH windows live → exercises the two-slot gauge layout.
    g_state.codexPrimaryPercent = 12.0f;
    g_state.codexSecondaryPercent = 31.0f;
    setStr(g_state.codexPrimaryReset, sizeof(g_state.codexPrimaryReset), "3h 40m");
    setStr(g_state.codexSecondaryReset, sizeof(g_state.codexSecondaryReset), "5d 12h");
    setStr(g_state.subscriptions[1].name, sizeof(g_state.subscriptions[1].name), "ChatGPT Plus");
    g_state.subscriptionCount = 2;
    return true;
  }
  if (std::strcmp(name, "aquarium") == 0) {
    base(CreatureState::WORKING);
    addSession("claude-code", "processing", "AgentDeck");
    addSession("codex-cli", "processing", "AgentDeck");
    addSession("claude-code", "awaiting_permission", "Website");
    addSession("openclaw", "idle", "OpenClaw");
#if defined(BOARD_IPS10)
    g_state.sessions[0].childrenKnown=true;g_state.sessions[0].childrenActive=2;
#endif
    g_state.gatewayConnected=true;
    setStr(g_state.sessions[0].currentTool,sizeof(g_state.sessions[0].currentTool),"Edit");
    setStr(g_state.sessions[1].currentTool,sizeof(g_state.sessions[1].currentTool),"Bash");
    setStr(g_state.sessions[0].activity,sizeof(g_state.sessions[0].activity),"Refining dashboard layout");
    setStr(g_state.sessions[1].activity,sizeof(g_state.sessions[1].activity),"Checking mobile build");
    setStr(g_state.sessions[2].question,sizeof(g_state.sessions[2].question),"Run the build command?");
    setStr(g_state.sessions[2].activity,sizeof(g_state.sessions[2].activity),"Updating landing page");
    addTimeline("tool_result","s1-AgentDeck","12 checks passed",nullptr);
    g_state.codexPrimaryPercent=23;g_state.codexSecondaryPercent=44;
    setStr(g_state.codexPrimaryReset,sizeof(g_state.codexPrimaryReset),"1h 42m");
    setStr(g_state.codexSecondaryReset,sizeof(g_state.codexSecondaryReset),"5d 9h");
    return true;
  }
  if (std::strcmp(name, "crowd") == 0) {
    // Real-world shape: many concurrent sessions in the SAME project (one big
    // huddle) plus a couple of stragglers — exercises pod grouping + seating.
    base(CreatureState::WORKING);
    addSession("claude-code", "processing", "AgentDeck");
    addSession("claude-code", "processing", "AgentDeck");
    addSession("codex-cli", "processing", "AgentDeck");
    addSession("opencode", "idle", "AgentDeck");
    addSession("claude-code", "awaiting_permission", "AgentDeck");
    addSession("claude-code", "idle", "babelforge");
    addSession("codex-cli", "idle", "openclaw");
    setStr(g_state.sessions[1].activity, sizeof(g_state.sessions[1].activity),
           "Building the AgentDeck CLI");
    setStr(g_state.sessions[1].lastEventText, sizeof(g_state.sessions[1].lastEventText),
           "Wired the daemon milestone line into the session cards");
    setStr(g_state.sessions[1].lastEventTask, sizeof(g_state.sessions[1].lastEventTask),
           "TRMNL timeline");
    setStr(g_state.sessions[1].lastEventHm, sizeof(g_state.sessions[1].lastEventHm), "14:21");
    setStr(g_state.sessions[4].question, sizeof(g_state.sessions[4].question),
           "Bash 명령 실행을 허용할까요? rm -rf build/");
    // Codex post-5h-reset shape: the 5H window is GONE (slot flip), only 7D
    // remains → the provider row must render one clean 7D gauge, no "--".
    g_state.codexPrimaryPercent = -1.0f;
    g_state.codexSecondaryPercent = 44.0f;
    setStr(g_state.codexSecondaryReset, sizeof(g_state.codexSecondaryReset), "6d 2h");
    // Daemon-computed lastEvent* (TIMELINE parity) — the PRIMARY card-body
    // source. Session 2 exercises the full "HH:MM task • text" compose;
    // session 0 has only on-device timeline rows → exercises the ring fallback.
    setStr(g_state.sessions[2].lastEventText, sizeof(g_state.sessions[2].lastEventText),
           "카드 영역에 TIMELINE 과 같은 세션별 최신 마일스톤을 표시");
    setStr(g_state.sessions[2].lastEventTask, sizeof(g_state.sessions[2].lastEventTask),
           "ips10 카드 개선");
    setStr(g_state.sessions[2].lastEventHm, sizeof(g_state.sessions[2].lastEventHm), "14:07");
    setStr(g_state.sessions[3].lastEventText, sizeof(g_state.sessions[3].lastEventText),
           "Reviewed the treemap sizing fix and merged it");
    setStr(g_state.sessions[3].lastEventHm, sizeof(g_state.sessions[3].lastEventHm), "13:52");
    // Per-session timeline rows (Korean + long task headers) — exercises the
    // card-body "<task> · <text>" compose, taskId resolution, and UTF-8-safe
    // truncation exactly the way live daemon rows do.
    addTimeline("task_start", "s0-AgentDeck",
                "ips10 기기에서 에이전트들이 프로젝트 영역 안으로 들어오지 못하는 문제와 카드 텍스트 깨짐을 함께 개선", "t1");
    addTimeline("chat_start", "s0-AgentDeck",
                "타임라인 카드 텍스트가 깨져 보이는 원인을 조사해서 수정하라", "t1");
    addTimeline("chat_response", "s2-AgentDeck",
                "Fixed the treemap sizing so cards fill the pane", nullptr);
    addTimeline("chat_start", "s4-AgentDeck",
                "권한 요청: rm -rf build/ 실행을 허용할까요?", nullptr);
    return true;
  }
  if (std::strcmp(name, "dense") == 0) {
    // Maximum daemon roster: attention and work must stay explicit while the
    // six passive sessions collapse into category-specific summaries on small
    // surfaces. Also stresses IPS10's narrow treemap cells and office pods.
    base(CreatureState::WORKING);
    addSession("claude-code", "awaiting_permission", "AgentDeck");
    addSession("codex-cli", "processing", "firmware");
    addSession("opencode", "processing", "dashboard");
    addSession("antigravity", "processing", "apple");
    addSession("kiro-cli", "idle", "hooks");
    addSession("claude-code", "idle", "bridge");
    addSession("codex-app", "idle", "analytics");
    addSession("opencode", "idle", "docs");
    addSession("antigravity", "idle", "release");
    addSession("kiro-ide", "idle", "design-system");
    setStr(g_state.sessions[0].question, sizeof(g_state.sessions[0].question),
           "Allow the firmware flash on the connected IPS 10.1 panel?");
    g_state.optionCount = 3;
    setStr(g_state.options[0].label, sizeof(g_state.options[0].label), "Allow once");
    setStr(g_state.options[1].label, sizeof(g_state.options[1].label), "Always allow");
    setStr(g_state.options[2].label, sizeof(g_state.options[2].label), "Deny");
    setStr(g_state.sessions[1].lastEventText, sizeof(g_state.sessions[1].lastEventText),
           "Building the adaptive ESP32 dashboard");
    setStr(g_state.sessions[2].lastEventText, sizeof(g_state.sessions[2].lastEventText),
           "Checking dense roster disclosure");
    return true;
  }
  if (std::strcmp(name, "permission") == 0) {
    base(CreatureState::ASKING);
    addSession("claude-code", "awaiting_permission", "AgentDeck");
    setStr(g_state.sessions[0].question, sizeof(g_state.sessions[0].question),
           "Allow AgentDeck to flash the connected display?");
    g_state.optionCount = 3;
    setStr(g_state.options[0].label, sizeof(g_state.options[0].label), "Allow once");
    setStr(g_state.options[1].label, sizeof(g_state.options[1].label), "Always allow");
    setStr(g_state.options[2].label, sizeof(g_state.options[2].label), "Deny");
    g_state.state = AgentState::AWAITING_PERMISSION;
    return true;
  }
  if (std::strcmp(name, "attention") == 0) {
    // Regression: the conversation-first default used to leave this idle
    // OpenClaw card centered while a hidden Claude session triggered the pager
    // chime. The knob must center the exact newly-awaiting session instead.
    base(CreatureState::ASKING);
    addSession("openclaw", "idle", "OpenClaw");
    addSession("claude-code", "awaiting_option", "epoch-of-tech");
    setStr(g_state.sessions[1].question, sizeof(g_state.sessions[1].question),
           "월간 계획 기준선을 어떻게 조정할까요?");
    g_state.sessions[1].optionCount = 2;
    setStr(g_state.sessions[1].options[0].label,
           sizeof(g_state.sessions[1].options[0].label), "기준선 완화");
    setStr(g_state.sessions[1].options[1].label,
           sizeof(g_state.sessions[1].options[1].label), "변경 되돌리기");
    return true;
  }
  return false;
}

const char* SimScenes::catalog() {
  return "usage-all, zai-only, usage-none, usage-zero, usage-stale, codex-only, codex-luna, live-mix, empty, idle, display-off, working, multi, crowd, crowded, dense, permission, attention, "
         "demo:<agent>:<state>";
}
