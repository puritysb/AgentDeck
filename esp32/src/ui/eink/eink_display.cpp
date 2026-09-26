#ifdef BOARD_EINK_SURFACE

#include "eink_display.h"

#include <Arduino.h>
#include <Adafruit_GFX.h>
#include <esp_heap_caps.h>
#if defined(BOARD_LILYGO_EPD47)
// The LilyGo driver declares its own incompatible GFXfont type, so including
// epd_driver.h beside Adafruit_GFX is impossible. This display backend only
// needs the C panel lifecycle ABI; keep the small, layout-identical surface
// here and let the pinned upstream library compile its implementation.
extern "C" {
struct LilyEpdRect { int32_t x, y, width, height; };
void epd_init();
void epd_poweron();
void epd_poweroff();
void epd_clear();
void epd_clear_area(LilyEpdRect area);
void epd_draw_grayscale_image(LilyEpdRect area, uint8_t* data);
// enum DrawMode_t in the vendor header; BLACK_ON_WHITE = 1<<0, WHITE_ON_WHITE
// = 1<<1. Passing the PREVIOUS frame with WHITE_ON_WHITE drives exactly the
// pixels that were dark back to paper — a targeted erase instead of a clear.
void epd_draw_image(LilyEpdRect area, uint8_t* data, int mode);
}
// GxEPD color constants are not available on the LilyGo parallel driver.
#define GxEPD_BLACK 0x0000
#define GxEPD_WHITE 0xFFFF
#define GxEPD_RED   0xF800
#else
#include <SPI.h>
#if defined(BOARD_NM_EPD_420)
#include <GxEPD2_3C.h>
#else
#include <GxEPD2_BW.h>
#endif
#endif
#include <U8g2_for_Adafruit_GFX.h>
#include <Fonts/FreeSansBold18pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <Fonts/FreeSans9pt7b.h>

#include "config.h"
#include "../boards/board_config.h"
#include "state/agent_state.h"
#include "net/wifi_manager.h"
#include "net/serial_client.h"
#include "net/ws_client.h"
#include "ui/terrarium/creature_glyphs_generated.h"
#include "ui/agent_label.h"
#include "ui/eink/eink_dashboard_layout.h"
#include "ui/eink/epd47_page_policy.h"
#include "ui/eink/epd47_refresh_policy.h"
#include "util/usage_format.h"
#include "util/usage_rows.h"
#include <cctype>
#include "util/utf8.h"
#include "util/memory.h"
#if defined(BOARD_LILYGO_EPD47)
#include "input/touch_strip.h"
#endif

#if defined(BOARD_LILYGO_EPD47) || defined(BOARD_SIM_EPD47)
#define AGENTDECK_EPD47_UI 1
#endif

#if defined(BOARD_NM_EPD_420) || defined(BOARD_SIM_NM)
#define AGENTDECK_NM_UI 1
#endif

#if defined(BOARD_TRMNL_75) && !defined(BOARD_SIM_PULL)
#define AGENTDECK_TRMNL_75_UI 1
#include "ui/eink/paper_aquarium_generated.h"
#endif

namespace {

#if !defined(BOARD_LILYGO_EPD47)
constexpr int8_t PIN_EPD_SCK  = BOARD_PIN_EPD_SCK;
constexpr int8_t PIN_EPD_MOSI = BOARD_PIN_EPD_MOSI;
constexpr int8_t PIN_EPD_CS   = BOARD_PIN_EPD_CS;
constexpr int8_t PIN_EPD_DC   = BOARD_PIN_EPD_DC;
constexpr int8_t PIN_EPD_RST  = BOARD_PIN_EPD_RST;
constexpr int8_t PIN_EPD_BUSY = BOARD_PIN_EPD_BUSY;
#endif
constexpr uint8_t PIN_KEY1    = BOARD_PIN_KEY1;
constexpr uint8_t PIN_KEY2    = BOARD_PIN_KEY2;

#ifndef BOARD_EINK_ROTATION
#define BOARD_EINK_ROTATION 0
#endif
static_assert(BOARD_EINK_ROTATION == 0 || BOARD_EINK_ROTATION == 2,
              "Paper-face renderer currently supports upright or 180-degree panels");

// ===== Refresh policy =====
// Partial refresh (~0.3s) accumulates ghosting on the UC8179; Good Display
// recommends a flashing full refresh roughly every 5 partials. Content-hash
// gating means these only apply on real change.
//
// CRITICAL: the panel is kept in powerOff() (high voltage off, controller RAM
// RETAINED) between refreshes — NEVER hibernate() during normal operation.
// hibernate() deep-sleeps the controller and wipes its previous-frame RAM, so
// the next partial refresh diffs against garbage → faint/ghosted text (the
// "blurry text" bug on first hardware bring-up).
#if defined(BOARD_NM_EPD_420)
// The on-hand GDEY042Z98 glass is not stable with SSD1683 refresh_bw(), even
// inside a red-free window: the B/W waveform eventually lifts black pigment
// across the whole panel. Use only the stock tri-color waveform and treat this
// as a slow ambient surface. Physical-key actions still bypass this gate.
//
// Every admitted repaint is therefore a COMPLETE tri-color cycle — the hardest,
// longest refresh in the fleet, and 100% of this board's repaints are full
// (measured 2026-08-30: 93/93). Spending one to advance an elapsed-time string
// or a percentage by a point is the wrong trade, so the routine floor is an
// ambient cadence. Only link/page transitions and NEW user attention bypass it;
// routine working-count churn is exactly the stream that must be coalesced.
constexpr uint32_t MIN_REFRESH_INTERVAL_MS = 15UL * 60UL * 1000UL;
#elif defined(BOARD_LILYGO_EPD47)
constexpr uint32_t MIN_REFRESH_INTERVAL_MS = 60000;
#else
constexpr uint32_t MIN_REFRESH_INTERVAL_MS = 3000;
#endif
#if defined(BOARD_LILYGO_EPD47)
// The parallel grayscale driver assumes a white surface before every image
// write. AgentDeck retains the previous 4-bit frame in PSRAM and drives that
// ink back to paper before each replacement, then runs a hard anti-ghost sweep
// after four differential erases or ten minutes.
constexpr uint8_t  FULL_EVERY_N_PARTIALS   = 4;
constexpr uint32_t FULL_MAX_AGE_MS         = 10UL * 60UL * 1000UL;
#else
constexpr uint8_t  FULL_EVERY_N_PARTIALS   = 5;
constexpr uint32_t FULL_MAX_AGE_MS         = 10UL * 60UL * 1000UL;
#endif

// 16-level grayscale ink. The EPD47's ED047TC2 is the only panel in the fleet
// that can show more than two levels, and until 2026-08-30 the canvas collapsed
// every colour to pure black or pure white — a 4-bit framebuffer carrying 2 of
// its 16 levels, which is why its frames read as a fax next to the 1-bit
// TRMNL 7.5". Levels are expressed as RGB565 greys and decoded from the 6-bit
// green channel, so the firmware canvas and the host simulator share one
// decode and no per-backend colour table can drift.
constexpr uint16_t einkGray(uint8_t level) {   // 0 = black ink … 15 = paper
    return (uint16_t)(((uint16_t)(level * 2) << 11) |
                      ((uint16_t)(level * 4) << 5) |
                      (uint16_t)(level * 2));
}
constexpr uint8_t einkInkLevel(uint16_t color) {
    return (uint8_t)(((color >> 5) & 0x3F) >> 2);
}
#if defined(AGENTDECK_EPD47_UI)
constexpr uint16_t EINK_INK_BODY  = einkGray(4);    // secondary sentences
constexpr uint16_t EINK_INK_MUTED = einkGray(7);    // captions, units, counts
constexpr uint16_t EINK_INK_RULE  = einkGray(10);   // hairlines, dividers
constexpr uint16_t EINK_INK_TINT  = einkGray(13);   // zebra fills, gauge tracks
#else
// The 1-bit TRMNL 7.5" glass and the tri-color NM glass have no intermediate
// levels, and GxEPD2 maps EVERY non-white colour to solid ink — so handing a
// grey to a shared helper does not degrade gracefully, it paints the shape
// solid black. drawMiniUsage() is exactly such a helper (EPD47 QUEUE + FOCUS
// and the NM glance all call it), so the collapse happens HERE, at the source,
// rather than being left to each backend. The host simulator quantises too, but
// that is a second net: relying on it alone is how a preview shows a clean
// gauge while the panel prints a black bar.
constexpr uint16_t EINK_INK_BODY  = GxEPD_BLACK;
constexpr uint16_t EINK_INK_MUTED = GxEPD_BLACK;
constexpr uint16_t EINK_INK_RULE  = GxEPD_BLACK;
constexpr uint16_t EINK_INK_TINT  = GxEPD_WHITE;    // a tint is bare paper here
#endif

// Zero-cost gates for the two properties this ink set has to hold. The first
// pins the shared decode: the firmware canvas and the host simulator both read
// the 6-bit green channel, and a divergence there means the preview stops being
// evidence. The second pins the collapse above — an intermediate level reaching
// a 1-bit or tri-color panel is not a subtle rendering difference, it is a solid
// black shape where a hairline or an empty gauge track was intended.
static_assert(einkInkLevel(GxEPD_WHITE) == 15 && einkInkLevel(GxEPD_BLACK) == 0 &&
                  einkInkLevel(einkGray(4)) == 4 && einkInkLevel(einkGray(11)) == 11,
              "grey encode/decode must round-trip");
#if !defined(AGENTDECK_EPD47_UI)
static_assert(EINK_INK_BODY == GxEPD_BLACK && EINK_INK_MUTED == GxEPD_BLACK &&
                  EINK_INK_RULE == GxEPD_BLACK && EINK_INK_TINT == GxEPD_WHITE,
              "panels without grey must collapse the ink set at the source");
#endif

#if defined(BOARD_LILYGO_EPD47)
class LilyEpdCanvas final : public Adafruit_GFX {
public:
    LilyEpdCanvas() : Adafruit_GFX(SCREEN_W, SCREEN_H), pixels_(nullptr) {}

    bool begin() {
        constexpr size_t FRAME_BYTES = (size_t)SCREEN_W * SCREEN_H / 2;
        // Device-lifetime owner. A 259,200-byte 4-bit framebuffer cannot live
        // on the task stack; allocate once in PSRAM and reuse every render.
        pixels_ = static_cast<uint8_t*>(heap_caps_calloc(
            FRAME_BYTES, 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        if (!pixels_) {
            Serial.printf("[Eink] LilyGo framebuffer alloc failed (%u bytes)\n",
                          (unsigned)FRAME_BYTES);
            return false;
        }
        memset(pixels_, 0xFF, FRAME_BYTES);
        // Second frame: what is physically on the glass. A page swap used to
        // cost a whole-panel epd_clear(), which on this driver is several full
        // black/white inversions — one tap read as a storm of flashes. With the
        // previous frame retained, the old ink can be erased where it actually
        // is. Optional: if PSRAM cannot spare it the surface degrades to the
        // clearing path rather than failing.
        prev_ = static_cast<uint8_t*>(heap_caps_calloc(
            FRAME_BYTES, 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        if (prev_) memset(prev_, 0xFF, FRAME_BYTES);
        else Serial.println("[Eink] no PSRAM for the previous frame — page "
                            "changes will keep using a full clear");
        logHeap("lily-epd-framebuffer");
        return true;
    }

    void drawPixel(int16_t x, int16_t y, uint16_t color) override {
        if (!pixels_ || x < 0 || y < 0 || x >= SCREEN_W || y >= SCREEN_H) return;
        int16_t px = x;
        int16_t py = y;
        if (getRotation() == 2) {
            px = (int16_t)(SCREEN_W - 1 - x);
            py = (int16_t)(SCREEN_H - 1 - y);
        }
        const size_t i = ((size_t)py * SCREEN_W + (size_t)px) / 2;
        const uint8_t shade = einkInkLevel(color);
        if (px & 1) pixels_[i] = (uint8_t)((pixels_[i] & 0x0F) | (shade << 4));
        else       pixels_[i] = (uint8_t)((pixels_[i] & 0xF0) | shade);
    }

    void fillScreen(uint16_t color) override {
        const uint8_t lv = einkInkLevel(color);
        if (pixels_) memset(pixels_, (uint8_t)((lv << 4) | lv),
                            (size_t)SCREEN_W * SCREEN_H / 2);
    }

    uint8_t* pixels() { return pixels_; }
    uint8_t* prev() { return prev_; }
    void retainFrame() {
        if (pixels_ && prev_)
            memcpy(prev_, pixels_, (size_t)SCREEN_W * SCREEN_H / 2);
    }
    // After a real clear the glass is uniformly white, so the retained frame
    // must say so or the next erase pass would chase ink that is already gone.
    void forgetFrame() {
        if (prev_) memset(prev_, 0xFF, (size_t)SCREEN_W * SCREEN_H / 2);
    }

private:
    uint8_t* pixels_;  // owned for device lifetime; intentionally never freed
    uint8_t* prev_ = nullptr;
};

LilyEpdCanvas display;
#elif defined(BOARD_NM_EPD_420)
using Panel = GxEPD2_420c_GDEY042Z98;
GxEPD2_3C<Panel, Panel::HEIGHT> display(
    Panel(PIN_EPD_CS, PIN_EPD_DC, PIN_EPD_RST, PIN_EPD_BUSY));
#else
using Panel = GxEPD2_750_GDEY075T7;
GxEPD2_BW<Panel, Panel::HEIGHT> display(Panel(PIN_EPD_CS, PIN_EPD_DC, PIN_EPD_RST, PIN_EPD_BUSY));
#endif
// UTF-8/한글 renderer for dynamic text (project names, prompts, activity,
// ticker). GFX FreeFonts are Latin-only — Korean previously degraded to
// "######?" garbage via the ASCII sanitizer.
U8G2_FOR_ADAFRUIT_GFX u8f;

constexpr int16_t W = SCREEN_W, H = SCREEN_H;

// ===== Render snapshot (copied out of g_state under the mutex so the slow
// e-ink refresh never holds the lock) =====
constexpr uint8_t MAX_ROWS = 10;   // matches the sessions_list cap

struct RowSnap {
    char id[32];
    char name[40];
    char agentType[16];
    char state[20];
    char tool[40];
    char model[32];
    char question[120];
    char activity[80];
    // TIMELINE-grade work summary for the card detail ("HH:MM · task · text"):
    // the daemon-computed latest milestone (chat/task row), NOT the live tool
    // one-liner — mid-turn "Running cd …" churn is state-line material, the
    // detail line carries what the agent actually asked/answered/finished.
    char work[152];
    bool alive;
    uint8_t subagentCount;
};

struct Snap {
    bool bridgeConnected;
    bool wifiUp;
    bool serialUp;
    uint8_t rowCount;
    uint8_t totalSessions;
    RowSnap rows[MAX_ROWS];
    // Focused-session options (global — shown on the first awaiting card)
    uint8_t optionCount;
    char options[3][36];
    // Usage
    float fiveH, sevenD;
    char fiveReset[20], sevenReset[20];
    bool usageStale;
    float codexP, codexS;
    char codexPReset[20], codexSReset[20];
    // z.ai GLM Coding Plan (#350) — secondary labeled "MCP" when it meters
    // tool calls (zaiIsMcp), never a window length.
    float zaiP, zaiS;
    char zaiPReset[20], zaiSReset[20];
    bool zaiIsMcp;
    char zaiPlan[40];
    // Subscription plan lines per provider ("Max 20x ~7/12"), '' = hide
    char claudePlan[40];
    char codexPlan[40];
    char agPlan[40];   // pre-shortened "AGY Pro ~8/1" chip text
    // Provider-grouped usage (shared UsageRows rules: z.ai MCP, the Codex
    // Luna reserve, per-provider plan tier/until). The dashboard band and the
    // EPD47/NM usage columns render from this.
    UsageRows::Group usage[UsageRows::MAX_GROUPS];
    uint8_t usageCount;
    char ip[16];
    // Recent-work strip: latest milestone timeline events, newest first.
    // EXCLUDED from the content hash — the strip earns its own redraw at most
    // once a minute (piggybacks otherwise) so tool-event churn can't strobe
    // the e-ink. Was a single ticker line; widened to a multi-row strip
    // because one line carried too little information at glance distance.
    static constexpr uint8_t TICKER_ROWS = 3;
    uint8_t tickerCount;
    char tickerTime[TICKER_ROWS][8];
    char tickerText[TICKER_ROWS][104];
};

void snapshot(Snap& s) {
    memset(&s, 0, sizeof(s));
    s.wifiUp = Net::wifiConnected();
    s.serialUp = Net::serialConnected();
    lockState();
    s.bridgeConnected = g_state.wsConnected;
    s.totalSessions = g_state.sessionCount;
    s.rowCount = g_state.sessionCount < MAX_ROWS ? g_state.sessionCount : MAX_ROWS;
    for (uint8_t i = 0; i < s.rowCount; i++) {
        const SessionInfo& src = g_state.sessions[i];
        RowSnap& dst = s.rows[i];
        strncpy(dst.id, src.id, sizeof(dst.id) - 1);
        strncpy(dst.name, src.projectName, sizeof(dst.name) - 1);
        strncpy(dst.agentType, src.agentType, sizeof(dst.agentType) - 1);
        strncpy(dst.state, src.state, sizeof(dst.state) - 1);
        strncpy(dst.tool, src.currentTool, sizeof(dst.tool) - 1);
        strncpy(dst.model, src.modelName, sizeof(dst.model) - 1);
        strncpy(dst.question, src.question, sizeof(dst.question) - 1);
        strncpy(dst.activity, src.activity, sizeof(dst.activity) - 1);
        dst.alive = src.alive;
        dst.subagentCount = g_state.activeSubagentsForSession(src.id);
        // TIMELINE-grade work summary for the card detail: prefer the
        // daemon-computed latest milestone (authoritative store — survives
        // board reboots), composed as "HH:MM · task · text". Fall back to the
        // on-device timeline ring (empty after every reboot) for old daemons.
        // Bounded scan (timelineCount ≤ TIMELINE_MAX_ENTRIES) already under lock.
        if (src.lastEventText[0]) {
            size_t off = 0;
            auto append = [&](const char* part) {
                if (!part || !part[0] || off >= sizeof(dst.work) - 1) return;
                if (off > 0) {
                    int n = snprintf(dst.work + off, sizeof(dst.work) - off, " \xC2\xB7 "); // " · "
                    if (n > 0) off += (size_t)n;
                    if (off >= sizeof(dst.work)) { off = sizeof(dst.work) - 1; return; }
                }
                int n = snprintf(dst.work + off, sizeof(dst.work) - off, "%s", part);
                if (n > 0) off += (size_t)n;
                if (off >= sizeof(dst.work)) off = sizeof(dst.work) - 1;
            };
            append(src.lastEventHm);
            append(src.lastEventTask);
            append(src.lastEventText);
            // A multibyte truncation can leave a split UTF-8 char at the end.
            dst.work[Utf8::utf8Boundary(dst.work, strlen(dst.work))] = '\0';
        } else {
            for (uint8_t back = 0; back < g_state.timelineCount; back++) {
                uint8_t ti = (uint8_t)((g_state.timelineHead + g_state.timelineCount - 1 - back) % TIMELINE_MAX_ENTRIES);
                const TimelineEntry& te = g_state.timeline[ti];
                if (strcmp(te.sessionId, src.id) != 0) continue;
                if (!te.raw[0] || te.raw[0] == '{' || te.raw[0] == '[') continue;
                // Turn rows only — task_start/task_end are data-only hierarchy
                // markers (one-row-per-task contract, shared/src/
                // timeline-task-display.ts): a reaper-synthesized
                // "Interrupted · ~6h" must never surface as a session's work line.
                bool milestone = strcmp(te.type, "chat_response") == 0 || strcmp(te.type, "chat_end") == 0 ||
                                 strcmp(te.type, "chat_start") == 0;
                if (!milestone) continue;
                strncpy(dst.work, te.raw, sizeof(dst.work) - 1);
                dst.work[sizeof(dst.work) - 1] = '\0';
                break;
            }
        }
    }
    s.optionCount = g_state.optionCount < 3 ? g_state.optionCount : 3;
    for (uint8_t i = 0; i < s.optionCount; i++)
        strncpy(s.options[i], g_state.options[i].label, sizeof(s.options[i]) - 1);
    s.fiveH = g_state.fiveHourPercent;
    s.sevenD = g_state.sevenDayPercent;
    strncpy(s.fiveReset, g_state.fiveHourReset, sizeof(s.fiveReset) - 1);
    strncpy(s.sevenReset, g_state.sevenDayReset, sizeof(s.sevenReset) - 1);
    s.usageStale = g_state.usageStale;
    s.codexP = g_state.codexPrimaryPercent;
    s.codexS = g_state.codexSecondaryPercent;
    strncpy(s.codexPReset, g_state.codexPrimaryReset, sizeof(s.codexPReset) - 1);
    strncpy(s.codexSReset, g_state.codexSecondaryReset, sizeof(s.codexSReset) - 1);
    s.zaiP = g_state.zaiPrimaryPercent;
    s.zaiS = g_state.zaiSecondaryPercent;
    s.zaiIsMcp = g_state.zaiSecondaryIsMcp;
    strncpy(s.zaiPReset, g_state.zaiPrimaryReset, sizeof(s.zaiPReset) - 1);
    strncpy(s.zaiSReset, g_state.zaiSecondaryReset, sizeof(s.zaiSReset) - 1);
    // Map subscriptions[] to provider rows by name; unmatched → AGY chip.
    // (Antigravity credits are deliberately NOT surfaced — the raw count is
    // meaningless to glance at; only the plan/expiry chip remains.)
    for (uint8_t i = 0; i < g_state.subscriptionCount; i++) {
        const auto& sub = g_state.subscriptions[i];
        char line[40];
        if (sub.until[0]) snprintf(line, sizeof(line), "%s %s", sub.name, sub.until);
        else { strncpy(line, sub.name, sizeof(line) - 1); line[sizeof(line) - 1] = '\0'; }
        if (UsageFormat::isAntigravityPlanName(sub.name)) {
            // The daemon stores the Antigravity subscription under its raw plan
            // name ("Google AI Pro"), not a literal "Antigravity …" string —
            // route it to the AGY chip and shorten to "AGY Pro (~M/D)".
            char agy[24];
            UsageFormat::formatAgyPlan(sub.name, agy, sizeof(agy));
            if (sub.until[0]) snprintf(s.agPlan, sizeof(s.agPlan), "%s %s", agy, sub.until);
            else { strncpy(s.agPlan, agy, sizeof(s.agPlan) - 1); s.agPlan[sizeof(s.agPlan) - 1] = '\0'; }
        } else if (strncmp(sub.name, "Claude", 6) == 0) {
            // drop the redundant "Claude " prefix under the CLAUDE label
            const char* tail = line + 6; while (*tail == ' ') tail++;
            strncpy(s.claudePlan, tail, sizeof(s.claudePlan) - 1);
        } else if (strncmp(sub.name, "ChatGPT", 7) == 0 || strncmp(sub.name, "Codex", 5) == 0) {
            const char* tail = line + (sub.name[1] == 'h' ? 7 : 5); while (*tail == ' ') tail++;
            strncpy(s.codexPlan, tail, sizeof(s.codexPlan) - 1);
        } else if (strncmp(sub.name, "GLM", 3) == 0) {
            // z.ai row plan ("GLM Coding Plan · Max  ~9/28") — never the AGY chip.
            strncpy(s.zaiPlan, line, sizeof(s.zaiPlan) - 1);
        } else {
            strncpy(s.agPlan, line, sizeof(s.agPlan) - 1);
        }
    }
    // Plan-name-only fallback when the daemon exposes antigravityStatus but
    // no subscriptions[] entry for it.
    if (!s.agPlan[0] && g_state.antigravityPlan[0]) {
        UsageFormat::formatAgyPlan(g_state.antigravityPlan, s.agPlan, sizeof(s.agPlan));
    }
    s.usageCount = UsageRows::build(g_state, s.usage);
    // Latest MILESTONE timeline entries → recent-work strip (newest first).
    // Only turn/task-level rows qualify (chat_start/chat_response/chat_end/
    // task_start/task_end): per-tool rows from managed PTY sessions
    // ("Bash: cd /Users/…") are command spam at glance distance, and raw JSON
    // bodies ({"exclude":[]}) are machine noise (still guarded by the '{'/'['
    // skip below). chat_response is the turn's RESULT — since the chat_end
    // dedup, turns with a response emit chat_response INSTEAD of chat_end, so
    // without it the strip forever showed the ask but never the answer.
    // Prefer the daemon-preformatted local "HH:MM"; ts fallback is UTC-derived.
    for (uint8_t back = 0; back < g_state.timelineCount && s.tickerCount < Snap::TICKER_ROWS; back++) {
        uint8_t idx = (uint8_t)((g_state.timelineHead + g_state.timelineCount - 1 - back) % TIMELINE_MAX_ENTRIES);
        const TimelineEntry& t = g_state.timeline[idx];
        if (!t.raw[0] || t.raw[0] == '{' || t.raw[0] == '[') continue;
        // Turn rows only (see the one-row-per-task note above); task_start
        // labels are still resolved below as the turn's task CONTEXT chip.
        bool milestone = strcmp(t.type, "chat_response") == 0;
        if (!milestone) continue;
        uint8_t row = s.tickerCount;
        if (t.hm[0]) {
            strncpy(s.tickerTime[row], t.hm, sizeof(s.tickerTime[row]) - 1);
        } else {
            snprintf(s.tickerTime[row], sizeof(s.tickerTime[row]), "%02lu:%02lu",
                     (unsigned long)(t.ts / 3600) % 24, (unsigned long)(t.ts / 60) % 60);
        }
        // Compose an explicitly-attributed single line "<agent> · <project> ·
        // <task> · <text>". Parts are dropped when absent; the drawer
        // (smartFitText below) shrinks to the ~700px line. For a turn row
        // (chat_start/tool) inside a task, resolve its taskId to the task
        // header's label so "which task" is present alongside the prompt text.
        {
            char comp[104];
            comp[0] = '\0';
            size_t off = 0;
            auto appendPart = [&](const char* part) {
                if (!part || !part[0] || off >= sizeof(comp) - 1) return;
                if (off > 0) {
                    int n = snprintf(comp + off, sizeof(comp) - off, " \xC2\xB7 "); // " · " UTF-8
                    if (n > 0) off += (size_t)n;
                    if (off >= sizeof(comp)) { off = sizeof(comp) - 1; return; }
                }
                int n = snprintf(comp + off, sizeof(comp) - off, "%s", part);
                if (n > 0) off += (size_t)n;
                if (off >= sizeof(comp)) off = sizeof(comp) - 1;
            };
            appendPart(t.agentType[0] ? agentDisplayLabel(t.agentType) : nullptr);
            appendPart(t.projectName[0] ? t.projectName : nullptr);
            if (t.taskId[0]) {  // rows here are always turn rows (task rows excluded above)
                for (uint8_t j = 0; j < g_state.timelineCount; j++) {
                    const TimelineEntry& tj =
                        g_state.timeline[(g_state.timelineHead + j) % TIMELINE_MAX_ENTRIES];
                    if (strcmp(tj.type, "task_start") == 0 && strcmp(tj.taskId, t.taskId) == 0) {
                        appendPart(tj.raw);
                        break;
                    }
                }
            }
            appendPart(t.raw);
            strncpy(s.tickerText[row], comp[0] ? comp : t.raw, sizeof(s.tickerText[row]) - 1);
        }
        s.tickerCount++;
    }
    unlockState();
    strncpy(s.ip, Net::wifiLocalIP(), sizeof(s.ip) - 1);
}

// FNV-1a over the fields that affect pixels. elapsedSec is bucketed to minutes
// so a ticking counter doesn't force a refresh every poll.
uint32_t fnv(uint32_t h, const void* data, size_t len) {
    const uint8_t* p = (const uint8_t*)data;
    for (size_t i = 0; i < len; i++) { h ^= p[i]; h *= 16777619u; }
    return h;
}
uint32_t fnvStr(uint32_t h, const char* s) { return fnv(h, s, strlen(s) + 1); }
// Usage groups at integer resolution — float jitter never costs a refresh.
// `withResets=false` keeps countdown churn out of the calm faces.
uint32_t hashUsage(uint32_t h, const Snap& s, bool withResets) {
    h = fnv(h, &s.usageCount, sizeof(s.usageCount));
    for (uint8_t i = 0; i < s.usageCount; i++) {
        const auto& g = s.usage[i];
        h = fnv(h, &g.provider, sizeof(g.provider));
        h = fnv(h, &g.rowCount, sizeof(g.rowCount));
        h = fnvStr(h, g.tier); h = fnvStr(h, g.until);
        for (uint8_t r = 0; r < g.rowCount; r++) {
            const int shown = g.rows[r].shown();
            h = fnvStr(h, g.rows[r].label);
            h = fnv(h, &shown, sizeof(shown));
            if (withResets) h = fnvStr(h, g.rows[r].reset);
        }
    }
    return h;
}

uint32_t contentHash(const Snap& s) {
    uint32_t h = 2166136261u;
    h = fnv(h, &s.bridgeConnected, 1);
    h = fnv(h, &s.wifiUp, 1);
    h = fnv(h, &s.serialUp, 1);
    h = fnv(h, &s.rowCount, 1);
    h = fnv(h, &s.totalSessions, 1);
    for (uint8_t i = 0; i < s.rowCount; i++) {
        const RowSnap& r = s.rows[i];
        h = fnvStr(h, r.name); h = fnvStr(h, r.agentType); h = fnvStr(h, r.state);
        h = fnvStr(h, r.tool); h = fnvStr(h, r.model); h = fnvStr(h, r.question);
        h = fnvStr(h, r.activity); h = fnvStr(h, r.work);
        h = fnv(h, &r.alive, 1);
        h = fnv(h, &r.subagentCount, 1);
    }
    h = fnv(h, &s.optionCount, 1);
    for (uint8_t i = 0; i < s.optionCount; i++) h = fnvStr(h, s.options[i]);
    int fh = (int)s.fiveH, sd = (int)s.sevenD, cp = (int)s.codexP, cs = (int)s.codexS;
    int zp = (int)s.zaiP, zs = (int)s.zaiS;
    h = fnv(h, &fh, sizeof(fh)); h = fnv(h, &sd, sizeof(sd));
    h = fnv(h, &cp, sizeof(cp)); h = fnv(h, &cs, sizeof(cs));
    h = fnv(h, &zp, sizeof(zp)); h = fnv(h, &zs, sizeof(zs));
    h = fnvStr(h, s.fiveReset); h = fnvStr(h, s.sevenReset);
    h = fnvStr(h, s.codexPReset); h = fnvStr(h, s.codexSReset);
    h = fnvStr(h, s.zaiPReset); h = fnvStr(h, s.zaiSReset);
    h = fnv(h, &s.zaiIsMcp, 1);
    h = fnvStr(h, s.claudePlan); h = fnvStr(h, s.codexPlan); h = fnvStr(h, s.agPlan);
    h = fnvStr(h, s.zaiPlan);
    h = hashUsage(h, s, true);
    h = fnv(h, &s.usageStale, 1);
    h = fnvStr(h, s.ip);
    // NOTE: ticker row TEXT intentionally NOT hashed — see Snap. The row
    // COUNT is hashed: it moves the grid/strip split (layout), and it only
    // changes a couple of times after boot, so it can't strobe the panel.
    h = fnv(h, &s.tickerCount, 1);
    return h;
}

// ===== Draw helpers =====

// GFX FreeFonts are Latin-1; drop anything outside printable ASCII so multibyte
// project names degrade to a single marker instead of tofu garbage.
void ascii(char* out, size_t outLen, const char* in) {
    size_t o = 0;
    bool lastSub = false;
    for (size_t i = 0; in[i] && o < outLen - 1; i++) {
        uint8_t c = (uint8_t)in[i];
        if (c >= 32 && c < 127) { out[o++] = (char)c; lastSub = false; }
        else if (!lastSub) { out[o++] = '#'; lastSub = true; }  // one '#' per non-ASCII run
    }
    out[o] = '\0';
}

uint16_t inkColor = GxEPD_BLACK;
uint16_t paperColor = GxEPD_WHITE;
void setInk(bool inverted) {
    inkColor = inverted ? GxEPD_WHITE : GxEPD_BLACK;
    paperColor = inverted ? GxEPD_BLACK : GxEPD_WHITE;
    display.setTextColor(inkColor);
}

// Draw the next text run in a specific grey level and restore the previous ink
// on scope exit. uFontSetup() already reads inkColor, so the GFX and the U8g2
// (Korean) paths follow this without a second colour argument threaded through
// every text helper.
struct InkScope {
    uint16_t prev;
    explicit InkScope(uint16_t c) : prev(inkColor) {
        inkColor = c;
        display.setTextColor(c);
    }
    ~InkScope() {
        inkColor = prev;
        display.setTextColor(prev);
    }
};

// Sentinel for the classic built-in 6×8 GFX font (setFont(nullptr) mode) —
// a distinct pointer so cascade args can still use nullptr for "not given".
const GFXfont* const CLASSIC_FONT = (const GFXfont*)(uintptr_t)1;

// CLASSIC_FONT draws from its top-left; the baseline `y` is shifted so call
// sites stay uniform across fonts.
void textAt(int16_t x, int16_t y, const char* s, const GFXfont* f) {
    if (f == CLASSIC_FONT) { display.setFont(nullptr); display.setTextSize(1); display.setCursor(x, y - 7); }
    else { display.setFont(f); display.setCursor(x, y); }
    display.print(s);
}

int16_t textWidth(const char* s, const GFXfont* f) {
    int16_t x1, y1; uint16_t w, h;
    if (f == CLASSIC_FONT) { display.setFont(nullptr); display.setTextSize(1); }
    else display.setFont(f);
    display.getTextBounds(s, 0, 0, &x1, &y1, &w, &h);
    return (int16_t)w;
}

void textRight(int16_t xRight, int16_t y, const char* s, const GFXfont* f) {
    textAt(xRight - textWidth(s, f), y, s, f);
}

// Truncate `s` (already ASCII) to fit `maxW` with the given font, appending
// ".." when cut. Result in `out`.
void fitText(char* out, size_t outLen, const char* s, int16_t maxW, const GFXfont* f) {
    strncpy(out, s, outLen - 1); out[outLen - 1] = '\0';
    if (textWidth(out, f) <= maxW) return;
    size_t len = strlen(out);
    while (len > 1) {
        out[--len] = '\0';
        out[len - 1 >= 0 ? len : 0] = '\0';
        char probe[96];
        snprintf(probe, sizeof(probe), "%s..", out);
        if (textWidth(probe, f) <= maxW) { strncpy(out, probe, outLen - 1); out[outLen - 1] = '\0'; return; }
    }
}

// ===== UTF-8 / 한글 text path =====
// ASCII text keeps the crisp GFX FreeFonts; anything with multibyte chars
// (Korean project names / prompts / activity summaries) renders through the
// u8g2 unifont Korean set instead of degrading to '#' runs.

bool isAsciiOnly(const char* s) {
    for (; *s; s++) if ((uint8_t)*s >= 128) return false;
    return true;
}

// Back off `n` to a UTF-8 character boundary (never split a 한글 glyph).
// SSOT: util/utf8.h (shared with protocol ingestion + the IPS10 cards).
size_t utf8Boundary(const char* s, size_t n) { return Utf8::utf8Boundary(s, n); }
size_t utf8CharCount(const char* s) { return Utf8::utf8CharCount(s); }

void uFontSetup() {
    u8f.setFont(u8g2_font_unifont_t_korean2);
    u8f.setFontMode(1);  // transparent background
    u8f.setForegroundColor(inkColor);
}

int16_t smartWidth(const char* s, const GFXfont* f) {
    if (isAsciiOnly(s)) return textWidth(s, f);
    uFontSetup();
    return (int16_t)u8f.getUTF8Width(s);
}

void smartTextAt(int16_t x, int16_t y, const char* s, const GFXfont* f) {
    if (isAsciiOnly(s)) { textAt(x, y, s, f); return; }
    uFontSetup();
    u8f.setCursor(x, y);
    u8f.print(s);
}

// Fit-with-ellipsis that is UTF-8 safe and font-smart.
void smartFitText(char* out, size_t outLen, const char* s, int16_t maxW, const GFXfont* f) {
    if (outLen == 0) return;
    strncpy(out, s, outLen - 1); out[outLen - 1] = '\0';
    Utf8::singleLine(out);
    if (smartWidth(out, f) <= maxW) return;
    size_t len = strlen(out);
    while (len > 1) {
        len = utf8Boundary(out, len - 1);
        out[len] = '\0';
        char probe[120];
        snprintf(probe, sizeof(probe), "%s..", out);
        if (smartWidth(probe, f) <= maxW) {
            strncpy(out, probe, outLen - 1); out[outLen - 1] = '\0';
            return;
        }
    }
}

// Greedy 2-line wrap in a SINGLE font (mixed sizes across the two lines read
// as a glitch on paper). Line 1 breaks at the last space that fits — falling
// back to a mid-word hard break only when one word alone exceeds the width
// (the old space-only backoff shrank "Hello-world-… is" to a one-letter first
// line). Line 2 ellipsizes as the last resort.
void drawWrapped2(int16_t x, int16_t y1, int16_t y2, int16_t maxW,
                  const char* text, const GFXfont* f) {
    if (smartWidth(text, f) <= maxW) { smartTextAt(x, y1, text, f); return; }
    size_t len = strlen(text);
    char probe[160];
    size_t take = len < sizeof(probe) - 1 ? len : utf8Boundary(text, sizeof(probe) - 1);
    while (take > 1) {
        take = utf8Boundary(text, take);
        strncpy(probe, text, take); probe[take] = '\0';
        if (smartWidth(probe, f) <= maxW) break;
        take--;
    }
    size_t brk = take;
    if (take < len) {
        size_t sp = take;
        while (sp > 0 && text[sp] != ' ') sp--;
        if (sp > take / 2) brk = sp;  // word boundary, but never a near-empty line 1
    }
    strncpy(probe, text, brk); probe[brk] = '\0';
    smartTextAt(x, y1, probe, f);
    const char* rest = text + brk;
    while (*rest == ' ') rest++;
    if (*rest) {
        char l2[160];
        smartFitText(l2, sizeof(l2), rest, maxW, f);
        smartTextAt(x, y2, l2, f);
    }
}

// Font cascade: prefer `pref`, drop to `smaller` (then `smallest`) instead of
// ellipsizing — truncation is the last resort at the smallest size only.
const GFXfont* fitCascade(char* out, size_t outLen, const char* s, int16_t maxW,
                          const GFXfont* pref, const GFXfont* smaller,
                          const GFXfont* smallest = nullptr) {
    if (textWidth(s, pref) <= maxW) { strncpy(out, s, outLen - 1); out[outLen - 1] = '\0'; return pref; }
    if (smaller && textWidth(s, smaller) <= maxW) { strncpy(out, s, outLen - 1); out[outLen - 1] = '\0'; return smaller; }
    if (smallest && textWidth(s, smallest) <= maxW) { strncpy(out, s, outLen - 1); out[outLen - 1] = '\0'; return smallest; }
    const GFXfont* f = smallest ? smallest : (smaller ? smaller : pref);
    fitText(out, outLen, s, maxW, f);
    return f;
}

// ===== AgentDeck product mark — aquarium dome over a button deck =====
// Geometry mirrors apple/AgentDeck/UI/MenuBar/AgentDeckLogo.swift (unit space
// 0..24) — the canonical current mark shared by the menubar icon and app
// icon silhouette. The old AD-shield mark is retired everywhere; do not
// resurrect it here.

void stampAt(float x, float y, int r) {
    if (r <= 0) display.drawPixel((int)(x + 0.5f), (int)(y + 0.5f), inkColor);
    else display.fillCircle((int)(x + 0.5f), (int)(y + 0.5f), r, inkColor);
}

void strokeBezier(float x0, float y0, float cx1, float cy1,
                  float cx2, float cy2, float x1, float y1, int r) {
    const int STEPS = 28;
    for (int i = 0; i <= STEPS; i++) {
        float t = (float)i / STEPS, u = 1.0f - t;
        float bx = u*u*u*x0 + 3*u*u*t*cx1 + 3*u*t*t*cx2 + t*t*t*x1;
        float by = u*u*u*y0 + 3*u*u*t*cy1 + 3*u*t*t*cy2 + t*t*t*y1;
        stampAt(bx, by, r);
    }
}

void drawAgentDeckMark(int16_t x, int16_t y, int size) {
    float s = size / 24.0f;
    int stroke = max(1, (int)(0.8f * s));
    // Glass dome
    strokeBezier(x + 4.7f*s, y + 12.8f*s, x + 5.3f*s, y + 4.9f*s,
                 x + 18.7f*s, y + 4.9f*s, x + 19.3f*s, y + 12.8f*s, stroke);
    // Waterline (thinner)
    strokeBezier(x + 6.1f*s, y + 11.2f*s, x + 8.8f*s, y + 12.5f*s,
                 x + 15.2f*s, y + 12.5f*s, x + 17.9f*s, y + 11.2f*s,
                 max(1, (int)(0.5f * s)));
    // Bubbles (position = center in the Swift source)
    display.fillCircle(x + (int)(9.6f*s), y + (int)(9.0f*s), max(1, (int)(0.95f*s)), inkColor);
    display.fillCircle(x + (int)(14.8f*s), y + (int)(8.2f*s), max(1, (int)(0.6f*s)), inkColor);
    // Deck base — rounded-rect stroke (thickness via inset passes)
    int dx = x + (int)(3.4f*s), dy = y + (int)(12.2f*s);
    int dw = (int)(17.2f*s), dh = (int)(7.8f*s), rr = max(2, (int)(2.2f*s));
    int passes = max(1, (int)(1.2f * s + 0.5f) / 2 + 1);
    for (int t = 0; t < passes; t++)
        display.drawRoundRect(dx + t, dy + t, dw - 2*t, dh - 2*t, max(1, rr - t), inkColor);
    // Three deck keys — middle emphasized (filled), outers hollow, echoing
    // the menubar mark's opacity accents
    int kw = max(2, (int)(3.1f*s)), kh = max(2, (int)(2.0f*s)), kr = max(1, (int)(1.0f*s));
    int ky = y + (int)(15.4f*s);
    display.drawRoundRect(x + (int)(6.5f*s), ky, kw, kh, kr, inkColor);
    display.fillRoundRect(x + (int)(10.4f*s), ky, kw, kh, kr, inkColor);
    display.drawRoundRect(x + (int)(14.3f*s), ky, kw, kh, kr, inkColor);
}

// Threshold-scale a 64×64 A8 mask into a silhouette in the current ink color.
void drawMask64(int16_t x, int16_t y, const uint8_t* a8, int size) {
    for (int oy = 0; oy < size; oy++) {
        const uint8_t* row = a8 + (oy * 64 / size) * 64;
        for (int ox = 0; ox < size; ox++) {
            if (row[ox * 64 / size] >= 128) display.drawPixel(x + ox, y + oy, inkColor);
        }
    }
}

// Agent creature glyph. OpenClaw uses the full canonical brand mark, with the
// two eye centers punched back to paper as the documented 1-bit readability reduction.
void drawAgentGlyph(const char* agentType, int16_t x, int16_t y, int size) {
    const uint8_t* a8 = CreatureGlyphs::OCTOPUS_A8;  // claude-code + default
    bool openclaw = false;
    if (strcmp(agentType, "openclaw") == 0)         { a8 = CreatureGlyphs::OPENCLAW_MARK_A8; openclaw = true; }
    else if (strncmp(agentType, "codex", 5) == 0)   a8 = CreatureGlyphs::CODEX_A8;
    else if (strcmp(agentType, "opencode") == 0)    a8 = CreatureGlyphs::OPENCODE_A8;
    else if (strcmp(agentType, "antigravity") == 0) a8 = CreatureGlyphs::ANTIGRAVITY_A8;
    else if (strncmp(agentType, "kiro", 4) == 0)    a8 = CreatureGlyphs::KIRO_A8;
    else if (strcmp(agentType, "zai") == 0)         a8 = CreatureGlyphs::ZAI_A8;
    drawMask64(x, y, a8, size);
    if (openclaw) {
        // Eye pupils at viewBox-24 (8.835, 7.843) / (15.165, 7.843), r≈1.26 —
        // same geometry as shared agentGlyphMono's paper cutouts.
        float sc = size / 24.0f;
        int r = max(1, (int)(1.26f * sc));
        display.fillCircle(x + (int)(8.835f * sc), y + (int)(7.843f * sc), r, paperColor);
        display.fillCircle(x + (int)(15.165f * sc), y + (int)(7.843f * sc), r, paperColor);
    }
}

bool isAwaiting(const char* state) {
    return AgentDeckEink::classifyStatus(state) == AgentDeckEink::StatusKind::Attention;
}

void stateLabel(const char* state, char* out, size_t outLen) {
    if (strcmp(state, "processing") == 0) strncpy(out, "PROCESSING", outLen - 1);
    else if (strcmp(state, "awaiting_permission") == 0) strncpy(out, "PERMISSION", outLen - 1);
    else if (strcmp(state, "awaiting_option") == 0) strncpy(out, "CHOOSE", outLen - 1);
    else if (strcmp(state, "awaiting_diff") == 0) strncpy(out, "REVIEW", outLen - 1);
    else if (strcmp(state, "idle") == 0) strncpy(out, "IDLE", outLen - 1);
    else strncpy(out, "OFFLINE", outLen - 1);
    out[outLen - 1] = '\0';
}

// State marker box: awaiting = solid, processing = diagonal hatch, idle = hollow.
void drawStateMarker(int16_t x, int16_t y, int16_t sz, const char* state) {
    display.drawRect(x, y, sz, sz, inkColor);
    if (isAwaiting(state)) {
        display.fillRect(x, y, sz, sz, inkColor);
    } else if (strcmp(state, "processing") == 0) {
        for (int d = 2; d < sz * 2 - 2; d += 3) {
            int x0 = d < sz ? x + d : x + sz - 1;
            int y0 = d < sz ? y : y + (d - sz + 1);
            int x1 = d < sz ? x : x + d - sz + 1;
            int y1 = d < sz ? y + d : y + sz - 1;
            display.drawLine(x0, y0, x1, y1, inkColor);
        }
    }
}

// ===== Screens =====

bool needsAttention(const RowSnap& r) {
    AgentDeckEink::StatusKind status = AgentDeckEink::classifyStatus(r.state);
    return status == AgentDeckEink::StatusKind::Attention ||
           status == AgentDeckEink::StatusKind::Processing;
}

uint8_t prioritizedSessionOrder(const Snap& s, uint8_t* order) {
    uint8_t n = 0;
    // User input is always the first thing on paper, followed by live work and
    // finally quiet/offline context. Preserve daemon order within each tier.
    for (uint8_t i = 0; i < s.rowCount; i++)
        if (AgentDeckEink::classifyStatus(s.rows[i].state) == AgentDeckEink::StatusKind::Attention)
            order[n++] = i;
    for (uint8_t i = 0; i < s.rowCount; i++)
        if (AgentDeckEink::classifyStatus(s.rows[i].state) == AgentDeckEink::StatusKind::Processing)
            order[n++] = i;
    for (uint8_t i = 0; i < s.rowCount; i++) if (!needsAttention(s.rows[i])) order[n++] = i;
    return n;
}

void hiddenSessionSummary(const Snap& s, const AgentDeckEink::Layout& layout,
                          char* out, size_t outLen) {
    out[0] = '\0';
    uint8_t order[MAX_ROWS];
    const uint8_t n = prioritizedSessionOrder(s, order);
    uint8_t input = 0, working = 0, idle = 0, offline = 0;
    for (uint8_t k = layout.capacity; k < n; k++) {
        switch (AgentDeckEink::classifyStatus(s.rows[order[k]].state)) {
            case AgentDeckEink::StatusKind::Attention:  input++; break;
            case AgentDeckEink::StatusKind::Processing: working++; break;
            case AgentDeckEink::StatusKind::Idle:       idle++; break;
            default:                                   offline++; break;
        }
    }
    auto append = [&](uint8_t count, const char* label) {
        if (!count) return;
        size_t used = strlen(out);
        snprintf(out + used, outLen - used, "%s%d %s", used ? " / " : "", count, label);
    };
    append(input, "input");
    append(working, "working");
    append(idle, "idle");
    append(offline, "offline");
}

void drawBrandHeader(const Snap& s, const AgentDeckEink::Layout& layout) {
    // Dome-over-deck product mark + wordmark — the same lockup as the
    // menubar icon and app icon silhouette.
    drawAgentDeckMark(12, 4, 56);
    textAt(78, 44, "AgentDeck", &FreeSansBold18pt7b);

    // Link status chip, right-aligned
    const char* link = s.bridgeConnected ? (s.serialUp ? "USB LINK" : "WIFI LINK") : "NO LINK";
    int16_t tw = textWidth(link, &FreeSansBold9pt7b);
    int16_t chipW = tw + 24, chipX = W - 16 - chipW;
    if (s.bridgeConnected) {
        display.fillRoundRect(chipX, 16, chipW, 32, 6, GxEPD_BLACK);
        display.setTextColor(GxEPD_WHITE);
        textAt(chipX + 12, 38, link, &FreeSansBold9pt7b);
        display.setTextColor(inkColor);
    } else {
        display.drawRoundRect(chipX, 16, chipW, 32, 6, GxEPD_BLACK);
        textAt(chipX + 12, 38, link, &FreeSansBold9pt7b);
    }

    // Session count, left of the chip. When the fixed paper grid is full, say
    // exactly which passive/active categories were collapsed.
    if (s.totalSessions > 0) {
        char hidden[72];
        hiddenSessionSummary(s, layout, hidden, sizeof(hidden));
        char cnt[112];
        if (hidden[0]) {
            snprintf(cnt, sizeof(cnt), "%d sessions | hidden: %s", s.totalSessions, hidden);
        } else {
            snprintf(cnt, sizeof(cnt), "%d session%s", s.totalSessions,
                     s.totalSessions == 1 ? "" : "s");
        }
        const int16_t available = chipX - 14 - 270;
        const GFXfont* countFont = textWidth(cnt, &FreeSans9pt7b) <= available
            ? &FreeSans9pt7b : CLASSIC_FONT;
        textRight(chipX - 14, 38, cnt, countFont);
    }

    // Double rule (print-style)
    display.fillRect(0, 62, W, 2, GxEPD_BLACK);
    display.drawFastHLine(0, 66, W, GxEPD_BLACK);
}

static const char* usageAgentType(UsageRows::Provider p) {
    switch (p) {
        case UsageRows::CLAUDE: return "claude-code";
        case UsageRows::CODEX:  return "codex-cli";
        case UsageRows::ZAI:    return "zai";
        default:                return "antigravity";
    }
}

// Usage table geometry — every provider row shares the same columns, so the
// 5H / 7D (MCP, Luna) gauges line up down the band.
namespace UsageTable {
constexpr int16_t NameX = 14, LabelX = 44, SlotX = 184, TagW = 58, ValueW = 84;
inline int16_t slotW() { return (W - 12 - SlotX) / 2; }
}

// One window: fixed tag column | bar | value, reset countdown underneath.
void drawGaugeBar(int16_t x, int16_t y, const UsageRows::Row& row, int16_t slotW) {
    using namespace UsageTable;
    constexpr int16_t barH = 12;
    const int16_t bx = x + TagW;
    const int16_t barW = max((int16_t)24, (int16_t)(slotW - TagW - ValueW - 8));
    char tag[8]; snprintf(tag, sizeof(tag), "%s", row.label);
    for (char* c = tag; *c; ++c) *c = (char)toupper((unsigned char)*c);
    textAt(x, y + 13, tag, &FreeSansBold9pt7b);
    display.drawRect(bx, y, barW, barH, GxEPD_BLACK);
    display.fillRect(bx + 2, y + 2, (int16_t)((barW - 4) * row.shown() / 100), barH - 4, GxEPD_BLACK);
    char val[16]; snprintf(val, sizeof(val), row.left ? "%d%% left" : "%d%%", row.shown());
    textAt(bx + barW + 6, y + 13, val, &FreeSans9pt7b);
    if (row.reset[0]) {
        char reset[32]; snprintf(reset, sizeof(reset), "resets %s", row.reset);
        textAt(bx, y + 30, reset, &FreeSans9pt7b);
    }
}

// The provider's plan in the slot a missing window leaves: "PLAN  Pro  until ~7/28".
void drawPlanSlot(int16_t x, int16_t y, const UsageRows::Group& g, int16_t slotW) {
    using namespace UsageTable;
    textAt(x, y + 13, "PLAN", &FreeSansBold9pt7b);
    char plan[48];
    if (g.until[0]) snprintf(plan, sizeof(plan), "%s%suntil %s", g.tier, g.tier[0] ? "  " : "", g.until);
    else snprintf(plan, sizeof(plan), "%s", g.tier);
    char fitted[48]; smartFitText(fitted, sizeof(fitted), plan, slotW - TagW - 8, &FreeSans9pt7b);
    smartTextAt(x + TagW, y + 13, fitted, &FreeSans9pt7b);
}

// Provider row (36px): mark + name, then two aligned slots. A missing window is
// never a "--" placeholder; the plan takes its slot, or — with both windows —
// sits under the provider name.
void drawProviderUsage(int16_t y, const UsageRows::Group& g) {
    using namespace UsageTable;
    drawAgentGlyph(usageAgentType(g.provider), NameX, y + 2, 22);
    char name[24]; snprintf(name, sizeof(name), "%s", g.name());
    for (char* c = name; *c; ++c) *c = (char)toupper((unsigned char)*c);
    textAt(LabelX, y + 13, name, &FreeSansBold9pt7b);
    const bool planSlot = g.hasPlan() && g.rowCount < 2;
    if (g.hasPlan() && !planSlot) {
        char plan[40]; UsageRows::planText(g, plan, sizeof(plan), " ");
        char fitted[40]; smartFitText(fitted, sizeof(fitted), plan, SlotX - LabelX - 8, &FreeSans9pt7b);
        smartTextAt(LabelX, y + 30, fitted, &FreeSans9pt7b);
    }
    for (uint8_t r = 0; r < g.rowCount; r++) drawGaugeBar(SlotX + r * slotW(), y + 2, g.rows[r], slotW());
    if (planSlot) drawPlanSlot(SlotX + g.rowCount * slotW(), y + 2, g, slotW());
}

// Provider usage rows that will actually draw. This count feeds the shared
// geometry engine used by TRMNL 7.5" + XTeink.
static int usageRowCount(const Snap& s) { return s.usageCount; }

static uint8_t dashboardActivityRows(const Snap& s) {
    if (!s.bridgeConnected) return 0;
    // Preserve two readable card rows when several sessions share the page.
    return min(s.tickerCount, (uint8_t)(s.rowCount > 2 ? 2 : Snap::TICKER_ROWS));
}

AgentDeckEink::Layout dashboardLayout(const Snap& s) {
    uint8_t activityRows = dashboardActivityRows(s);
    return AgentDeckEink::makeLayout(AgentDeckEink::LayoutInput{
        W, H,
        68,  // product header + double rule
        0,   // TRMNL 7.5" has no persistent button-hint bar
        36, 28,
        (uint8_t)usageRowCount(s), (uint8_t)(activityRows > 0 ? activityRows + 1 : 0),
        s.rowCount, 2,
    });
}

// Usage + recent-work components are ANCHORED by the shared responsive layout
// (band y/height come from `layout.usage` / `layout.activity`, never from magic
// 800x480 offsets), and X3/X4 consume that same band contract through the
// mirrored geometry header.
//
// Available usage windows divide the remaining row width equally.
void drawUsageFooter(const Snap& s, bool showIdentity, const AgentDeckEink::Layout& layout) {
    if (!layout.usage.empty()) {
        display.fillRect(0, layout.usage.y, W, 2, GxEPD_BLACK);
        int16_t y = layout.usage.y + layout.gap;
        for (uint8_t g = 0; g < s.usageCount; g++, y += 36)
            drawProviderUsage(y, s.usage[g]);
        const bool any = s.usageCount > 0;
        if (!any) textAt(16, y + 16, "usage: waiting for data", &FreeSans9pt7b);
    }

    // AGY subscription chip — smallest possible footprint (classic font,
    // bottom-right corner), only when the daemon resolves the account.
    int16_t agW = 0;
    if (showIdentity) {
        // Searching screen only: build identity (flash verification aid)
        char tag[64];
        snprintf(tag, sizeof(tag), "v%s %.7s", FIRMWARE_VERSION, GIT_SHA);
        textRight(W - layout.pad - agW, H - 6, tag, &FreeSans9pt7b);
    }

    // Recent-work strip — up to TICKER_ROWS milestone timeline rows, newest
    // at the top. UTF-8/한글 safe — Korean prompts previously rendered as
    // "######?". Gated on the live daemon link: a stale timeline line
    // lingering under the "searching…" / no-link screen read as if the daemon
    // were still connected. Only the bottom row shares its width with the AGY
    // chip / identity tag pinned at y≈474.
    if (s.bridgeConnected && s.tickerCount > 0) {
        textAt(layout.pad, layout.activity.y + 16, "RECENT", &FreeSansBold9pt7b);
        constexpr int16_t rowH = 28;
        for (uint8_t i = 0; i < dashboardActivityRows(s); i++) {
            int16_t ty = layout.activity.y + 44 + (int16_t)i * rowH;
            bool bottomRow = (i == dashboardActivityRows(s) - 1);
            textAt(layout.pad, ty, s.tickerTime[i], &FreeSansBold9pt7b);
            char tf[108];
            int16_t textX = layout.pad + 58;
            int16_t maxW = W - textX - layout.pad -
                (bottomRow ? agW + (showIdentity ? 110 : 0) : 0);
            smartFitText(tf, sizeof(tf), s.tickerText[i], maxW, &FreeSans9pt7b);
            smartTextAt(textX, ty, tf, &FreeSans9pt7b);
        }
    }
}

void drawSessionCard(const Snap& s, const RowSnap& r, bool firstAwaiting,
                     int16_t x, int16_t y, int16_t w, int16_t h) {
    bool awaiting = isAwaiting(r.state);
    bool tall = h > 200;

    if (awaiting) {
        display.fillRoundRect(x, y, w, h, 10, GxEPD_BLACK);
        setInk(true);
    } else {
        display.drawRoundRect(x, y, w, h, 10, GxEPD_BLACK);
        display.drawRoundRect(x + 1, y + 1, w - 2, h - 2, 10, GxEPD_BLACK);
        setInk(false);
    }

    // Narrow (3-col) cards get a smaller glyph so text keeps real width —
    // shrinking type is preferred over ellipsizing (user feedback).
    int glyph = tall ? 110 : (w >= 340 ? 72 : 48);
    int16_t gx = x + (w >= 340 ? 16 : 10), gy = y + (h - glyph) / 2;
    if (tall) gy = y + 28;
    drawAgentGlyph(r.agentType, gx, gy, glyph);

    int16_t tx = gx + glyph + (w >= 340 ? 18 : 12);
    int16_t subagentReserve = r.subagentCount > 0 ? 52 : 0;
    int16_t maxTextW = x + w - tx - 12 - subagentReserve;

    // E-ink uses a static miniature orbit so there is no refresh animation or
    // ghosting churn. The parent card remains the only selectable entity.
    if (r.subagentCount > 0) {
        constexpr int8_t ringX[12] = {-12, -10, -6, 0, 6, 10, 12, 10, 6, 0, -6, -10};
        constexpr int8_t ringY[12] = {0, -3, -5, -6, -5, -3, 0, 3, 5, 6, 5, 3};
        int16_t orbitX = x + w - 30;
        int16_t orbitY = y + 19;
        for (uint8_t i = 0; i < 12; i += 2) {
            display.drawPixel(orbitX + ringX[i], orbitY + ringY[i], inkColor);
        }
        display.drawLine(orbitX, orbitY, orbitX + 12, orbitY, inkColor);
        display.fillCircle(orbitX + 12, orbitY, 2, inkColor);
        char count[6];
        snprintf(count, sizeof(count), "%u", (unsigned)r.subagentCount);
        textRight(x + w - 8, y + 38, count, CLASSIC_FONT);
    }

    // Project name — ASCII gets the bold cascade; 한글 names render via the
    // unifont path (previously mangled to '#' runs by the ASCII sanitizer)
    const char* rawName = r.name[0] ? r.name : "(unnamed)";
    char fitted[64];
    int16_t ny = y + (tall ? 52 : 32);
    if (isAsciiOnly(rawName)) {
        const GFXfont* nameFont = tall
            ? fitCascade(fitted, sizeof(fitted), rawName, maxTextW, &FreeSansBold18pt7b, &FreeSansBold12pt7b)
            : fitCascade(fitted, sizeof(fitted), rawName, maxTextW, &FreeSansBold12pt7b, &FreeSansBold9pt7b);
        textAt(tx, ny, fitted, nameFont);
    } else {
        smartFitText(fitted, sizeof(fitted), rawName, maxTextW, &FreeSansBold12pt7b);
        smartTextAt(tx, ny, fitted, &FreeSansBold12pt7b);
    }

    // State line: marker + label (+ current tool while processing). Session
    // age was dropped here — elapsedSec is time since session START, and
    // "IDLE · 54m" read as 54 minutes of idling, which it never meant.
    char label[16]; stateLabel(r.state, label, sizeof(label));
    int16_t sy = ny + (tall ? 36 : 26);
    drawStateMarker(tx, sy - 11, 12, r.state);
    char stateLine[64];
    // The state line carries the LIVE "right now" one-liner (activity summary,
    // falling back to the raw tool) — mid-turn churn belongs here, next to the
    // state marker. The detail lines below are reserved for the TIMELINE-grade
    // work summary, so "Running cd …" never displaces what the agent actually
    // asked/answered.
    // ASCII-only separator: this line rides the fitCascade → CLASSIC_FONT
    // fallback, and the built-in CP437 font renders the UTF-8 " · " pair as
    // "Â·" garbage (FreeFonts silently skip it — either way it's wrong).
    if (!awaiting && r.activity[0]) {
        char t[48]; ascii(t, sizeof(t), r.activity);
        snprintf(stateLine, sizeof(stateLine), "%s: %s", label, t);
    } else if (!awaiting && r.tool[0]) {
        char t[40]; ascii(t, sizeof(t), r.tool);
        snprintf(stateLine, sizeof(stateLine), "%s: %s", label, t);
    } else {
        strncpy(stateLine, label, sizeof(stateLine) - 1); stateLine[sizeof(stateLine) - 1] = '\0';
    }
    char stateFitted[68];
    const GFXfont* stateFont = fitCascade(stateFitted, sizeof(stateFitted), stateLine,
                                          maxTextW - 20, &FreeSansBold9pt7b, CLASSIC_FONT);
    textAt(tx + 20, sy, stateFitted, stateFont);

    // Detail: awaiting question (wrapped) or the activity one-liner —
    // "what did/is this agent actually doing", far more glanceable than a timer.
    int16_t dy = sy + 24;
    if (awaiting && r.question[0]) {
        // wrap up to 2 lines (3 on tall cards) — UTF-8/한글 safe
        int maxLines = tall ? 3 : (h >= 130 ? 2 : 1);
        const char* p = r.question;
        for (int line = 0; line < maxLines && *p && dy < y + h - 8; line++) {
            char buf[112];
            size_t n = strlen(p);
            size_t take = n < sizeof(buf) - 1 ? n : sizeof(buf) - 1;
            take = utf8Boundary(p, take);
            while (take > 0) {
                strncpy(buf, p, take); buf[take] = '\0';
                if (smartWidth(buf, &FreeSans9pt7b) <= maxTextW) break;
                // back off to previous space if any, else previous UTF-8 char
                size_t sp = take - 1;
                while (sp > 0 && p[sp] != ' ') sp--;
                take = sp > 0 ? sp : utf8Boundary(p, take - 1);
            }
            strncpy(buf, p, take); buf[take] = '\0';
            smartTextAt(tx, dy, buf, &FreeSans9pt7b);
            p += take;
            while (*p == ' ') p++;
            dy += 20;
        }
        // Options (focused/global) on the first awaiting card
        if (firstAwaiting && s.optionCount > 0 && tall) {
            for (uint8_t i = 0; i < s.optionCount && dy < y + h - 10; i++) {
                char opt[48], oa[40];
                ascii(oa, sizeof(oa), s.options[i]);
                snprintf(opt, sizeof(opt), "%d) %s", i + 1, oa);
                char of[52];
                fitText(of, sizeof(of), opt, maxTextW, &FreeSans9pt7b);
                textAt(tx, dy, of, &FreeSans9pt7b);
                dy += 20;
            }
        }
    } else if (r.work[0] && dy < y + h - 8) {
        // TIMELINE work summary ("HH:MM · task · text") gets up to TWO wrapped
        // lines (same font on both) — this line is the point of the card, so
        // give it room. UTF-8/한글 safe. The live activity one-liner is NOT
        // repeated here (it already rides the state line above).
        bool roomFor2 = dy + 20 < y + h - 6;
        if (roomFor2) drawWrapped2(tx, dy, dy + 20, maxTextW, r.work, &FreeSans9pt7b);
        else {
            char af[156];
            smartFitText(af, sizeof(af), r.work, maxTextW, &FreeSans9pt7b);
            smartTextAt(tx, dy, af, &FreeSans9pt7b);
        }
    } else if (dy < y + h - 8) {
        const auto kind = AgentDeckEink::classifyStatus(r.state);
        const char* fallback = kind == AgentDeckEink::StatusKind::Processing
            ? "Working. Waiting for the next update."
            : (kind == AgentDeckEink::StatusKind::Idle
                ? "Ready for the next request."
                : "Session is currently unavailable.");
        drawWrapped2(tx, dy, dy + 20, maxTextW, fallback, &FreeSans9pt7b);
    }

    // Model tag bottom-right on every card — narrow cards drop to the
    // classic font instead of losing the model entirely.
    if (r.model[0] && h >= 110) {
        char m[32]; ascii(m, sizeof(m), r.model);
        char mf[36];
        const GFXfont* modelFont = w >= 340
            ? fitCascade(mf, sizeof(mf), m, w - glyph - 60, &FreeSans9pt7b, CLASSIC_FONT)
            : fitCascade(mf, sizeof(mf), m, w - 24, CLASSIC_FONT, nullptr);
        textRight(x + w - 12, y + h - 10, mf, modelFont);
    }

    setInk(false);
}

void drawSessionGrid(const Snap& s, const AgentDeckEink::Layout& layout) {
    if (s.rowCount == 0) {
        // Empty state — connected but no sessions
        const int16_t centerY = layout.cards.y + layout.cards.h / 2;
        drawAgentDeckMark(W / 2 - 36, centerY - 82, 72);
        textAt(W / 2 - textWidth("no active sessions", &FreeSansBold12pt7b) / 2, centerY + 24,
               "no active sessions", &FreeSansBold12pt7b);
        const char* hint = "start claude / codex / opencode in a workspace";
        textAt(W / 2 - textWidth(hint, &FreeSans9pt7b) / 2, centerY + 54, hint, &FreeSans9pt7b);
        return;
    }

    // Partition: attention (awaiting/processing) ahead of idle, daemon order
    // preserved within each group. Shared geometry decides whether this panel
    // can show 1/2/3 columns and how many readable rows fit.
    uint8_t order[MAX_ROWS];
    uint8_t nOrder = prioritizedSessionOrder(s, order);

    uint8_t nCards = nOrder < layout.capacity ? nOrder : layout.capacity;

    int firstAwaitingIdx = -1;
    for (uint8_t k = 0; k < nCards; k++) {
        if (isAwaiting(s.rows[order[k]].state)) { firstAwaitingIdx = order[k]; break; }
    }

    for (uint8_t k = 0; k < nCards; k++) {
        AgentDeckEink::Rect card = layout.card(k);
        drawSessionCard(s, s.rows[order[k]], (int)order[k] == firstAwaitingIdx,
                        card.x, card.y, card.w, card.h);
    }
}

// ===== Paper faces =====
// A face is a different information contract, not a visual theme. The push
// TRMNL 7.5" exposes the full five-face set. Pull-default readers expose the
// durable GLANCE/DIGEST/ROSTER base set. DECISION and ANSWER become eligible
// only while a physical action has opened an eight-minute interactive lease.
enum class PaperFace : uint8_t { Glance, Decision, Answer, Digest, Roster, Aquarium };
PaperFace lastPaintedFace = PaperFace::Glance;
uint8_t lastAquariumAttention = 0;

PaperFace renderFace = PaperFace::Glance;
PaperFace manualFace = PaperFace::Glance;
#if defined(AGENTDECK_EPD47_UI)
AgentDeckEpd47::Page epd47Page = AgentDeckEpd47::Page::Home;
// Post-interaction anti-ghost sweep (see epd47_refresh_policy.h). 12s of touch
// silence: longer than the gap between taps in one session, well under the
// 60s ambient interval — chosen, not measured.
constexpr uint32_t EPD47_POST_TOUCH_SWEEP_QUIET_MS = 12000;
uint32_t epd47LastTouchMs = 0;
bool epd47PostTouchSweepDue = false;
uint32_t epd47PageHoldUntilMs = 0;
AgentDeckEpd47::Page lastPhysicalEpd47Page = AgentDeckEpd47::Page::Home;
bool physicalEpd47PageReady = false;
// Reused identity buffers bind taps to the rows actually painted, not a reordered snapshot.
char epd47FocusedId[32] = {};
char epd47PaintedRows[7][32] = {};
uint8_t epd47HomeSelection = 0;
uint8_t epd47DecisionSelection = 0;
uint32_t epd47SelectionDecisionHash = 0;
#if defined(BOARD_LILYGO_EPD47)
uint32_t epd47DecisionButtonDownMs = 0;
bool epd47DecisionButtonTracking = false;
#endif
#endif
#if defined(AGENTDECK_NM_UI)
uint8_t nmDecisionSelection = 0;
uint32_t nmSelectionDecisionHash = 0;
#endif
#if defined(AGENTDECK_TRMNL_75_UI)
uint8_t inkDecisionSelection = 0;
uint32_t inkSelectionDecisionHash = 0;
#endif
#if defined(BOARD_NM_EPD_420)
// Used only to bypass the ambient content gate for meaningful face/link/count
// transitions. It does not enable any partial waveform.
PaperFace lastPhysicalFace = PaperFace::Glance;
bool physicalFaceReady = false;
uint8_t lastPhysicalAttention = 0;
uint8_t lastPhysicalWorking = 0;
// Settled-count bypass. The ambient floor exists because turn churn makes the
// working count flap every few seconds, and every admitted NM repaint is a
// ~10s full tri-color cycle — but the glance face's whole content IS these
// counts, and a number that stays wrong for 15 minutes reads as a frozen
// panel. A changed count that HOLDS for the settle window is a real state
// shift and earns the repaint; a flap never settles and stays coalesced.
// 90s: longer than the between-turns bounce, far under the ambient floor —
// chosen, not measured. Same shape as the EPD47 page arbiter's settle.
uint8_t nmPendingAttention = 255;
uint8_t nmPendingWorking = 255;
uint32_t nmCountStableSinceMs = 0;
constexpr uint32_t NM_COUNT_SETTLE_MS = 90UL * 1000UL;
#endif
uint32_t faceHoldUntilMs = 0;
uint32_t interactiveLeaseUntilMs = 0;
uint32_t suppressedDecisionHash = 0;
uint32_t lastDecisionHash = 0;
uint32_t lastAnswerHash = 0;
bool sawProcessing = false;

constexpr uint32_t FACE_HOLD_MS = 8UL * 60UL * 1000UL;

#if defined(AGENTDECK_EPD47_UI)
bool epd47TouchAvailable() {
#if defined(BOARD_LILYGO_EPD47)
    return Input::touchReady();
#elif defined(BOARD_SIM_EPD47_NOTOUCH)
    // Second preview env for the degraded unit: a T5 4.7 whose touch FPC is not
    // seated in P6 answers nothing on the I2C sweep, and the GPIO21 tab-cycle
    // grammar is what its user sees. Kept renderable so that fallback is
    // reviewed rather than assumed.
    return false;
#else
    // The owned unit's GT911 answers at 0x5D (measured 2026-08-30, after its
    // touch FPC was reseated in P6). The default preview therefore renders the
    // touch grammar, which is what ships.
    return true;
#endif
}
#endif

bool interactiveLeaseActive(uint32_t now) {
#if defined(BOARD_TRMNL_75) && !defined(BOARD_SIM_PULL)
    (void)now;
    return true;
#else
    return interactiveLeaseUntilMs != 0 &&
           (int32_t)(interactiveLeaseUntilMs - now) > 0;
#endif
}

const char* faceName(PaperFace face) {
    switch (face) {
        case PaperFace::Decision: return "DECISION";
        case PaperFace::Answer:   return "ANSWER";
        case PaperFace::Digest:   return "DIGEST";
        case PaperFace::Roster:   return "ROSTER";
        case PaperFace::Aquarium: return "AQUARIUM";
        default:                  return "GLANCE";
    }
}

// Red exists only on the tri-color NM glass. Gate on the UI variant, NOT on
// BOARD_NM_EPD_420: the host simulator builds this face under BOARD_SIM_NM and
// would otherwise render every red decision as black, silently — which is how
// the red placement went unreviewed for the whole life of the surface.
uint16_t accentColor() {
#if defined(AGENTDECK_NM_UI)
    return GxEPD_RED;
#else
    return GxEPD_BLACK;
#endif
}

int primarySession(const Snap& s, AgentDeckEink::StatusKind wanted) {
    for (uint8_t i = 0; i < s.rowCount; i++)
        if (AgentDeckEink::classifyStatus(s.rows[i].state) == wanted) return i;
    return -1;
}

int primarySession(const Snap& s) {
    int i = primarySession(s, AgentDeckEink::StatusKind::Attention);
    if (i >= 0) return i;
    i = primarySession(s, AgentDeckEink::StatusKind::Processing);
    if (i >= 0) return i;
    i = primarySession(s, AgentDeckEink::StatusKind::Idle);
    return i >= 0 ? i : (s.rowCount ? 0 : -1);
}

uint32_t displayedDecisionHash = 0;

uint32_t decisionHash(const Snap& s) {
    uint32_t h = 2166136261u;
    for (uint8_t i = 0; i < s.rowCount; i++) {
        if (!isAwaiting(s.rows[i].state)) continue;
        h = fnvStr(h, s.rows[i].id);
        h = fnvStr(h, s.rows[i].name);
        h = fnvStr(h, s.rows[i].state);
        h = fnvStr(h, s.rows[i].question);
    }
    for (uint8_t i = 0; i < s.optionCount; i++) h = fnvStr(h, s.options[i]);
    return h;
}

bool sendDecisionSelection(const Snap& s, uint8_t selection) {
    const int awaiting = primarySession(s, AgentDeckEink::StatusKind::Attention);
    if (awaiting < 0 || s.optionCount == 0 || selection >= s.optionCount ||
        !displayedDecisionHash || decisionHash(s) != displayedDecisionHash) return false;
    char command[112];
    snprintf(command, sizeof(command),
             "{\"type\":\"select_option\",\"index\":%u,\"sessionId\":\"%s\"}",
             (unsigned)selection, s.rows[awaiting].id);
    Net::queueOutbound(command);
    return true;
}

uint32_t answerHash(const Snap& s) {
    int i = primarySession(s, AgentDeckEink::StatusKind::Idle);
    if (i < 0) return 0;
    uint32_t h = 2166136261u;
    h = fnvStr(h, s.rows[i].name);
    h = fnvStr(h, s.rows[i].work);
    return h;
}

uint32_t paperHash(const Snap& s, PaperFace face) {
    uint32_t h = 2166136261u;
    h = fnv(h, &face, sizeof(face));
    h = fnv(h, &s.bridgeConnected, sizeof(s.bridgeConnected));
    h = fnv(h, &s.rowCount, sizeof(s.rowCount));
#if defined(AGENTDECK_EPD47_UI)
    if (face == PaperFace::Glance) h = fnv(h, &epd47Page, sizeof(epd47Page));
#endif
    if (face == PaperFace::Aquarium) {
        // Only the footer is dynamic. Tool strings, ticker and reset countdowns
        // cannot repaint the plate or spend a panel cleanup cycle.
        h = fnv(h, &s.totalSessions, sizeof(s.totalSessions));
        h = fnv(h, &s.usageStale, sizeof(s.usageStale));
        if (!s.bridgeConnected) return h;
        uint8_t working = 0, attention = 0;
        for (uint8_t i = 0; i < s.rowCount; i++) {
            const auto status = AgentDeckEink::classifyStatus(s.rows[i].state);
            if (status == AgentDeckEink::StatusKind::Processing) working++;
            if (status == AgentDeckEink::StatusKind::Attention) attention++;
        }
        h = fnv(h, &working, sizeof(working));
        h = fnv(h, &attention, sizeof(attention));
        if (s.usageStale) return h;
        const float values[] = {s.fiveH, s.sevenD, s.codexP, s.codexS, s.zaiP, s.zaiS};
        for (float value : values) { const int percent = (int)value; h = fnv(h, &percent, sizeof(percent)); }
        return fnv(h, &s.zaiIsMcp, sizeof(s.zaiIsMcp));
    }
    if (face == PaperFace::Decision) return fnv(h, &lastDecisionHash, sizeof(lastDecisionHash));
    if (face == PaperFace::Answer) return fnv(h, &lastAnswerHash, sizeof(lastAnswerHash));
    if (face == PaperFace::Roster) return contentHash(s);
    if (face == PaperFace::Digest) {
        for (uint8_t i = 0; i < s.tickerCount; i++) {
            h = fnvStr(h, s.tickerTime[i]);
            h = fnvStr(h, s.tickerText[i]);
        }
        return h;
    }
    // GLANCE deliberately ignores live tool/activity churn. It changes only on
    // session state, durable milestone, counts, or integer usage movement.
    for (uint8_t i = 0; i < s.rowCount; i++) {
        h = fnvStr(h, s.rows[i].name);
        h = fnvStr(h, s.rows[i].state);
        h = fnvStr(h, s.rows[i].work);
    }
    int fh = (int)s.fiveH, sd = (int)s.sevenD, cp = (int)s.codexP, cs = (int)s.codexS;
    h = fnv(h, &fh, sizeof(fh)); h = fnv(h, &sd, sizeof(sd));
    h = fnv(h, &cp, sizeof(cp)); h = fnv(h, &cs, sizeof(cs));
    return hashUsage(h, s, false);
}

int drawParagraph(int16_t x, int16_t y, int16_t maxW, int16_t lineH,
                  int maxLines, const char* text, const GFXfont* font) {
    if (!text || !text[0]) return 0;
    const char* p = text;
    int lines = 0;
    while (*p && lines < maxLines) {
        while (*p == ' ') p++;
        size_t remain = strlen(p);
        size_t take = remain < 180 ? remain : utf8Boundary(p, 179);
        char line[184];
        while (take > 1) {
            memcpy(line, p, take); line[take] = '\0';
            if (smartWidth(line, font) <= maxW) break;
            take = utf8Boundary(p, take - 1);
        }
        if (take < remain) {
            size_t space = take;
            while (space > 0 && p[space] != ' ') space--;
            if (space > take / 2) take = space;
        }
        if (lines == maxLines - 1 && take < remain) {
            smartFitText(line, sizeof(line), p, maxW, font);
            smartTextAt(x, y + lines * lineH, line, font);
            return lines + 1;
        }
        memcpy(line, p, take); line[take] = '\0';
        smartTextAt(x, y + lines * lineH, line, font);
        p += take;
        lines++;
    }
    return lines;
}

void drawPaperHeader(const Snap& s, PaperFace face) {
    const int16_t pad = W <= 420 ? 12 : 20;
    const int16_t headerH = W <= 420 ? 48 : 62;
    // Red is a SEMANTIC ink, not decoration (DESIGN.md rule 4). The tri-color
    // waveform is already paid for on every NM repaint, so red costs nothing
    // extra — which is exactly why it must be spent on the one thing the user
    // has to act on rather than on a permanent rail. A panel whose header is
    // always red says nothing when something actually needs attention.
    const bool needsUser =
        face == PaperFace::Decision ||
        primarySession(s, AgentDeckEink::StatusKind::Attention) >= 0;
    const uint16_t accent = needsUser ? accentColor() : GxEPD_BLACK;
    display.fillRect(0, 0, W, W <= 420 ? 7 : 9, accent);
    drawAgentDeckMark(pad, 10, W <= 420 ? 30 : 40);
    // GLANCE is an internal arbitration state, not product-facing navigation.
    // The resting page keeps the product name; alternate pages name the
    // durable thing the user deliberately opened.
    const char* title = face == PaperFace::Glance ? "AgentDeck" : faceName(face);
    textAt(pad + (W <= 420 ? 40 : 54), W <= 420 ? 36 : 46,
           title, W <= 420 ? &FreeSansBold12pt7b : &FreeSansBold18pt7b);
    // Link state is exception-based: a healthy link says nothing (SYNCED was
    // permanent chrome answering a question nobody asked), and OFFLINE is the
    // one word that earns the accent ink — a dead link is the thing the user
    // must act on. The Swift preview has drawn it this way all along.
    if (!s.bridgeConnected) {
        InkScope ink(accentColor());
        textRight(W - pad, W <= 420 ? 34 : 42, "OFFLINE",
                  W <= 420 ? CLASSIC_FONT : &FreeSansBold9pt7b);
    }
    display.drawFastHLine(pad, headerH, W - pad * 2, GxEPD_BLACK);
}

// labelW is the gutter reserved for `label` at the classic 6px font. The
// default fits three characters; the QUEUE rail passes a wider one because its
// labels name the provider AND the window ("CLA 5H"), and a label that overruns
// the gutter is drawn straight through the bar.
void drawMiniUsage(int16_t x, int16_t y, int16_t w, const char* label, float pct,
                   int16_t labelW = 28) {
    {
        InkScope ink(EINK_INK_MUTED);
        textAt(x, y + 10, label, CLASSIC_FONT);
    }
    const int16_t bx = x + labelW;
    const int16_t bw = w - labelW - 32;
    display.fillRect(bx + 2, y + 2, bw - 4, 7, EINK_INK_TINT);
    display.drawRect(bx, y, bw, 11, EINK_INK_RULE);
    if (pct >= 0) {
        int fill = (int)((bw - 4) * min(100.0f, max(0.0f, pct)) / 100.0f);
        // A nearly exhausted window is the one gauge state the user must act
        // on, so it takes the semantic accent (red on the tri-color glass;
        // collapses to black everywhere else — DESIGN.md rule 4).
        display.fillRect(bx + 2, y + 2, fill, 7,
                         pct >= 90.0f ? accentColor() : GxEPD_BLACK);
    }
    char value[10]; snprintf(value, sizeof(value), pct >= 0 ? "%d%%" : "--", (int)pct);
    textRight(x + w, y + 10, value, CLASSIC_FONT);
}

#if defined(AGENTDECK_EPD47_UI)
void epd47Counts(const Snap& s, uint8_t& attention, uint8_t& processing) {
    attention = 0;
    processing = 0;
    for (uint8_t i = 0; i < s.rowCount; i++) {
        const auto kind = AgentDeckEink::classifyStatus(s.rows[i].state);
        if (kind == AgentDeckEink::StatusKind::Attention) attention++;
        else if (kind == AgentDeckEink::StatusKind::Processing) processing++;
    }
}

AgentDeckEpd47::Page epd47AutomaticPage(const Snap& s) {
    uint8_t attention, processing;
    epd47Counts(s, attention, processing);
    return AgentDeckEpd47::automaticPage(attention, processing);
}

// Tab strip geometry. SHARED with the touch hit test below — these used to be a
// local constexpr in the renderer and three bare literals in the tap handler,
// which is a silent mis-hit waiting for the first time either moves. tabX
// clears the 18pt AgentDeck wordmark; the strip must also end before the
// right-aligned link label.
constexpr int16_t EPD47_HEADER_H = 76;
constexpr int16_t EPD47_TAB_X = 330;
constexpr int16_t EPD47_TAB_W = 136;
constexpr int16_t EPD47_TAB_TOP = 8;
constexpr int16_t EPD47_TAB_BOTTOM = 76;
constexpr uint8_t EPD47_TAB_COUNT = 3;

void drawEp47Chrome(const Snap& s, AgentDeckEpd47::Page selected) {
    constexpr int16_t tabX = EPD47_TAB_X;
    constexpr int16_t tabW = EPD47_TAB_W;
    constexpr int16_t headerH = EPD47_HEADER_H;
    display.fillRect(0, 0, W, 8, GxEPD_BLACK);
    drawAgentDeckMark(20, 14, 38);
    textAt(72, 45, "AgentDeck", &FreeSansBold18pt7b);

    if (selected != AgentDeckEpd47::Page::Home || renderFace != PaperFace::Glance) {
        display.drawRoundRect(EPD47_TAB_X, 14, EPD47_TAB_W, 48, 4, GxEPD_BLACK);
        textAt(EPD47_TAB_X + 24, 45, "HOME", &FreeSansBold12pt7b);
    }
    if (selected == AgentDeckEpd47::Page::Home && renderFace == PaperFace::Glance) {
        display.drawRoundRect(EPD47_TAB_X, 14, EPD47_TAB_W, 48, 4, GxEPD_BLACK);
        textAt(EPD47_TAB_X + 18, 45, "LIMITS", &FreeSansBold12pt7b);
    }
    // Exception-based, like the paper header: silence means healthy.
    if (!s.bridgeConnected) {
        textRight(W - 20, 42, "OFFLINE", &FreeSansBold9pt7b);
    }
    display.drawFastHLine(20, headerH, W - 40, EINK_INK_RULE);
}

void drawEp47Footer(const Snap& s, int16_t y = 492) {
    display.drawFastHLine(20, y - 14, W - 40, EINK_INK_RULE);
    // No arbitration chrome. "HELD / 8m · QUEUE READY" narrated the page
    // arbiter's internal state — a question nobody asked — and collided with
    // the event ticker beside it. The footer carries content: up to two
    // timeline rows, and the one capability hint that changes what a user
    // does with their hands. The first row shares its width with that hint;
    // the second gets the full span.
    // Full ink, bold, and honest metrics. The band is 62px on a 540px panel:
    // two 12pt lines measured as overlapping (Korean glyphs run taller than
    // the Latin ascent) with the second line's descenders touching the panel
    // edge. Bold 9pt in full black is the same weight the QUEUE state column
    // reads at across a desk, and two lines of it fit with real gaps —
    // baselines 498/520 leave the rule (478) and the edge (540) alone.
    const bool spacious = y < 492;
    if (spacious) textAt(20, y + 6, "RECENT", &FreeSansBold9pt7b);
    const uint8_t tickerLines = min(s.tickerCount, (uint8_t)(spacious ? 3 : 2));
    for (uint8_t ti = 0; ti < tickerLines; ti++) {
        char event[116];
        const int16_t lineY = y + (spacious ? 34 : 6) + (int16_t)ti * 22;
        smartFitText(event, sizeof(event), s.tickerText[ti],
                     ti == 0 ? 660 : (int16_t)(W - 40), &FreeSansBold9pt7b);
        smartTextAt(20, lineY, event, &FreeSansBold9pt7b);
    }
    if (!epd47TouchAvailable()) {
        textRight(W - 20, y + 6, "TOUCH OFF  |  GPIO21 NEXT", CLASSIC_FONT);
    } else if (s.agPlan[0]) {
        textRight(W - 20, y + 6, s.agPlan, CLASSIC_FONT);
    }
}

void drawEp47Window(int16_t x, int16_t y, int16_t w, const char* label,
                    float pct, const char* reset, bool left = false) {
    textAt(x, y + 18, label, &FreeSansBold12pt7b);
    char value[16];
    // A reserve (Codex Luna) reads as what is LEFT; every window else as used.
    snprintf(value, sizeof(value), pct >= 0 ? (left ? "%d%% LEFT" : "%d%% USED") : "--", (int)pct);
    textRight(x + w, y + 18, value, &FreeSansBold12pt7b);
    // A light track makes the unused remainder readable as a quantity instead
    // of as empty paper — the one thing a 1-bit gauge cannot say.
    display.fillRect(x + 3, y + 37, w - 6, 16, EINK_INK_TINT);
    display.drawRect(x, y + 34, w, 22, EINK_INK_RULE);
    if (pct >= 0) {
        const float bounded = min(100.0f, max(0.0f, pct));
        const int16_t fill = (int16_t)((w - 6) * bounded / 100.0f);
        display.fillRect(x + 3, y + 37, fill, 16, GxEPD_BLACK);
    }
    char resetLine[48];
    snprintf(resetLine, sizeof(resetLine), "RESET  %s", reset && reset[0] ? reset : "waiting");
    InkScope ink(EINK_INK_MUTED);
    textAt(x, y + 78, resetLine, &FreeSans9pt7b);
}

void drawEp47ProviderCard(int16_t x, int16_t w, int16_t h, const UsageRows::Group& g) {
    constexpr int16_t y = 104;
    display.drawRoundRect(x, y, w, h, 8, EINK_INK_RULE);
    drawAgentGlyph(usageAgentType(g.provider), x + 24, y + 24, 54);
    char name[24]; snprintf(name, sizeof(name), "%s", g.name());
    for (char* c = name; *c; ++c) *c = (char)toupper((unsigned char)*c);
    char fitted[40]; smartFitText(fitted, sizeof(fitted), name, w - 120, &FreeSansBold18pt7b);
    smartTextAt(x + 96, y + 55, fitted, &FreeSansBold18pt7b);
    if (g.hasPlan()) {
        InkScope ink(EINK_INK_MUTED);
        char plan[40]; UsageRows::planText(g, plan, sizeof(plan), "  until ");
        smartFitText(fitted, sizeof(fitted), plan, w - 120, &FreeSans9pt7b);
        smartTextAt(x + 96, y + 80, fitted, &FreeSans9pt7b);
    }
    display.drawFastHLine(x + 22, y + 102, w - 44, EINK_INK_RULE);
    // Only the windows the account exposes (the Stream Deck dial rule, #269):
    // an absent window drew a "--" frame and an empty track, which reads as a
    // broken gauge, not as "this plan has no 5H limit". A lone window keeps
    // the first slot and the card breathes below it.
    int16_t wy = y + 126;
    for (uint8_t r = 0; r < g.rowCount; r++, wy += 112) {
        const auto& row = g.rows[r];
        char label[8]; snprintf(label, sizeof(label), "%s", row.label);
        for (char* c = label; *c; ++c) *c = (char)toupper((unsigned char)*c);
        drawEp47Window(x + 24, wy, w - 48, label, (float)row.shown(), row.reset, row.left);
    }
    if (!g.rowCount) {
        InkScope ink(EINK_INK_BODY);
        textAt(x + 24, y + 150, "Plan only - no usage windows", &FreeSans9pt7b);
    }
}

void drawEp47Limits(const Snap& s) {
    drawEp47Chrome(s, AgentDeckEpd47::Page::Limits);
    // One card per provider (shared UsageRows: z.ai MCP, the Codex Luna
    // reserve, plan tier/until). Three fit side by side; a plan-only
    // provider yields first.
    uint8_t picked[3], count = 0;
    for (uint8_t g = 0; g < s.usageCount && count < 3; g++) if (s.usage[g].rowCount) picked[count++] = g;
    for (uint8_t g = 0; g < s.usageCount && count < 3; g++) if (!s.usage[g].rowCount) picked[count++] = g;
    bool twoWindows = false;
    for (uint8_t i = 0; i < count; i++) twoWindows |= s.usage[picked[i]].rowCount == 2;
    const int16_t cardH = twoWindows ? 356 : 244;
    const int16_t cardW = count ? (W - 48 - 24 * (count - 1)) / count : W - 48;
    for (uint8_t i = 0; i < count; i++)
        drawEp47ProviderCard(24 + i * (cardW + 24), cardW, cardH, s.usage[picked[i]]);
    if (!count) {
        textAt(44, 180, "No usage limits available", &FreeSansBold18pt7b);
        textAt(44, 220, "Usage appears here when your account reports a limit.", &FreeSans9pt7b);
    }
    drawEp47Footer(s, twoWindows ? 492 : 380);
}

void drawEp47Focus(const Snap& s) {
    drawEp47Chrome(s, AgentDeckEpd47::Page::Focus);
    int i = epd47FocusedId[0] ? -1 : primarySession(s);
    for (uint8_t n = 0; n < s.rowCount; n++)
        if (strcmp(epd47FocusedId, s.rows[n].id) == 0) { i = n; break; }
    if (i < 0) {
        drawAgentDeckMark(46, 148, 92);
        textAt(172, 188, "QUIET PAPER", &FreeSansBold18pt7b);
        InkScope ink(EINK_INK_BODY);
        textAt(172, 224, "No active work. Return HOME for recent results.",
               &FreeSans9pt7b);
        drawEp47Footer(s);
        return;
    }

    const RowSnap& r = s.rows[i];
    constexpr int16_t top = 112;
    drawAgentGlyph(r.agentType, 34, top, 92);
    char state[20]; stateLabel(r.state, state, sizeof(state));
    textAt(154, top + 24, state, &FreeSansBold9pt7b);
    char name[72]; smartFitText(name, sizeof(name), r.name[0] ? r.name : "AgentDeck",
                                510, &FreeSansBold18pt7b);
    smartTextAt(154, top + 66, name, &FreeSansBold18pt7b);
    const bool awaiting = isAwaiting(r.state);
    const char* body = awaiting
        ? (r.question[0] ? r.question
                         : (epd47TouchAvailable()
                             ? "Decision waiting. Tap this card to open it."
                             : "Decision waiting. Hold GPIO21 to respond."))
        : (r.work[0] ? r.work : (r.activity[0] ? r.activity : "Work is in progress."));
    drawParagraph(154, top + 112, 520, 28, 5, body, &FreeSansBold12pt7b);
    if (r.tool[0] && !awaiting) {
        char tool[74]; smartFitText(tool, sizeof(tool), r.tool, 510, &FreeSans9pt7b);
        InkScope ink(EINK_INK_BODY);
        smartTextAt(154, top + 272, tool, &FreeSans9pt7b);
    }

    display.drawFastVLine(712, 102, 344, EINK_INK_RULE);
    uint8_t attention, processing;
    epd47Counts(s, attention, processing);
    char n[12];
    snprintf(n, sizeof(n), "%u", attention);
    {
        // A zero count is context, not news — only a non-zero attention count
        // earns full black beside the session it belongs to.
        InkScope ink(attention ? GxEPD_BLACK : EINK_INK_MUTED);
        textAt(752, 154, n, &FreeSansBold18pt7b);
    }
    {
        InkScope ink(EINK_INK_MUTED);
        textAt(752, 178, "NEEDS YOU", CLASSIC_FONT);
    }
    snprintf(n, sizeof(n), "%u", processing);
    {
        InkScope ink(processing ? GxEPD_BLACK : EINK_INK_MUTED);
        textAt(752, 244, n, &FreeSansBold18pt7b);
    }
    {
        InkScope ink(EINK_INK_MUTED);
        textAt(752, 268, "WORKING", CLASSIC_FONT);
    }
    int16_t gaugeY = 328;
    if (s.fiveH >= 0) {
        drawMiniUsage(752, gaugeY, 174, "Claude", s.fiveH, 46);
        gaugeY += 48;
    }
    if (s.codexP >= 0 || s.codexS >= 0) { drawMiniUsage(752, gaugeY, 174,
        s.codexP >= 0 ? "Codex 5H" : "Codex 7D", s.codexP >= 0 ? s.codexP : s.codexS, 46); gaugeY += 48; }
    if (s.zaiP >= 0 || s.zaiS >= 0) drawMiniUsage(752, gaugeY, 174,
        s.zaiP >= 0 ? "Z.AI 5H" : (s.zaiIsMcp ? "Z.AI MCP" : "Z.AI 7D"),
        s.zaiP >= 0 ? s.zaiP : s.zaiS, 46);
    if (awaiting) {
        textAt(752, 430,
               epd47TouchAvailable() ? "TAP CARD · DECIDE" : "GPIO21 · DECIDE",
               &FreeSansBold9pt7b);
    }
    drawEp47Footer(s);
}

uint8_t epd47ActiveOrder(const Snap& s, uint8_t out[MAX_ROWS]) {
    // The whole roster, attention first, then working, then idle. This used
    // to admit only attention+processing, which put the largest panel in the
    // fleet at odds with every other surface (and with the row-geometry note
    // below, which sized seven rows to "cover the whole session set"): a
    // machine with two working sessions out of seven showed two rows and
    // blank paper. Idle rows are still rows — the state column says idle.
    uint8_t n = 0;
    constexpr AgentDeckEink::StatusKind kinds[3] = {
        AgentDeckEink::StatusKind::Attention,
        AgentDeckEink::StatusKind::Processing,
        AgentDeckEink::StatusKind::Idle,
    };
    for (uint8_t k = 0; k < 3; k++) {
        for (uint8_t i = 0; i < s.rowCount; i++)
            if (AgentDeckEink::classifyStatus(s.rows[i].state) == kinds[k]) out[n++] = i;
    }
    return n;
}

// QUEUE row geometry. 960x540 previously held three 108px cards and then said
// "+1 MORE ACTIVE" — the largest panel in the fleet showing the least, at the
// information density of the 400x300 NM. A 44px zebra row carries the same four
// facts (agent, project, what it is doing, state) and fits seven, which covers
// the whole session set on a working machine without a second page.
constexpr int16_t EPD47_QUEUE_TOP  = 92;
constexpr int16_t EPD47_QUEUE_ROW  = 44;
constexpr int16_t EPD47_QUEUE_GAP  = 4;
constexpr uint8_t EPD47_QUEUE_ROWS = 7;

void drawEp47Queue(const Snap& s) {
    drawEp47Chrome(s, AgentDeckEpd47::Page::Queue);
    uint8_t order[MAX_ROWS];
    const uint8_t count = epd47ActiveOrder(s, order);
    const uint8_t shown = count < EPD47_QUEUE_ROWS ? count : EPD47_QUEUE_ROWS;
    memset(epd47PaintedRows, 0, sizeof(epd47PaintedRows));
    for (uint8_t row = 0; row < shown; row++) {
        const RowSnap& r = s.rows[order[row]];
        strncpy(epd47PaintedRows[row], r.id, sizeof(epd47PaintedRows[row]) - 1);
        const int16_t y = EPD47_QUEUE_TOP + row * (EPD47_QUEUE_ROW + EPD47_QUEUE_GAP);
        const bool awaiting = isAwaiting(r.state);
        // Zebra tint instead of a drawn card per row: seven outlined boxes read
        // as noise, and the tint is free on a panel that already pays for its
        // refresh. An awaiting row is darker so it is findable without reading.
        // An awaiting row stays on bare paper: maximum contrast for its black
        // bar and black text. Filling it grey looked emphatic in isolation but
        // lowers the contrast of the one row the user has to read.
        if (!awaiting && (row & 1)) display.fillRect(24, y, 912, EPD47_QUEUE_ROW, EINK_INK_TINT);
        if (awaiting) display.fillRect(24, y, 6, EPD47_QUEUE_ROW, GxEPD_BLACK);

        const int16_t base = y + 29;
        drawAgentGlyph(r.agentType, 40, y + 9, 26);
        char name[64]; smartFitText(name, sizeof(name), r.name[0] ? r.name : "session",
                                    250, &FreeSansBold12pt7b);
        smartTextAt(80, base, name, &FreeSansBold12pt7b);

        const char* detail = awaiting && r.question[0]
            ? r.question : (r.work[0] ? r.work : (r.activity[0] ? r.activity : r.tool));
        if (detail && detail[0]) {
            // Ends at 786; the state column owns 800..922. The widest state word
            // ("PERMISSION") is ~112px, so this gap is the elision budget, not
            // slack — a wider detail overruns it and the two texts overprint.
            char fitted[116];
            smartFitText(fitted, sizeof(fitted), detail, 440, &FreeSans9pt7b);
            InkScope ink(awaiting ? GxEPD_BLACK : EINK_INK_BODY);
            smartTextAt(346, base, fitted, &FreeSans9pt7b);
        }
        char state[20]; stateLabel(r.state, state, sizeof(state));
        InkScope ink(awaiting ? GxEPD_BLACK : EINK_INK_MUTED);
        textRight(922, base, state, &FreeSansBold9pt7b);
    }
    if (shown == 0) {
        textAt(36, 168, "No active queue.", &FreeSansBold18pt7b);
        InkScope ink(EINK_INK_BODY);
        textAt(36, 204, "Return HOME for usage and recent results.", &FreeSans9pt7b);
    } else if (count > shown) {
        char more[32]; snprintf(more, sizeof(more), "+%u MORE", (unsigned)(count - shown));
        InkScope ink(EINK_INK_MUTED);
        textRight(936, 440, more, &FreeSansBold9pt7b);
    }
    // Shorter rows free ~250px. Spend it on the provider limits rail rather than
    // white paper: the TRMNL 7.5" board already proves a permanent usage strip is
    // worth its space, and QUEUE previously made the user change tabs for it.
    // Only the windows the account exposes; the survivors share the width.
    constexpr int16_t railY = 452;
    struct Rail { const char* label; float pct; };
    Rail rails[4];
    uint8_t railCount = 0;
    if (s.fiveH >= 0)  rails[railCount++] = {"Claude 5H", s.fiveH};
    if (s.sevenD >= 0) rails[railCount++] = {"Claude 7D", s.sevenD};
    if (s.codexP >= 0) rails[railCount++] = {"Codex 5H", s.codexP};
    if (s.codexS >= 0) rails[railCount++] = {"Codex 7D", s.codexS};
    if (railCount > 0) {
        display.drawFastHLine(24, railY - 14, W - 48, EINK_INK_RULE);
        const int16_t stride = (int16_t)((W - 48 + 14) / railCount);
        for (uint8_t rIdx = 0; rIdx < railCount; rIdx++) {
            drawMiniUsage(24 + rIdx * stride, railY, stride - 14,
                          rails[rIdx].label, rails[rIdx].pct, 64);
        }
    }
    drawEp47Footer(s);
}

// The home stays in place as sessions start/stop. Only explicit input opens details.
void drawEp47Home(const Snap& s) {
    drawEp47Chrome(s, AgentDeckEpd47::Page::Home);
    constexpr int16_t split = 562, right = 590, rightW = 346;
    display.drawFastVLine(split, 92, 414, EINK_INK_RULE);
    textAt(24, 108, "WORK", &FreeSansBold9pt7b);
    textAt(right, 108, "ALL WORK", &FreeSansBold9pt7b);
    const int i = primarySession(s);
    if (i >= 0) {
        const auto& r = s.rows[i];
        char name[64]; smartFitText(name, sizeof(name), r.name, 480, &FreeSansBold18pt7b);
        smartTextAt(24, 148, name, &FreeSansBold18pt7b);
        const char* body = AgentDeckEink::classifyStatus(r.state) == AgentDeckEink::StatusKind::Attention && r.question[0] ? r.question :
            AgentDeckEink::classifyStatus(r.state) == AgentDeckEink::StatusKind::Processing && r.activity[0] ? r.activity :
            r.work[0] ? r.work : r.activity[0] ? r.activity :
            AgentDeckEink::classifyStatus(r.state) == AgentDeckEink::StatusKind::Processing ? "Working. Waiting for the next result." : "Standing by.";
        drawParagraph(24, 181, 500, 26, 3, body, &FreeSansBold12pt7b);
        textAt(24, 268, "Open work >", &FreeSans9pt7b);
    } else {
        textAt(24, 158, "No active work", &FreeSansBold18pt7b);
    }
    textAt(24, 312, "RECENT RESULTS", &FreeSansBold9pt7b);
    for (uint8_t ti = 0; ti < min(s.tickerCount, (uint8_t)3); ti++) {
        char event[116]; smartFitText(event, sizeof(event), s.tickerText[ti], 438, &FreeSans9pt7b);
        textAt(24, 346 + ti * 38, s.tickerTime[ti], &FreeSans9pt7b);
        smartTextAt(86, 346 + ti * 38, event, &FreeSans9pt7b);
    }
    if (s.rowCount > 1) textAt(24, 496, "All work >", &FreeSans9pt7b);
    // Stable roster at glance distance. Detailed quotas stay on LIMITS.
    for (uint8_t row = 0; row < min(s.rowCount, (uint8_t)3); ++row) {
        const auto& r = s.rows[row];
        const int16_t y = 146 + row * 112;
        char name[64]; smartFitText(name, sizeof(name), r.name, rightW, &FreeSansBold12pt7b);
        smartTextAt(right, y, name, &FreeSansBold12pt7b);
        const auto kind = AgentDeckEink::classifyStatus(r.state);
        const char* state = kind == AgentDeckEink::StatusKind::Attention ? "NEEDS YOU" :
            kind == AgentDeckEink::StatusKind::Processing ? "WORKING" : "IDLE";
        textAt(right, y + 23, state, &FreeSansBold9pt7b);
        const char* activity = kind == AgentDeckEink::StatusKind::Attention && r.question[0] ? r.question :
            kind == AgentDeckEink::StatusKind::Processing && r.activity[0] ? r.activity :
            r.work[0] ? r.work : "No activity reported";
        drawParagraph(right, y + 46, rightW, 20, 2, activity, &FreeSans9pt7b);
    }
    if (!s.rowCount) textAt(right, 146, "No sessions", &FreeSans9pt7b);
    textAt(right, 496, "All work >", &FreeSans9pt7b);
    if (!epd47TouchAvailable()) {
        const char* choices[] = {"Work", "All work", "Usage"};
        char hint[64]; snprintf(hint, sizeof(hint), ">%s  /  Tap next, hold open", choices[epd47HomeSelection]);
        textAt(24, 530, hint, &FreeSans9pt7b);
    }
}

void drawEp47Glance(const Snap& s) {
    switch (epd47Page) {
        case AgentDeckEpd47::Page::Focus: drawEp47Focus(s); break;
        case AgentDeckEpd47::Page::Queue: drawEp47Queue(s); break;
        case AgentDeckEpd47::Page::Limits: drawEp47Limits(s); break;
        default: drawEp47Home(s); break;
    }
}
#endif

void drawGlanceFace(const Snap& s) {
    drawPaperHeader(s, PaperFace::Glance);
#if defined(AGENTDECK_NM_UI)
    {
    uint8_t attention = 0, working = 0;
    for (uint8_t n = 0; n < s.rowCount; n++) {
        const auto kind = AgentDeckEink::classifyStatus(s.rows[n].state);
        if (kind == AgentDeckEink::StatusKind::Attention) attention++;
        if (kind == AgentDeckEink::StatusKind::Processing) working++;
    }
    char summary[48]; snprintf(summary, sizeof(summary), "%u needs you  /  %u working", attention, working);
    { InkScope ink(attention ? accentColor() : GxEPD_BLACK);
      textAt(14, 72, summary, &FreeSansBold9pt7b); }
    int windowCount = 0;
    for (uint8_t g = 0; g < s.usageCount; g++) windowCount += s.usage[g].rowCount;
    const int16_t usageTop = windowCount > 2 ? 158 : 192;
    const int i = primarySession(s);
    if (i >= 0) {
        const auto& r = s.rows[i];
        char name[64]; smartFitText(name, sizeof(name), r.name, W - 28, &FreeSansBold12pt7b);
        smartTextAt(14, 104, name, &FreeSansBold12pt7b);
        const char* body = AgentDeckEink::classifyStatus(r.state) == AgentDeckEink::StatusKind::Attention && r.question[0] ? r.question :
            AgentDeckEink::classifyStatus(r.state) == AgentDeckEink::StatusKind::Processing && r.activity[0] ? r.activity :
            r.work[0] ? r.work : r.activity[0] ? r.activity :
            AgentDeckEink::classifyStatus(r.state) == AgentDeckEink::StatusKind::Processing ? "Working. Waiting for the next result." : "Standing by.";
        drawParagraph(14, 128, W - 28, 23, windowCount > 2 ? 1 : 2, body, &FreeSans9pt7b);
    } else textAt(14, 110, "No active work", &FreeSansBold12pt7b);
    display.drawFastHLine(14, usageTop - 10, W - 28, GxEPD_BLACK);
    int16_t y = usageTop;
    auto window = [&](const char* label, float pct, const char* reset) {
        if (pct < 0) return;
        textAt(14, y + 14, label, &FreeSans9pt7b);
        display.drawRect(126, y + 2, 124, 12, GxEPD_BLACK);
        display.fillRect(128, y + 4, (int16_t)(120 * min(100.0f, max(0.0f, pct)) / 100.0f), 8, GxEPD_BLACK);
        char value[12]; snprintf(value, sizeof(value), "%d%%", (int)pct);
        textRight(306, y + 14, value, &FreeSans9pt7b);
        textRight(W - 14, y + 12, reset, CLASSIC_FONT);
        y += 23;
    };
    // Shared UsageRows groups (z.ai MCP, the Codex Luna reserve), then up to
    // two provider plans on one line. When the band cannot hold every window,
    // later providers give up their second window first — every provider
    // keeps at least its primary row rather than the last one vanishing.
    bool hasPlans = false;
    for (uint8_t g = 0; g < s.usageCount; g++) hasPlans |= s.usage[g].hasPlan();
    const int budget = (266 - usageTop) / 23 + 1 - (hasPlans ? 1 : 0);   // lines that start above y=266
    uint8_t shownRows[UsageRows::MAX_GROUPS];
    int rowsShown = 0;
    for (uint8_t g = 0; g < s.usageCount; g++) { shownRows[g] = s.usage[g].rowCount; rowsShown += shownRows[g]; }
    for (int g = s.usageCount - 1; g >= 0 && rowsShown > budget; --g)
        if (shownRows[g] > 1) { shownRows[g]--; rowsShown--; }
    for (uint8_t g = 0; g < s.usageCount; g++) {
        for (uint8_t r = 0; r < shownRows[g]; r++) {
            const auto& row = s.usage[g].rows[r];
            char label[24]; snprintf(label, sizeof(label), "%s %s", s.usage[g].name(), row.label);
            for (char* c = label + strlen(s.usage[g].name()); *c; ++c) *c = (char)toupper((unsigned char)*c);
            char reset[28]; snprintf(reset, sizeof(reset), "%s%s", row.left ? "left " : "", row.reset);
            window(label, (float)row.shown(), reset);
        }
    }
    if (!windowCount) { textAt(14, y + 12, "No usage limits", &FreeSans9pt7b); y += 23; }
    uint8_t planned = 0;
    for (uint8_t g = 0; g < s.usageCount && planned < 2 && y < 266; g++) {
        if (!s.usage[g].hasPlan()) continue;
        char plan[48], tail[32];
        UsageRows::planText(s.usage[g], tail, sizeof(tail), " ");
        snprintf(plan, sizeof(plan), "%s %s", s.usage[g].name(), tail);
        char fitted[48]; smartFitText(fitted, sizeof(fitted), plan, 176, &FreeSans9pt7b);
        smartTextAt(planned ? 210 : 14, y + 14, fitted, &FreeSans9pt7b);
        planned++;
    }
    if (planned) y += 23;
    if (s.tickerCount && y < 266) {
        char recent[116]; smartFitText(recent, sizeof(recent), s.tickerText[0], W - 28, &FreeSans9pt7b);
        smartTextAt(14, 285, recent, &FreeSans9pt7b);
    }
    return;
    }
#endif
    const int16_t top = W <= 420 ? 62 : 82;
    const int16_t pad = W <= 420 ? 12 : 22;
    const int16_t sideW = W <= 420 ? 104 : 190;
    uint8_t attention = 0, working = 0, quiet = 0;
    for (uint8_t i = 0; i < s.rowCount; i++) {
        switch (AgentDeckEink::classifyStatus(s.rows[i].state)) {
            case AgentDeckEink::StatusKind::Attention: attention++; break;
            case AgentDeckEink::StatusKind::Processing: working++; break;
            default: quiet++; break;
        }
    }
    display.drawFastVLine(sideW, top, H - top - pad, GxEPD_BLACK);
    const GFXfont* big = W <= 420 ? &FreeSansBold18pt7b : &FreeSansBold18pt7b;
    char n[8]; snprintf(n, sizeof(n), "%u", attention);
    {
        // The count is the action-bearing token on this face. A zero is context
        // and stays black; a non-zero is the reason to look up.
        InkScope ink(attention > 0 ? accentColor() : GxEPD_BLACK);
        textAt(pad, top + 36, n, big);
    }
    textAt(pad, top + 55, "NEEDS YOU", CLASSIC_FONT);
    snprintf(n, sizeof(n), "%u", working);
    textAt(pad, top + (W <= 420 ? 92 : 112), n, big);
    textAt(pad, top + (W <= 420 ? 111 : 131), "WORKING", CLASSIC_FONT);
    snprintf(n, sizeof(n), "%u", quiet);
    textAt(pad, top + (W <= 420 ? 148 : 190), n, big);
    textAt(pad, top + (W <= 420 ? 167 : 209), "QUIET", CLASSIC_FONT);

    const int i = primarySession(s);
    const int16_t x = sideW + (W <= 420 ? 14 : 24);
    const int16_t maxW = W - x - pad;
    if (i < 0) {
        textAt(x, top + 44, "Quiet paper.", big);
        drawParagraph(x, top + 76, maxW, 22, 3,
                      "No active sessions. The page will wake when AgentDeck has something durable to show.",
                      &FreeSans9pt7b);
    } else {
        const RowSnap& r = s.rows[i];
        char name[64]; smartFitText(name, sizeof(name), r.name[0] ? r.name : "AgentDeck", maxW, big);
        smartTextAt(x, top + 34, name, big);
        char state[20]; stateLabel(r.state, state, sizeof(state));
        const bool awaitingRow = isAwaiting(r.state);
        {
            InkScope ink(awaitingRow ? accentColor() : GxEPD_BLACK);
            textAt(x, top + 58, state, &FreeSansBold9pt7b);
        }
        const bool processingRow =
            AgentDeckEink::classifyStatus(r.state) == AgentDeckEink::StatusKind::Processing;
        const char* body = awaitingRow
            ? (r.question[0] ? r.question
#if defined(AGENTDECK_NM_UI)
                             : "Decision waiting. Press BOOT to open it.")
#else
                             : "Decision waiting. Use the primary control to open it.")
#endif
            : (r.work[0] ? r.work
                         : (r.activity[0] ? r.activity
                                          : (r.tool[0] ? r.tool
                                                       : (processingRow
                                                           ? "Work is in progress. This page waits for a durable result."
                                                           : "Standing by."))));
        drawParagraph(x, top + (W <= 420 ? 86 : 98), maxW,
                      W <= 420 ? 20 : 24, W <= 420 ? 4 : 4, body, &FreeSans9pt7b);
    }
    if (W > 600 && s.rowCount > 0) {
        const int16_t listY = H - 142;
        display.drawFastHLine(x, listY - 12, maxW, GxEPD_BLACK);
        textAt(x, listY, "ACTIVE THREADS", CLASSIC_FONT);
        const uint8_t shown = s.rowCount < 3 ? s.rowCount : 3;
        for (uint8_t row = 0; row < shown; row++) {
            const RowSnap& r = s.rows[row];
            const int16_t ry = listY + 27 + row * 27;
            char state[20]; stateLabel(r.state, state, sizeof(state));
            char left[64]; snprintf(left, sizeof(left), "%02u  %s", (unsigned)(row + 1), r.name);
            char fitted[68]; smartFitText(fitted, sizeof(fitted), left, maxW * 2 / 3, &FreeSans9pt7b);
            smartTextAt(x, ry, fitted, &FreeSans9pt7b);
            textRight(W - pad, ry, state, CLASSIC_FONT);
        }
    }
#if defined(AGENTDECK_NM_UI)
    // Usage adopts the TRMNL 7.5" footer grammar at 400px: brand GLYPH per
    // provider, one row per window the account actually exposes (the Stream
    // Deck dial rule, #269 — no empty frames), reset countdown inline beside
    // each gauge instead of a cryptic composite line below them. A provider
    // with no windows yields its rows entirely.
    constexpr int16_t usageY = 216;
    constexpr int16_t rowH = 15;
    constexpr int16_t glyphSize = 20;
    const int16_t gaugeX = x + glyphSize + 8;
    const int16_t gaugeW = 158;
    int16_t rowY = usageY;
    auto windowRow = [&](const char* tag, float pct, const char* reset) {
        drawMiniUsage(gaugeX, rowY, gaugeW, tag, pct, 16);
        if (reset && reset[0]) {
            InkScope ink(EINK_INK_MUTED);
            textAt(gaugeX + gaugeW + 8, rowY + 10, reset, CLASSIC_FONT);
        }
        rowY += rowH;
    };
    auto providerBlock = [&](const char* agentType, float five, const char* fiveR,
                             float seven, const char* sevenR) {
        const bool hasFive = five >= 0, hasSeven = seven >= 0;
        if (!hasFive && !hasSeven) return;
        drawAgentGlyph(agentType, x, rowY + 1, glyphSize);
        if (hasFive) windowRow("5H", five, fiveR);
        if (hasSeven) windowRow("7D", seven, sevenR);
        rowY += 4;
    };
    providerBlock("claude-code", s.fiveH, s.fiveReset, s.sevenD, s.sevenReset);
    providerBlock("codex-cli", s.codexP, s.codexPReset, s.codexS, s.codexSReset);
    // The glance stays key-legend-free: the RESET/USER/BOOT keys on the top
    // edge only matter on the decide face, which labels them.
#else
    const int16_t usageY = H - 38;
    const bool hasClaude = s.fiveH >= 0;
    const bool hasCodex = s.codexP >= 0;
    const int16_t uw = (W - x - pad - 12) / 2;
    if (hasClaude && hasCodex) {
        drawMiniUsage(x, usageY, uw, "Claude", s.fiveH, 46);
        drawMiniUsage(x + uw + 12, usageY, uw, "Codex", s.codexP, 46);
    } else if (hasClaude || hasCodex) {
        drawMiniUsage(x, usageY, W - x - pad, hasClaude ? "Claude" : "Codex",
                      hasClaude ? s.fiveH : s.codexP, 46);
    }
#endif
}

void drawDecisionFace(const Snap& s) {
#if defined(AGENTDECK_EPD47_UI)
    {
    drawEp47Chrome(s, epd47Page);
    const int i = primarySession(s, AgentDeckEink::StatusKind::Attention);
    constexpr int16_t pad = 28;
    display.fillRect(0, 86, 10, H - 86, GxEPD_BLACK);
    textAt(pad, 116, "DECISION", &FreeSansBold9pt7b);
    if (i < 0) {
        textAt(pad, 184, "Decision cleared.", &FreeSansBold18pt7b);
        return;
    }
    const RowSnap& r = s.rows[i];
    drawAgentGlyph(r.agentType, pad, 138, 56);
    smartTextAt(102, 170, r.name, &FreeSansBold12pt7b);
    drawParagraph(102, 208, W - 130, 30, 3,
                  r.question[0] ? r.question : "Agent is waiting for your decision.",
                  &FreeSansBold18pt7b);
    constexpr int16_t optionY = 298;
    constexpr int16_t optionH = 46;
    constexpr int16_t optionGap = 10;
    for (uint8_t o = 0; o < s.optionCount && o < 3; o++) {
        const int16_t y = optionY + o * (optionH + optionGap);
        const bool selected = !epd47TouchAvailable() && o == epd47DecisionSelection;
        if (selected) {
            display.fillRoundRect(pad, y, W - pad * 2, optionH, 6, GxEPD_BLACK);
            setInk(true);
        } else {
            display.drawRoundRect(pad, y, W - pad * 2, optionH, 6, GxEPD_BLACK);
        }
        // The numeric prefix exists so GPIO21's "tap next / hold confirm" cycle
        // can be counted out loud. With a touch controller the row itself is the
        // target and the number is noise.
        char option[64];
        if (epd47TouchAvailable()) snprintf(option, sizeof(option), "%s", s.options[o]);
        else snprintf(option, sizeof(option), "%u  %s", (unsigned)(o + 1), s.options[o]);
        char fitted[72]; smartFitText(fitted, sizeof(fitted), option, W - pad * 2 - 24,
                                      &FreeSansBold9pt7b);
        smartTextAt(pad + 12, y + 30, fitted, &FreeSansBold9pt7b);
        if (selected) setInk(false);
    }
    if (s.optionCount == 0) {
        textAt(pad, 326, "No device options. Respond on your computer.",
               &FreeSansBold12pt7b);
        textRight(W - pad, 472, "GPIO21 BACK", CLASSIC_FONT);
    } else if (epd47TouchAvailable()) {
        textRight(W - pad, 472, "TAP AN OPTION  ·  GPIO21 BACK", CLASSIC_FONT);
    } else {
        textRight(W - pad, 472, "GPIO21 TAP NEXT  ·  HOLD CONFIRM", CLASSIC_FONT);
    }
    return;
    }
#endif
    drawPaperHeader(s, PaperFace::Decision);
    const int i = primarySession(s, AgentDeckEink::StatusKind::Attention);
    const int16_t pad = W <= 420 ? 16 : 28;
    const int16_t top = W <= 420 ? 70 : 90;
    display.fillRect(0, top, W <= 420 ? 8 : 12, H - top, accentColor());
    if (i < 0) {
        textAt(pad, top + 40, "Decision cleared.", &FreeSansBold18pt7b);
        return;
    }
    const RowSnap& r = s.rows[i];
    smartTextAt(pad, top + 20, r.name, &FreeSansBold9pt7b);
    const int questionLines = W <= 420 ? 3 : 5;
    int used = drawParagraph(pad, top + (W <= 420 ? 50 : 62), W - pad * 2,
                             W <= 420 ? 24 : 30, questionLines,
                             r.question[0] ? r.question : "Agent is waiting for your decision.",
                             W <= 420 ? &FreeSansBold12pt7b : &FreeSansBold18pt7b);
    int16_t oy = top + (W <= 420 ? 62 : 78) + used * (W <= 420 ? 24 : 30);
    for (uint8_t o = 0; o < s.optionCount && o < 3 && oy < H - 48; o++) {
        const int16_t oh = W <= 420 ? 31 : 42;
        // Keep red geometry fixed across DECISION content so option text can
        // update through the panel's B/W differential waveform.
#if defined(AGENTDECK_NM_UI) || defined(AGENTDECK_TRMNL_75_UI)
#if defined(AGENTDECK_NM_UI)
        const bool selected = o == nmDecisionSelection;
#else
        const bool selected = o == inkDecisionSelection;
#endif
        if (selected) {
            display.fillRoundRect(pad, oy, W - pad * 2, oh, 5, GxEPD_BLACK);
            setInk(true);
        } else {
            display.drawRoundRect(pad, oy, W - pad * 2, oh, 5, GxEPD_BLACK);
        }
#else
        display.drawRoundRect(pad, oy, W - pad * 2, oh, 5, GxEPD_BLACK);
#endif
        char option[56]; snprintf(option, sizeof(option), "%u  %s", (unsigned)(o + 1), s.options[o]);
        char fitted[64]; smartFitText(fitted, sizeof(fitted), option, W - pad * 2 - 20, &FreeSans9pt7b);
        smartTextAt(pad + 10, oy + (W <= 420 ? 21 : 28), fitted, &FreeSans9pt7b);
#if defined(AGENTDECK_NM_UI) || defined(AGENTDECK_TRMNL_75_UI)
        if (selected) setInk(false);
#endif
        oy += oh + 7;
    }
#if defined(AGENTDECK_NM_UI)
    display.drawFastHLine(pad, H - 29, W - pad * 2, GxEPD_BLACK);
    // The unit does have RESET/USER/BOOT keys on its top edge. Chrome earns
    // space only where it changes what the user does RIGHT NOW: on this face
    // the keys are the answer path, so the legend returns here — and only
    // here. The ambient glance stays unlabeled.
    if (s.optionCount > 0) {
        textAt(pad, H - 10, "BOOT  NEXT", CLASSIC_FONT);
        textRight(W - pad, H - 10, "USER  CONFIRM", CLASSIC_FONT);
    } else {
        textAt(pad, H - 10, "RESPOND ON COMPUTER OR DECK", CLASSIC_FONT);
    }
#elif defined(AGENTDECK_TRMNL_75_UI)
    display.drawFastHLine(pad, H - 34, W - pad * 2, GxEPD_BLACK);
    if (s.optionCount > 0) {
        textAt(pad, H - 12, "KEY1  NEXT", &FreeSansBold9pt7b);
        textRight(W - pad, H - 12, "KEY2  CONFIRM", &FreeSansBold9pt7b);
    } else {
        textAt(pad, H - 12, "RESPOND ON YOUR COMPUTER", &FreeSansBold9pt7b);
        textRight(W - pad, H - 12, "KEY2  HOME", &FreeSansBold9pt7b);
    }
#endif
}

void drawAnswerFace(const Snap& s) {
    drawPaperHeader(s, PaperFace::Answer);
    int i = primarySession(s, AgentDeckEink::StatusKind::Idle);
    if (i < 0) i = primarySession(s);
    const int16_t pad = W <= 420 ? 16 : 30;
    const int16_t top = W <= 420 ? 72 : 94;
    if (i < 0) { textAt(pad, top + 40, "No answer yet.", &FreeSansBold18pt7b); return; }
    const RowSnap& r = s.rows[i];
    drawAgentGlyph(r.agentType, pad, top, W <= 420 ? 44 : 72);
    smartTextAt(pad + (W <= 420 ? 58 : 92), top + 28, r.name, &FreeSansBold12pt7b);
    display.drawFastHLine(pad, top + (W <= 420 ? 58 : 82), W - pad * 2, GxEPD_BLACK);
    const char* body = r.work[0] ? r.work : "The session is quiet. Its next durable result will appear here.";
    drawParagraph(pad, top + (W <= 420 ? 90 : 124), W - pad * 2,
                  W <= 420 ? 23 : 29, W <= 420 ? 5 : 9, body,
                  W <= 420 ? &FreeSans9pt7b : &FreeSansBold12pt7b);
    if (r.model[0]) textRight(W - pad, H - 15, r.model, CLASSIC_FONT);
}

void drawDigestFace(const Snap& s) {
    drawPaperHeader(s, PaperFace::Digest);
    const int16_t pad = W <= 420 ? 14 : 24;
    const int16_t top = W <= 420 ? 62 : 82;
    const int rows = W <= 420 ? 3 : 4;
    const int16_t rowH = (H - top - pad) / rows;
    for (int row = 0; row < rows; row++) {
        const char* time = "";
        const char* body = "No further durable activity.";
        if (row < s.tickerCount) {
            time = s.tickerTime[row]; body = s.tickerText[row];
        } else {
            int si = row - s.tickerCount;
            if (si < s.rowCount) body = s.rows[si].work[0] ? s.rows[si].work : s.rows[si].name;
        }
        const int16_t y = top + row * rowH;
        char idx[6]; snprintf(idx, sizeof(idx), "%02d", row + 1);
        textAt(pad, y + 24, idx, &FreeSansBold12pt7b);
        if (time[0]) textAt(pad, y + 43, time, CLASSIC_FONT);
        drawParagraph(pad + (W <= 420 ? 50 : 72), y + 22,
                      W - pad * 2 - (W <= 420 ? 50 : 72),
                      W <= 420 ? 18 : 22, W <= 420 ? 2 : 3, body, &FreeSans9pt7b);
        if (row < rows - 1) display.drawFastHLine(pad, y + rowH - 1, W - pad * 2, GxEPD_BLACK);
    }
}

#if defined(AGENTDECK_TRMNL_75_UI)
void drawAquariumFace(const Snap& s) {
    // 38,400 bytes in flash, no decode buffer and no render-loop allocation.
    display.drawBitmap(0, 0, PAPER_AQUARIUM, 800, 384, GxEPD_BLACK);
    display.drawFastHLine(16, 386, W - 32, GxEPD_BLACK);
    uint8_t working = 0, attention = 0;
    for (uint8_t i = 0; i < s.rowCount; i++) {
        const auto kind = AgentDeckEink::classifyStatus(s.rows[i].state);
        if (kind == AgentDeckEink::StatusKind::Processing) working++;
        if (kind == AgentDeckEink::StatusKind::Attention) attention++;
    }
    char summary[88];
    if (s.bridgeConnected) snprintf(summary, sizeof(summary), "%u SESSIONS   %u WORKING   %u NEED YOU",
        s.totalSessions, working, attention);
    else snprintf(summary, sizeof(summary), "OFFLINE  -  RECONNECTING");
    textAt(16, 405, summary, CLASSIC_FONT);
    textRight(W - 16, 405, "AQUARIUM", CLASSIC_FONT);
    const bool known = s.bridgeConnected && !s.usageStale;
    const int16_t stride = (W - 32) / 3;
    drawMiniUsage(16, 418, stride - 14, "Claude 5h", known ? s.fiveH : -1, 62);
    drawMiniUsage(16, 437, stride - 14, "7d", known ? s.sevenD : -1, 62);
    drawMiniUsage(16 + stride, 418, stride - 14, "Codex 5h", known ? s.codexP : -1, 62);
    drawMiniUsage(16 + stride, 437, stride - 14, "7d", known ? s.codexS : -1, 62);
    drawMiniUsage(16 + stride * 2, 418, stride - 14, "GLM 5h", known ? s.zaiP : -1, 62);
    drawMiniUsage(16 + stride * 2, 437, stride - 14, s.zaiIsMcp ? "MCP" : "7d", known ? s.zaiS : -1, 62);
    textAt(16, H - 9, "KEY1 NEXT   KEY2 HOME", CLASSIC_FONT);
    textRight(W - 16, H - 9, known ? "QUIET UPDATES / URGENT ALERTS" : "USAGE UNAVAILABLE", CLASSIC_FONT);
}
#endif

void drawSearching(const Snap& s) {
    display.fillScreen(GxEPD_WHITE);
    display.setTextColor(GxEPD_BLACK);
    setInk(false);
#if defined(AGENTDECK_EPD47_UI)
    {
    drawEp47Chrome(s, AgentDeckEpd47::Page::Limits);
    drawAgentDeckMark(W / 2 - 48, 142, 96);
    const char* title = "OFFLINE";
    textAt(W / 2 - textWidth(title, &FreeSansBold18pt7b) / 2,
           302, title, &FreeSansBold18pt7b);
    const char* msg = s.wifiUp || s.serialUp ? "SEARCHING FOR AGENTDECK"
                                             : "CONNECT USB OR PROVISION WIFI";
    textAt(W / 2 - textWidth(msg, &FreeSans9pt7b) / 2, 342, msg, &FreeSans9pt7b);
    if (s.wifiUp && s.ip[0]) {
        char line[64]; snprintf(line, sizeof(line), "PANEL %s  ·  mDNS _agentdeck._tcp", s.ip);
        textAt(W / 2 - textWidth(line, CLASSIC_FONT) / 2, 372, line, CLASSIC_FONT);
    }
    display.drawFastHLine(20, 478, W - 40, GxEPD_BLACK);
    textAt(20, 512, "PAPER HOLDS THIS STATE WITHOUT DISPLAY POWER", &FreeSansBold9pt7b);
    char tag[64]; snprintf(tag, sizeof(tag), "v%s %.7s", FIRMWARE_VERSION, GIT_SHA);
    textRight(W - 20, 512, tag, &FreeSans9pt7b);
    return;
    }
#endif
#if defined(AGENTDECK_NM_UI)
    {
    constexpr int16_t pad = 14;
    display.fillRect(0, 0, W, 7, accentColor());
    drawAgentDeckMark(pad, 13, 30);
    textAt(54, 38, "AgentDeck", &FreeSansBold12pt7b);
    textRight(W - pad, 35, "OFFLINE", CLASSIC_FONT);
    display.drawFastHLine(pad, 49, W - pad * 2, GxEPD_BLACK);

    drawAgentDeckMark(W / 2 - 31, 82, 62);
    const char* title = "OFFLINE";
    textAt(W / 2 - textWidth(title, &FreeSansBold18pt7b) / 2,
           181, title, &FreeSansBold18pt7b);
    const char* msg = s.wifiUp || s.serialUp ? "AGENTDECK NOT FOUND"
                                             : "CONNECT USB OR WIFI";
    textAt(W / 2 - textWidth(msg, &FreeSans9pt7b) / 2, 210, msg, &FreeSans9pt7b);
    if (s.wifiUp && s.ip[0]) {
        char line[48]; snprintf(line, sizeof(line), "PANEL %s", s.ip);
        textAt(W / 2 - textWidth(line, CLASSIC_FONT) / 2, 230, line, CLASSIC_FONT);
    }
    display.drawFastHLine(pad, H - 39, W - pad * 2, GxEPD_BLACK);
    const char* reconnect = "AUTO RECONNECTING";
    textAt(W / 2 - textWidth(reconnect, CLASSIC_FONT) / 2,
           H - 18, reconnect, CLASSIC_FONT);
    return;
    }
#endif
    const AgentDeckEink::Layout layout = dashboardLayout(s);
    drawBrandHeader(s, layout);
    const int16_t centerY = layout.cards.y + layout.cards.h / 2;
    drawAgentDeckMark(W / 2 - 44, centerY - 88, 88);
    // The panel holds this image without power, so make the terminal state the
    // primary line and keep the active retry phase as quiet supporting copy.
    // "no active sessions" remains a distinct live-daemon empty state.
    const char* title = "OFFLINE";
    textAt(W / 2 - textWidth(title, &FreeSansBold18pt7b) / 2,
           centerY + 42, title, &FreeSansBold18pt7b);
    const char* msg = s.wifiUp || s.serialUp ? "Searching for AgentDeck..."
                                             : "No WiFi · connect USB or provision WiFi";
    textAt(W / 2 - textWidth(msg, &FreeSans9pt7b) / 2, centerY + 70, msg, &FreeSans9pt7b);
    if (s.wifiUp && s.ip[0]) {
        char line[64]; snprintf(line, sizeof(line), "panel %s · auto reconnecting", s.ip);
        textAt(W / 2 - textWidth(line, CLASSIC_FONT) / 2, centerY + 94, line, CLASSIC_FONT);
    }
    // Usage is cached data at this point. Hiding it is safer than presenting
    // stale subscription limits as if they were still live.
    display.drawFastHLine(layout.pad, H - 42, W - layout.pad * 2, GxEPD_BLACK);
    textAt(layout.pad, H - 16, "AUTO RECONNECT", &FreeSansBold9pt7b);
    char tag[64]; snprintf(tag, sizeof(tag), "v%s %.7s", FIRMWARE_VERSION, GIT_SHA);
    textRight(W - layout.pad, H - 16, tag, &FreeSans9pt7b);
}

void drawDashboard(const Snap& s) {
    display.fillScreen(GxEPD_WHITE);
    display.setTextColor(GxEPD_BLACK);
    setInk(false);
    switch (renderFace) {
#if defined(AGENTDECK_TRMNL_75_UI)
        case PaperFace::Aquarium: drawAquariumFace(s); break;
#endif
        case PaperFace::Decision: drawDecisionFace(s); break;
        case PaperFace::Answer:   drawAnswerFace(s); break;
        case PaperFace::Digest:   drawDigestFace(s); break;
        case PaperFace::Roster: {
            const AgentDeckEink::Layout layout = dashboardLayout(s);
            drawBrandHeader(s, layout);
            drawSessionGrid(s, layout);
            drawUsageFooter(s, false, layout);
            break;
        }
        default:
#if defined(AGENTDECK_EPD47_UI)
            drawEp47Glance(s);
#elif defined(BOARD_TRMNL_75) && !defined(BOARD_SIM_PULL)
            // TRMNL 7.5"'s home is the live board itself. GLANCE is only the
            // arbitration name; restoring the proven session-grid hierarchy
            // keeps active work and provider limits visible together.
            {
            const AgentDeckEink::Layout layout = dashboardLayout(s);
            drawBrandHeader(s, layout);
            drawSessionGrid(s, layout);
            drawUsageFooter(s, false, layout);
            }
#else
            drawGlanceFace(s);
#endif
            break;
    }
    // NOTE: no Serial logging here — this runs on Core 1 while Core 0 emits
    // protocol JSON lines (device_info replies, acks). Cross-core prints
    // interleave mid-line and corrupt the newline-framed JSON the daemon
    // parses (observed: device_info replies mangled → daemon kept showing a
    // stale buildHash). Keep render-path logging out of the firmware.
}

// ===== Refresh engine =====

uint32_t lastHash = 0;
uint32_t lastDrawMs = 0;
#if defined(BOARD_LILYGO_EPD47)
AgentDeckEpd47::RefreshState epd47RefreshState;
#else
uint32_t lastFullMs = 0;
uint8_t partialCount = 0;
#endif
bool firstDraw = true;
bool forceFull = false;
bool forceRefresh = false;  // immediate repaint without forcing a hard clear
bool wasSearching = true;
char lastTickerShown[104] = "";
uint32_t repaintCountValue = 0;
uint32_t fullRefreshCountValue = 0;
// Single producer (render task), single consumer (network task). Fixed storage
// keeps diagnostics off the heap and prevents cross-core Serial/JSON writes.
struct RefreshCompletion { uint32_t count, full, startedMs, durationMs; };
RefreshCompletion refreshCompletions[4]{};
uint32_t refreshWrite = 0;
uint32_t refreshRead = 0;

bool key1Prev = true, key2Prev = true;
uint32_t keyLastMs = 0;

void refresh(void (*draw)(const Snap&), const Snap& s, bool full,
             AgentDeckEpd47::Erase erase = AgentDeckEpd47::Erase::ClearAll) {
    const uint32_t refreshStartedMs = millis();
    bool actualFull = full;
    // Count at the one choke point that performs physical panel I/O, not at
    // render requests (most of which content-hash/rate gates intentionally
    // discard). Relaxed atomics keep device_info reads race-free across the
    // network and UI tasks without putting a lock around a multi-second draw.
    __atomic_add_fetch(&repaintCountValue, 1u, __ATOMIC_RELAXED);
#if defined(BOARD_LILYGO_EPD47)
    // If the optional retained frame allocation failed, degrade every update
    // to the safe hard-clear path. Record the mode that physically ran, not the
    // requested one, so the anti-ghost schedule and telemetry stay truthful.
    const AgentDeckEpd47::Erase mode = display.prev()
        ? erase : AgentDeckEpd47::Erase::ClearAll;
    const bool hardClear = AgentDeckEpd47::isHardClear(mode);
    actualFull = hardClear;
    if (hardClear)
        __atomic_add_fetch(&fullRefreshCountValue, 1u, __ATOMIC_RELAXED);
    display.fillScreen(GxEPD_WHITE);
    draw(s);
    epd_poweron();
    const LilyEpdRect fullArea{0, 0, SCREEN_W, SCREEN_H};
    // epd_draw_grayscale_image() does not erase prior ink and explicitly
    // requires a white surface. Therefore EVERY replacement first removes the
    // retained frame. Only the scheduled anti-ghost modes use a hard waveform.
    switch (mode) {
        case AgentDeckEpd47::Erase::Differential:
            epd_draw_image(fullArea, display.prev(), 1 << 1);  // WHITE_ON_WHITE
            break;
        default:
            epd_clear();
            display.forgetFrame();
            break;
    }
    epd_draw_grayscale_image(fullArea, display.pixels());
    display.retainFrame();
    AgentDeckEpd47::recordErase(epd47RefreshState, mode, millis());
    epd_poweroff();
#else
#if defined(BOARD_NM_EPD_420)
    // hasPartialUpdate on this driver means partial RAM addressing, not a safe
    // physical partial waveform for the installed tri-color glass. Never call
    // refresh_bw(): every admitted NM repaint is a stock full-color cycle.
    full = true;
#endif
    actualFull = full;
    if (full) __atomic_add_fetch(&fullRefreshCountValue, 1u, __ATOMIC_RELAXED);
    if (full) {
        display.setFullWindow();
        partialCount = 0;
        lastFullMs = millis();
    } else {
#if defined(AGENTDECK_TRMNL_75_UI)
        if (renderFace == PaperFace::Aquarium && lastPaintedFace == PaperFace::Aquarium)
            display.setPartialWindow(0, 384, display.width(), display.height() - 384);
        else
#endif
            display.setPartialWindow(0, 0, display.width(), display.height());
        partialCount++;
    }
    display.firstPage();
    do { draw(s); } while (display.nextPage());
    // powerOff (NOT hibernate): high voltage off, controller previous-frame
    // RAM retained so the next partial refresh diffs cleanly. See note above.
    display.powerOff();
#endif
    const uint32_t write = __atomic_load_n(&refreshWrite, __ATOMIC_RELAXED);
    const uint32_t read = __atomic_load_n(&refreshRead, __ATOMIC_ACQUIRE);
    // Drop diagnostics if the consumer stalls; count gaps invalidate intervals.
    if ((uint32_t)(write - read) < 4u) {
        refreshCompletions[write % 4u] = {
            __atomic_load_n(&repaintCountValue, __ATOMIC_RELAXED),
            uint32_t(actualFull), refreshStartedMs,
            uint32_t(millis() - refreshStartedMs)};
        __atomic_store_n(&refreshWrite, write + 1u, __ATOMIC_RELEASE);
    }
}

}  // namespace


void Eink::logRefreshCompletions() {
    for (unsigned n = 0; n < 4; ++n) {
        const uint32_t read = __atomic_load_n(&refreshRead, __ATOMIC_RELAXED);
        if (read == __atomic_load_n(&refreshWrite, __ATOMIC_ACQUIRE)) break;
        const RefreshCompletion event = refreshCompletions[read % 4u];
        __atomic_store_n(&refreshRead, read + 1u, __ATOMIC_RELEASE);
        // Network task owns both this output and serial protocol JSON lines.
        Serial.printf("[EinkRefresh] count=%lu full=%lu startedMs=%lu durationMs=%lu\n",
            (unsigned long)event.count, (unsigned long)event.full,
            (unsigned long)event.startedMs, (unsigned long)event.durationMs);
    }
}

namespace Eink {

uint32_t repaintCount() {
    return __atomic_load_n(&repaintCountValue, __ATOMIC_RELAXED);
}

uint32_t fullRefreshCount() {
    return __atomic_load_n(&fullRefreshCountValue, __ATOMIC_RELAXED);
}

void init() {
    pinMode(PIN_KEY1, INPUT_PULLUP);
    if (PIN_KEY2 != PIN_KEY1) pinMode(PIN_KEY2, INPUT_PULLUP);
#if defined(BOARD_LILYGO_EPD47)
    if (!display.begin()) {
        while (true) vTaskDelay(pdMS_TO_TICKS(1000));
    }
    epd_init();
    display.setRotation(BOARD_EINK_ROTATION);
    u8f.begin(display);
    Serial.printf("[Eink] LilyGo ED047TC2 init %dx%d, PSRAM framebuffer=%u bytes\n",
                  display.width(), display.height(), (unsigned)(SCREEN_W * SCREEN_H / 2));
#else
    SPI.begin(PIN_EPD_SCK, -1, PIN_EPD_MOSI, PIN_EPD_CS);
    // serial_diag_bitrate MUST stay 0: GxEPD2's diagnostics print _PowerOn/
    // _Update_* timing lines from THIS core (Core 1) on every refresh, which
    // interleaves with Core 0's protocol JSON on the shared USB CDC and
    // corrupts newline-framed replies (observed: mangled device_info + inbound
    // parse failures from the TX congestion).
    display.init(0, true, 2, false);
    display.setRotation(BOARD_EINK_ROTATION);
    u8f.begin(display);  // UTF-8/한글 text path (unifont) on the same canvas
    Serial.printf("[Eink] %s init %dx%d, partial=%d\n",
#if defined(AGENTDECK_NM_UI)
                  "GDEY042Z98",
#else
                  "GDEY075T7",
#endif
                  display.width(), display.height(),
                  (int)
                  display.epd2.hasFastPartialUpdate
                  );
#endif
    // static: Snap grew past 5KB (10 rows × work[152] + the multi-row strip)
    // — too big for the loop-task stack alongside the GxEPD2 page render.
    // init() and render() run on the same Core 1 loop task, so one static
    // scratch Snap is race-free.
    static Snap s; snapshot(s);
#if defined(AGENTDECK_EPD47_UI)
    epd47Page = epd47AutomaticPage(s);
#endif
    const bool initialSearching = !s.bridgeConnected;
    renderFace = initialSearching ? PaperFace::Roster : PaperFace::Glance;
#if defined(BOARD_NM_EPD_420)
    // Recondition both pigment planes after any prior experimental B/W cycle.
    // The extended stock color waveform writes the complete intended frame;
    // subsequent repaints use the normal fast full-color waveform only.
    display.epd2.selectFastFullUpdate(false);
#endif
    refresh(initialSearching ? drawSearching : drawDashboard, s, true);
#if defined(AGENTDECK_EPD47_UI)
    lastPhysicalEpd47Page = epd47Page;
    physicalEpd47PageReady = true;
#endif
#if defined(BOARD_LILYGO_EPD47)
    // Keep the shipped demo's conservative cold-start order: the first
    // epd_poweron -> clear/draw -> epd_poweroff cycle finishes before the
    // external touch header is probed. LilyGo's standalone touch example can
    // also probe earlier, but the complete demo gives attached controllers
    // the longest settle window without keeping panel high voltage enabled.
    Input::touchInit();
    logHeap("lily-epd-touch");
#endif
#if defined(BOARD_NM_EPD_420)
    // Keep the stock full-colour waveform. The driver's fast-full LUT forces a
    // synthetic high-temperature profile; on the on-hand GDEY042Z98 that makes
    // red weak and muddy. Refreshes are now coalesced at an ambient cadence, so
    // pigment fidelity is worth the slower admitted cycle.
    display.epd2.selectFastFullUpdate(false);
    lastPhysicalFace = renderFace;
    for (uint8_t i = 0; i < s.rowCount; i++) {
        const auto kind = AgentDeckEink::classifyStatus(s.rows[i].state);
        if (kind == AgentDeckEink::StatusKind::Attention) lastPhysicalAttention++;
        else if (kind == AgentDeckEink::StatusKind::Processing) lastPhysicalWorking++;
    }
    physicalFaceReady = true;
#endif
    wasSearching = initialSearching;
    // init() is once-per-boot on hardware, but the host simulator reuses this
    // translation unit across multiple named scenes. The searching frame above
    // replaces the framebuffer, so invalidate the prior scene hash even when
    // the next scene differs only in hostDisplayOn (intentionally un-hashed).
    lastHash = 0;
    lastTickerShown[0] = '\0';
    firstDraw = false;
    lastDrawMs = millis();
}

void update(float /*dt*/) {
    uint32_t now = millis();
    bool k1 = digitalRead(PIN_KEY1);
    bool k2 = PIN_KEY2 == PIN_KEY1 ? k1 : digitalRead(PIN_KEY2);
    const bool key1Pressed = key1Prev && !k1;
    const bool key2Pressed = key2Prev && !k2;
    const bool key1Released = !key1Prev && k1;
#if defined(BOARD_LILYGO_EPD47)
    if (key1Released && epd47DecisionButtonTracking) {
        const uint32_t heldMs = now - epd47DecisionButtonDownMs;
        epd47DecisionButtonTracking = false;
        static Snap decisionSnap;
        snapshot(decisionSnap);
        if (renderFace == PaperFace::Glance && !Input::touchReady()) {
            if (epd47Page == AgentDeckEpd47::Page::Focus && heldMs >= 850 &&
                decisionSnap.optionCount > 0 && primarySession(decisionSnap, AgentDeckEink::StatusKind::Attention) >= 0 &&
                (!epd47FocusedId[0] || strcmp(epd47FocusedId, decisionSnap.rows[primarySession(decisionSnap, AgentDeckEink::StatusKind::Attention)].id) == 0)) {
                manualFace = PaperFace::Decision;
            } else if (epd47Page != AgentDeckEpd47::Page::Home) epd47Page = AgentDeckEpd47::Page::Home;
            else if (heldMs >= 850) {
                epd47FocusedId[0] = '\0';
                epd47Page = epd47HomeSelection == 0 ? AgentDeckEpd47::Page::Focus :
                    epd47HomeSelection == 1 ? AgentDeckEpd47::Page::Queue : AgentDeckEpd47::Page::Limits;
            } else epd47HomeSelection = (epd47HomeSelection + 1) % 3;
            epd47PageHoldUntilMs = now + FACE_HOLD_MS;
            faceHoldUntilMs = now + FACE_HOLD_MS;
            interactiveLeaseUntilMs = now + FACE_HOLD_MS;
            forceRefresh = true;
            lastHash = 0;
        } else if (renderFace == PaperFace::Decision && !Input::touchReady()) {
            if (decisionSnap.optionCount == 0) {
                suppressedDecisionHash = lastDecisionHash;
                manualFace = PaperFace::Glance;
                interactiveLeaseUntilMs = 0;
                forceFull = true;
            } else if (heldMs >= 850) {
                if (sendDecisionSelection(decisionSnap, epd47DecisionSelection)) {
                    suppressedDecisionHash = lastDecisionHash;
                    manualFace = PaperFace::Glance;
                    faceHoldUntilMs = 0;
                    interactiveLeaseUntilMs = 0;
                    epd47Page = epd47AutomaticPage(decisionSnap);
                    epd47PageHoldUntilMs = now + FACE_HOLD_MS;
                    forceFull = true;
                }
            } else {
                epd47DecisionSelection =
                    (uint8_t)((epd47DecisionSelection + 1) % decisionSnap.optionCount);
                faceHoldUntilMs = now + FACE_HOLD_MS;
                interactiveLeaseUntilMs = now + FACE_HOLD_MS;
                forceRefresh = true;
            }
            lastHash = 0;
        }
    }
#endif
    if ((key1Pressed || key2Pressed) && now - keyLastMs > 300) {
        keyLastMs = now;
        bool keyHandled = false;
        bool keepEpd47PageHold = false;
        bool refreshAfterPress = true;
#if defined(BOARD_LILYGO_EPD47)
        if (key1Pressed && (renderFace == PaperFace::Decision || renderFace == PaperFace::Glance) && !Input::touchReady()) {
            // In button-only mode selection happens on release so a long hold
            // can confirm without also advancing the highlighted option.
            epd47DecisionButtonDownMs = now;
            epd47DecisionButtonTracking = true;
            keyHandled = true;
            refreshAfterPress = false;
        }
#endif
#if defined(BOARD_NM_EPD_420)
        if (!keyHandled && renderFace == PaperFace::Decision && lastDecisionHash != 0) {
            static Snap decisionSnap;
            snapshot(decisionSnap);
            if (key1Pressed && decisionSnap.optionCount > 0) {
                nmDecisionSelection = (uint8_t)((nmDecisionSelection + 1) % decisionSnap.optionCount);
                faceHoldUntilMs = now + FACE_HOLD_MS;
                interactiveLeaseUntilMs = now + FACE_HOLD_MS;
                keyHandled = true;
            } else if (key2Pressed) {
                if (decisionSnap.optionCount > 0) {
                    sendDecisionSelection(decisionSnap, nmDecisionSelection);
                }
                suppressedDecisionHash = lastDecisionHash;
                manualFace = PaperFace::Glance;
                faceHoldUntilMs = 0;
                interactiveLeaseUntilMs = 0;
                keyHandled = true;
            }
        }
#endif
#if defined(AGENTDECK_TRMNL_75_UI)
        if (!keyHandled && renderFace == PaperFace::Decision && lastDecisionHash != 0) {
            static Snap decisionSnap;
            snapshot(decisionSnap);
            if (key1Pressed && decisionSnap.optionCount > 0) {
                inkDecisionSelection =
                    (uint8_t)((inkDecisionSelection + 1) % decisionSnap.optionCount);
                faceHoldUntilMs = now + FACE_HOLD_MS;
                keyHandled = true;
            } else if (key2Pressed) {
                if (decisionSnap.optionCount > 0) {
                    sendDecisionSelection(decisionSnap, inkDecisionSelection);
                }
                suppressedDecisionHash = lastDecisionHash;
                manualFace = PaperFace::Glance;
                faceHoldUntilMs = 0;
                keyHandled = true;
            }
        }
#endif
        if (!keyHandled) {
        if (PIN_KEY2 != PIN_KEY1 && key2Pressed) {
            // The same physical escape action from every face. A still-open
            // decision stays suppressed only for this exact question hash; a
            // new question immediately preempts GLANCE again.
            if (renderFace == PaperFace::Decision) suppressedDecisionHash = lastDecisionHash;
            manualFace = PaperFace::Glance;
            faceHoldUntilMs = 0;
            interactiveLeaseUntilMs = 0;
        } else {
#if defined(BOARD_TRMNL_75) && !defined(BOARD_SIM_PULL)
            switch (manualFace) {
                case PaperFace::Glance: manualFace = PaperFace::Aquarium; break;
                case PaperFace::Aquarium: manualFace = PaperFace::Digest; break;
                case PaperFace::Digest: manualFace = PaperFace::Answer; break;
                case PaperFace::Answer: manualFace = PaperFace::Roster; break;
                default: manualFace = PaperFace::Glance; break;
            }
#else
            // A physical action opens the bounded pull-device lease. On an
            // EPD47 whose touch controller is unavailable, the user key also
            // becomes a deterministic tab-cycle fallback.
#if defined(BOARD_LILYGO_EPD47)
            if (!Input::touchReady() && renderFace == PaperFace::Glance) {
                const uint8_t next = ((uint8_t)epd47Page + 1u) % 4u;
                epd47Page = static_cast<AgentDeckEpd47::Page>(next);
                epd47PageHoldUntilMs = now + FACE_HOLD_MS;
                manualFace = PaperFace::Glance;
                interactiveLeaseUntilMs = now + FACE_HOLD_MS;
                keepEpd47PageHold = true;
            } else {
                if (renderFace == PaperFace::Decision) suppressedDecisionHash = lastDecisionHash;
                manualFace = PaperFace::Glance;
                interactiveLeaseUntilMs = 0;
            }
#else
            if (PIN_KEY1 == PIN_KEY2) {
                if (renderFace == PaperFace::Decision) suppressedDecisionHash = lastDecisionHash;
                if (renderFace == PaperFace::Glance) {
                    manualFace = PaperFace::Digest;
                    interactiveLeaseUntilMs = now + FACE_HOLD_MS;
                } else {
                    manualFace = PaperFace::Glance;
                    interactiveLeaseUntilMs = 0;
                }
            } else {
                manualFace = renderFace == PaperFace::Glance
                    ? PaperFace::Digest : PaperFace::Glance;
                interactiveLeaseUntilMs = now + FACE_HOLD_MS;
            }
#endif
#endif
            faceHoldUntilMs = manualFace == PaperFace::Glance ? 0 : now + FACE_HOLD_MS;
        }
        }
        if (refreshAfterPress) {
            forceFull = true;
            lastHash = 0;  // force redraw even if content unchanged
        }
#if defined(AGENTDECK_EPD47_UI)
        if (refreshAfterPress && !keepEpd47PageHold) epd47PageHoldUntilMs = 0;
#endif
    }
    key1Prev = k1; key2Prev = k2;

#if defined(BOARD_LILYGO_EPD47)
    const Input::TouchEvent touch = Input::touchPoll(now);
    if (touch.gesture == Input::TouchGesture::TAP) {
        static Snap touchSnap;
        snapshot(touchSnap);
        bool handled = false;

        if (renderFace == PaperFace::Decision &&
            touch.x >= 28 && touch.x < W - 28 && touch.y >= 298) {
            constexpr int16_t optionH = 46;
            constexpr int16_t stride = 56;
            const int index = (touch.y - 298) / stride;
            const int offset = (touch.y - 298) % stride;
            const int awaiting = primarySession(touchSnap, AgentDeckEink::StatusKind::Attention);
            if (index >= 0 && index < touchSnap.optionCount && offset < optionH && awaiting >= 0) {
                if (!sendDecisionSelection(touchSnap, (uint8_t)index)) return;
                suppressedDecisionHash = decisionHash(touchSnap);
                epd47Page = epd47AutomaticPage(touchSnap);
                epd47PageHoldUntilMs = now + FACE_HOLD_MS;
                manualFace = PaperFace::Glance;
                faceHoldUntilMs = now + FACE_HOLD_MS;
                interactiveLeaseUntilMs = now + FACE_HOLD_MS;
                handled = true;
            }
        }

        if (!handled && touch.y >= 14 && touch.y <= 62 &&
            touch.x >= EPD47_TAB_X && touch.x < EPD47_TAB_X + EPD47_TAB_W) {
            epd47Page = epd47Page == AgentDeckEpd47::Page::Home && renderFace == PaperFace::Glance
                ? AgentDeckEpd47::Page::Limits : AgentDeckEpd47::Page::Home;
            if (renderFace == PaperFace::Decision) suppressedDecisionHash = lastDecisionHash;
            manualFace = PaperFace::Glance;
            handled = true;
        } else if (!handled && renderFace == PaperFace::Glance &&
                   epd47Page == AgentDeckEpd47::Page::Home && touch.y > 86 && touch.y < 520) {
            epd47Page = touch.x >= 562 ? AgentDeckEpd47::Page::Queue :
                (touch.y >= 470 ? AgentDeckEpd47::Page::Queue : AgentDeckEpd47::Page::Focus);
            epd47FocusedId[0] = '\0';
            manualFace = PaperFace::Glance;
            handled = true;
        } else if (!handled && renderFace == PaperFace::Glance &&
                   epd47Page == AgentDeckEpd47::Page::Queue && touch.y >= EPD47_QUEUE_TOP) {
            const int row = (touch.y - EPD47_QUEUE_TOP) / (EPD47_QUEUE_ROW + EPD47_QUEUE_GAP);
            if (row < EPD47_QUEUE_ROWS && epd47PaintedRows[row][0]) {
                strncpy(epd47FocusedId, epd47PaintedRows[row], sizeof(epd47FocusedId) - 1);
                epd47Page = AgentDeckEpd47::Page::Focus;
                manualFace = PaperFace::Glance;
                handled = true;
            }
        } else if (!handled && renderFace == PaperFace::Glance &&
                   epd47Page == AgentDeckEpd47::Page::Focus && touch.y > 86 && touch.y < 470 &&
                   touchSnap.optionCount > 0 && primarySession(touchSnap, AgentDeckEink::StatusKind::Attention) >= 0 &&
                   (!epd47FocusedId[0] || strcmp(epd47FocusedId, touchSnap.rows[primarySession(touchSnap, AgentDeckEink::StatusKind::Attention)].id) == 0)) {
            manualFace = PaperFace::Decision;
            handled = true;
        }
        if (handled) {
            epd47PageHoldUntilMs = now + FACE_HOLD_MS;
            faceHoldUntilMs = now + FACE_HOLD_MS;
            interactiveLeaseUntilMs = now + FACE_HOLD_MS;
        }

        if (handled) {
            // Bypass the coalesce gate. The refresh policy will differentially
            // erase the prior frame unless a scheduled hard clear is due.
            forceFull = true;
            lastHash = 0;
            epd47LastTouchMs = now;
        }
    }
    // One hard sweep after the tap session ends: quiet differential erases
    // leave grayscale residue, and the flash costs least attention when the
    // user has already stopped touching.
    if (AgentDeckEpd47::postInteractionSweepDue(
            epd47LastTouchMs, epd47RefreshState.differentialCount, now,
            EPD47_POST_TOUCH_SWEEP_QUIET_MS)) {
        epd47LastTouchMs = 0;
        epd47PostTouchSweepDue = true;
        forceRefresh = true;
        lastHash = 0;
    }
#endif
}

void render() {
    uint32_t now = millis();
    static Snap s; snapshot(s);  // static: see init() — Snap outgrew the task stack

    // TRMNL 7.5" intentionally ignores the host Mac's display-sleep state. E-ink
    // retains the dashboard without panel refresh power, and this board is
    // always USB-powered, so replacing useful status with an asleep card saves
    // no meaningful display energy. Content updates continue while the Mac is
    // awake even if its monitors are off.

    bool searching = !s.bridgeConnected;
    const bool leaseActive = interactiveLeaseActive(now);
    const bool faceHeld = manualFace == PaperFace::Aquarium ||
        (faceHoldUntilMs != 0 && (int32_t)(faceHoldUntilMs - now) > 0);
#if defined(AGENTDECK_EPD47_UI)
    const bool pageHeld = epd47PageHoldUntilMs != 0 &&
                          (int32_t)(epd47PageHoldUntilMs - now) > 0;
    if (!pageHeld) {
        epd47PageHoldUntilMs = 0;
        epd47Page = AgentDeckEpd47::Page::Home;
    }
#endif
    const int awaiting = primarySession(s, AgentDeckEink::StatusKind::Attention);
    const int processing = primarySession(s, AgentDeckEink::StatusKind::Processing);
    if (processing >= 0) sawProcessing = true;
    const uint32_t currentAnswer = answerHash(s);
    if (sawProcessing && processing < 0 && currentAnswer != 0 && !faceHeld &&
        currentAnswer != lastAnswerHash && leaseActive) {
        lastAnswerHash = currentAnswer;
        manualFace = PaperFace::Answer;
        faceHoldUntilMs = now + FACE_HOLD_MS;
        sawProcessing = false;
    }
    lastDecisionHash = decisionHash(s);
#if defined(AGENTDECK_EPD47_UI)
    if (lastDecisionHash != epd47SelectionDecisionHash) {
        epd47SelectionDecisionHash = lastDecisionHash;
        epd47DecisionSelection = 0;
    }
#endif
#if defined(AGENTDECK_NM_UI)
    if (lastDecisionHash != nmSelectionDecisionHash) {
        nmSelectionDecisionHash = lastDecisionHash;
        nmDecisionSelection = 0;
    }
#endif
#if defined(AGENTDECK_TRMNL_75_UI)
    if (lastDecisionHash != inkSelectionDecisionHash) {
        inkSelectionDecisionHash = lastDecisionHash;
        inkDecisionSelection = 0;
    }
#endif
    if (searching) {
        renderFace = manualFace == PaperFace::Aquarium ? PaperFace::Aquarium : PaperFace::Roster;
#if defined(AGENTDECK_EPD47_UI)
    } else if (faceHeld) {
        // A touch-selected tab/face owns the body for eight minutes. New work
        // is announced in the footer but does not steal the user's page.
        renderFace = manualFace;
#endif
    } else if (awaiting >= 0 && s.optionCount > 0 && lastDecisionHash != suppressedDecisionHash && leaseActive) {
        renderFace = PaperFace::Decision;
    } else if (manualFace == PaperFace::Aquarium) {
        renderFace = PaperFace::Aquarium;
    } else if (!searching && faceHoldUntilMs != 0 && (int32_t)(faceHoldUntilMs - now) > 0) {
        renderFace = manualFace;
    } else {
        manualFace = PaperFace::Glance;
        faceHoldUntilMs = 0;
        renderFace = PaperFace::Glance;
    }
    uint32_t h = paperHash(s, renderFace);
    if (h == lastHash && !forceFull && !forceRefresh) return;
    bool urgentTransition = searching != wasSearching;
#if defined(BOARD_NM_EPD_420)
    uint8_t nmAttention = 0, nmWorking = 0;
    for (uint8_t i = 0; i < s.rowCount; i++) {
        const auto kind = AgentDeckEink::classifyStatus(s.rows[i].state);
        if (kind == AgentDeckEink::StatusKind::Attention) nmAttention++;
        else if (kind == AgentDeckEink::StatusKind::Processing) nmWorking++;
    }
    urgentTransition = urgentTransition || !physicalFaceReady ||
                       renderFace != lastPhysicalFace ||
                       nmAttention > lastPhysicalAttention;
    // Settled-count bypass (see NM_COUNT_SETTLE_MS above): render() runs every
    // loop tick, so this re-evaluates until the pending change either settles
    // into a repaint or the counts bounce back and clear the candidate.
    if (nmAttention != lastPhysicalAttention || nmWorking != lastPhysicalWorking) {
        if (nmAttention != nmPendingAttention || nmWorking != nmPendingWorking) {
            nmPendingAttention = nmAttention;
            nmPendingWorking = nmWorking;
            nmCountStableSinceMs = now;
        } else if ((uint32_t)(now - nmCountStableSinceMs) >= NM_COUNT_SETTLE_MS) {
            urgentTransition = true;
        }
    } else {
        nmPendingAttention = 255;
        nmPendingWorking = 255;
    }
#endif
    const bool galleryTransition = renderFace != lastPaintedFace &&
        (renderFace == PaperFace::Aquarium || lastPaintedFace == PaperFace::Aquarium);
    uint8_t aquariumAttention = 0;
    if (renderFace == PaperFace::Aquarium) {
        for (uint8_t i = 0; i < s.rowCount; i++) if (isAwaiting(s.rows[i].state)) aquariumAttention++;
    }
    urgentTransition = urgentTransition || galleryTransition ||
        (renderFace == PaperFace::Aquarium && aquariumAttention > lastAquariumAttention);
    const uint32_t interval = renderFace == PaperFace::Aquarium ? 60000UL : MIN_REFRESH_INTERVAL_MS;
    if (!forceFull && !forceRefresh && !urgentTransition &&
        (now - lastDrawMs) < interval) return;  // coalesce bursts

#if defined(BOARD_LILYGO_EPD47)
    // A logical page transition is not a pigment reset. It gets the same quiet
    // differential erase as every other content replacement, and crucially it
    // does not reset the hard-clear count or age.
    const bool epd47HardClear = AgentDeckEpd47::hardClearDue(
        epd47RefreshState, firstDraw, now, FULL_EVERY_N_PARTIALS,
        FULL_MAX_AGE_MS) || epd47PostTouchSweepDue;
    epd47PostTouchSweepDue = false;
    const AgentDeckEpd47::Erase epd47Erase =
        AgentDeckEpd47::chooseErase(epd47HardClear);
    refresh(searching ? drawSearching : drawDashboard, s,
            epd47HardClear, epd47Erase);
#else
    // A milestone ticker row replacing another under a partial waveform
    // leaves the old text ghosted beneath the new — on the panel it reads as
    // overlapping print, not as fading. Text-on-text is the one ghost worth a
    // full flash on its own; `lastTickerShown` was recorded for exactly this
    // and nothing consumed it. Guarded on a previous value so the first row
    // after boot rides `firstDraw`.
    const bool tickerReplaced = lastTickerShown[0] != '\0' && s.tickerCount > 0 &&
        strncmp(lastTickerShown, s.tickerText[0], sizeof(lastTickerShown) - 1) != 0;
    bool full = forceFull || firstDraw || galleryTransition ||
                (renderFace != PaperFace::Aquarium && tickerReplaced) ||
                partialCount >= FULL_EVERY_N_PARTIALS ||
                (now - lastFullMs) > FULL_MAX_AGE_MS ||
                (searching != wasSearching);
#if defined(AGENTDECK_EPD47_UI)
    // Host preview: mirror the visible page-replacement behavior even though it
    // has no physical waveform or retained-panel state.
    full = full || !physicalEpd47PageReady || epd47Page != lastPhysicalEpd47Page;
#endif
#if defined(BOARD_NM_EPD_420)
    // The installed tri-color glass darkens under refresh_bw(), even when the
    // RAM window excludes every red pixel. Stock full-color waveform only.
    full = true;
#endif
    // Keep transport-offline distinct from a live daemon with an empty roster.
    // init() already uses this split; subsequent refreshes must preserve it or
    // the first timed repaint replaces OFFLINE with "no active sessions".
    refresh(searching && renderFace != PaperFace::Aquarium ? drawSearching : drawDashboard, s, full);
#endif

#if defined(AGENTDECK_EPD47_UI)
    lastPhysicalEpd47Page = epd47Page;
    physicalEpd47PageReady = true;
#endif

#if defined(BOARD_NM_EPD_420)
    lastPhysicalFace = renderFace;
    lastPhysicalAttention = nmAttention;
    lastPhysicalWorking = nmWorking;
    physicalFaceReady = true;
#endif

    displayedDecisionHash = renderFace == PaperFace::Decision ? decisionHash(s) : 0;
    lastHash = h;
    lastPaintedFace = renderFace;
    lastAquariumAttention = aquariumAttention;
    lastDrawMs = now;
    firstDraw = false;
    forceFull = false;
    forceRefresh = false;
    wasSearching = searching;
    strncpy(lastTickerShown, s.tickerCount > 0 ? s.tickerText[0] : "", sizeof(lastTickerShown) - 1);
    lastTickerShown[sizeof(lastTickerShown) - 1] = '\0';
}

}  // namespace Eink

#endif  // BOARD_EINK_SURFACE
