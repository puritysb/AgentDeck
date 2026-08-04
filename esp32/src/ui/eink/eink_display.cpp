#ifdef BOARD_INKDECK

#include "eink_display.h"

#include <Arduino.h>
#include <SPI.h>
#include <GxEPD2_BW.h>
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
#include "util/usage_format.h"
#include "util/utf8.h"

namespace {

// Pin map lives in boards/board_inkdeck.h (Seeed OG DIY Kit)
constexpr int8_t PIN_EPD_SCK  = BOARD_PIN_EPD_SCK;
constexpr int8_t PIN_EPD_MOSI = BOARD_PIN_EPD_MOSI;
constexpr int8_t PIN_EPD_CS   = BOARD_PIN_EPD_CS;
constexpr int8_t PIN_EPD_DC   = BOARD_PIN_EPD_DC;
constexpr int8_t PIN_EPD_RST  = BOARD_PIN_EPD_RST;
constexpr int8_t PIN_EPD_BUSY = BOARD_PIN_EPD_BUSY;
constexpr uint8_t PIN_KEY1    = BOARD_PIN_KEY1;   // force full refresh
constexpr uint8_t PIN_KEY2    = BOARD_PIN_KEY2;   // force full refresh (paging later)

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
constexpr uint32_t MIN_REFRESH_INTERVAL_MS = 3000;
constexpr uint8_t  FULL_EVERY_N_PARTIALS   = 5;
constexpr uint32_t FULL_MAX_AGE_MS         = 10UL * 60UL * 1000UL;

using Panel = GxEPD2_750_GDEY075T7;
GxEPD2_BW<Panel, Panel::HEIGHT> display(Panel(PIN_EPD_CS, PIN_EPD_DC, PIN_EPD_RST, PIN_EPD_BUSY));
// UTF-8/한글 renderer for dynamic text (project names, prompts, activity,
// ticker). GFX FreeFonts are Latin-only — Korean previously degraded to
// "######?" garbage via the ASCII sanitizer.
U8G2_FOR_ADAFRUIT_GFX u8f;

constexpr int16_t W = SCREEN_W, H = SCREEN_H;

// ===== Render snapshot (copied out of g_state under the mutex so the slow
// e-ink refresh never holds the lock) =====
constexpr uint8_t MAX_ROWS = 10;   // matches the sessions_list cap

struct RowSnap {
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
    // Subscription plan lines per provider ("Max 20x ~7/12"), '' = hide
    char claudePlan[40];
    char codexPlan[40];
    char agPlan[40];   // pre-shortened "AGY Pro ~8/1" chip text
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
        } else {
            strncpy(s.agPlan, line, sizeof(s.agPlan) - 1);
        }
    }
    // Plan-name-only fallback when the daemon exposes antigravityStatus but
    // no subscriptions[] entry for it.
    if (!s.agPlan[0] && g_state.antigravityPlan[0]) {
        UsageFormat::formatAgyPlan(g_state.antigravityPlan, s.agPlan, sizeof(s.agPlan));
    }
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
        bool milestone = strcmp(t.type, "chat_start") == 0 || strcmp(t.type, "chat_end") == 0 ||
                         strcmp(t.type, "chat_response") == 0;
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
    h = fnv(h, &fh, sizeof(fh)); h = fnv(h, &sd, sizeof(sd));
    h = fnv(h, &cp, sizeof(cp)); h = fnv(h, &cs, sizeof(cs));
    h = fnvStr(h, s.fiveReset); h = fnvStr(h, s.sevenReset);
    h = fnvStr(h, s.codexPReset); h = fnvStr(h, s.codexSReset);
    h = fnvStr(h, s.claudePlan); h = fnvStr(h, s.codexPlan); h = fnvStr(h, s.agPlan);
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
    if (isAsciiOnly(s)) { fitText(out, outLen, s, maxW, f); return; }
    strncpy(out, s, outLen - 1); out[outLen - 1] = '\0';
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

void drawBrandHeader(const Snap& s) {
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

    // Session count, left of the chip
    if (s.totalSessions > 0) {
        char cnt[24];
        snprintf(cnt, sizeof(cnt), "%d session%s", s.totalSessions, s.totalSessions == 1 ? "" : "s");
        textRight(chipX - 14, 38, cnt, &FreeSans9pt7b);
    }

    // Double rule (print-style)
    display.fillRect(0, 62, W, 2, GxEPD_BLACK);
    display.drawFastHLine(0, 66, W, GxEPD_BLACK);
}

// One gauge block: "5H [▓▓▓░░] 42% · 1h 23m". Bar kept narrow (140px) so the
// value+reset text breathes before the next block starts.
void drawGaugeBar(int16_t x, int16_t y, const char* tag, float pct, const char* reset) {
    constexpr int16_t barW = 140, barH = 16;
    textAt(x, y + barH - 2, tag, &FreeSansBold9pt7b);
    int16_t bx = x + 30;
    display.drawRect(bx, y, barW, barH, GxEPD_BLACK);
    char val[36];
    if (pct >= 0.0f) {
        float p = pct > 100.0f ? 100.0f : pct;
        int fill = (int)((barW - 4) * p / 100.0f);
        display.fillRect(bx + 2, y + 2, fill, barH - 4, GxEPD_BLACK);
        if (reset[0]) snprintf(val, sizeof(val), "%d%% · %s", (int)pct, reset);
        else snprintf(val, sizeof(val), "%d%%", (int)pct);
    } else {
        strncpy(val, "--", sizeof(val));
    }
    textAt(bx + barW + 8, y + barH - 2, val, &FreeSans9pt7b);
}

// Provider row (28px): mini glyph + label (+ subscription plan sub-line in the
// classic font when known) + available-window gauges. Returns true if drawn.
// A missing window is NOT rendered as a "--" placeholder: after a Codex 5h
// reset the 5H window disappears entirely (7d flips to the primary slot), and
// a dead "--" gauge next to the live 7D read as breakage. Present windows
// pack left instead.
bool drawProviderUsage(int16_t y, const char* agentType, const char* label,
                       const char* plan, float p5, const char* r5,
                       float p7, const char* r7, bool stale) {
    if (p5 < 0.0f && p7 < 0.0f) return false;
    drawAgentGlyph(agentType, 14, y + 2, 22);
    char lbl[24];
    snprintf(lbl, sizeof(lbl), "%s%s", label, stale ? "*" : "");
    textAt(44, y + 13, lbl, &FreeSansBold9pt7b);
    if (plan[0]) {
        char pf[24];
        fitText(pf, sizeof(pf), plan, 100, CLASSIC_FONT);
        textAt(44, y + 26, pf, CLASSIC_FONT);  // "Max 20x ~7/12" under the label
    }
    int16_t slotX = 150;
    if (p5 >= 0.0f) { drawGaugeBar(slotX, y + 2, "5H", p5, r5); slotX = 490; }
    if (p7 >= 0.0f) drawGaugeBar(slotX, y + 2, "7D", p7, r7);
    return true;
}

// Provider usage rows that will actually draw (mirrors the p5<0 && p7<0 gate
// above). This count feeds the shared geometry engine used by InkDeck + XTeink.
static int usageRowCount(const Snap& s) {
    int n = 0;
    if (s.fiveH >= 0.0f || s.sevenD >= 0.0f) n++;
    if (s.codexP >= 0.0f || s.codexS >= 0.0f) n++;
    return n;
}

AgentDeckEink::Layout dashboardLayout(const Snap& s) {
    uint8_t activityRows = s.bridgeConnected && s.tickerCount > 0 ? s.tickerCount : 1;
    return AgentDeckEink::makeLayout(AgentDeckEink::LayoutInput{
        W, H,
        68,  // product header + double rule
        0,   // InkDeck has no persistent button-hint bar
        28, 21,
        (uint8_t)usageRowCount(s), activityRows,
        s.rowCount, 2,
    });
}

// Usage + recent-work components are ANCHORED by the shared responsive layout
// (band y/height come from `layout.usage` / `layout.activity`, never from magic
// 800x480 offsets), and X3/X4 consume that same band contract through the
// mirrored geometry header.
//
// What is NOT responsive is the horizontal composition *inside* a band: the
// wordmark, glyph, label and the two gauge slots below use absolute x constants
// tuned for this panel's 800px width (drawBrandHeader, drawProviderUsage). That
// is fine — this renderer only ever runs on InkDeck's 800x480 — but it means
// rendering this file at another width is not a preview of that panel. The
// esp32/sim `xteink_x3`/`xteink_x4` diagnostic envs do exactly that to inspect
// the shared *geometry*; their squashed header and off-panel second gauge are
// this renderer's constants, not a fault in the layout SSOT and not what the
// XTeink fork draws (it has its own GfxRenderer). Measured 2026-08-05: bands
// are clean at 800x480 / 528x792 / 480x800; the 2nd gauge slot (x=490, ~288px
// wide) simply does not exist on a 480px panel. Make these width-derived only
// when a second e-ink size actually ships — it moves InkDeck's shipped pixels.
void drawUsageFooter(const Snap& s, bool showIdentity, const AgentDeckEink::Layout& layout) {
    if (!layout.usage.empty()) {
        display.fillRect(0, layout.usage.y, W, 2, GxEPD_BLACK);
        int16_t y = layout.usage.y + layout.gap;
        bool any = false;
        if (drawProviderUsage(y, "claude-code", "CLAUDE", s.claudePlan, s.fiveH, s.fiveReset,
                              s.sevenD, s.sevenReset, s.usageStale)) { y += 28; any = true; }
        if (drawProviderUsage(y, "codex-cli", "CODEX", s.codexPlan, s.codexP, s.codexPReset,
                              s.codexS, s.codexSReset, false)) { y += 28; any = true; }
        if (!any) textAt(16, y + 16, "usage: waiting for data", &FreeSans9pt7b);
    }

    // AGY subscription chip — smallest possible footprint (classic font,
    // bottom-right corner), only when the daemon resolves the account.
    int16_t agW = 0;
    if (s.agPlan[0]) {
        char agf[28];
        fitText(agf, sizeof(agf), s.agPlan, 130, CLASSIC_FONT);
        agW = textWidth(agf, CLASSIC_FONT) + 14;
        textRight(W - layout.pad, H - 6, agf, CLASSIC_FONT);
    }
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
        constexpr int16_t rowH = 21;
        for (uint8_t i = 0; i < s.tickerCount; i++) {
            int16_t ty = layout.activity.y + 16 + (int16_t)i * rowH;
            bool bottomRow = (i == s.tickerCount - 1);
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

bool needsAttention(const RowSnap& r) {
    AgentDeckEink::StatusKind status = AgentDeckEink::classifyStatus(r.state);
    return status == AgentDeckEink::StatusKind::Attention ||
           status == AgentDeckEink::StatusKind::Processing;
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
    uint8_t order[MAX_ROWS]; uint8_t nAttention = 0, nOrder = 0;
    for (uint8_t i = 0; i < s.rowCount; i++) if (needsAttention(s.rows[i])) order[nOrder++] = i, nAttention++;
    for (uint8_t i = 0; i < s.rowCount; i++) if (!needsAttention(s.rows[i])) order[nOrder++] = i;

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

void drawSearching(const Snap& s) {
    display.fillScreen(GxEPD_WHITE);
    display.setTextColor(GxEPD_BLACK);
    setInk(false);
    const AgentDeckEink::Layout layout = dashboardLayout(s);
    drawBrandHeader(s);
    const int16_t centerY = layout.cards.y + layout.cards.h / 2;
    drawAgentDeckMark(W / 2 - 44, centerY - 88, 88);
    const char* msg = s.wifiUp || s.serialUp ? "searching for AgentDeck daemon..."
                                             : "no WiFi — connect USB or provision WiFi";
    textAt(W / 2 - textWidth(msg, &FreeSansBold12pt7b) / 2, centerY + 46, msg, &FreeSansBold12pt7b);
    if (s.wifiUp && s.ip[0]) {
        char line[64]; snprintf(line, sizeof(line), "panel %s · mDNS _agentdeck._tcp", s.ip);
        textAt(W / 2 - textWidth(line, &FreeSans9pt7b) / 2, centerY + 76, line, &FreeSans9pt7b);
    }
    drawUsageFooter(s, true, layout);
}

void drawDashboard(const Snap& s) {
    display.fillScreen(GxEPD_WHITE);
    display.setTextColor(GxEPD_BLACK);
    setInk(false);
    const AgentDeckEink::Layout layout = dashboardLayout(s);
    drawBrandHeader(s);
    drawSessionGrid(s, layout);
    drawUsageFooter(s, false, layout);
    // NOTE: no Serial logging here — this runs on Core 1 while Core 0 emits
    // protocol JSON lines (device_info replies, acks). Cross-core prints
    // interleave mid-line and corrupt the newline-framed JSON the daemon
    // parses (observed: device_info replies mangled → daemon kept showing a
    // stale buildHash). Keep render-path logging out of the firmware.
}

// ===== Refresh engine =====

uint32_t lastHash = 0;
uint32_t lastDrawMs = 0;
uint32_t lastFullMs = 0;
uint8_t partialCount = 0;
bool firstDraw = true;
bool forceFull = false;
bool wasSearching = true;
char lastTickerShown[104] = "";

bool key1Prev = true, key2Prev = true;
uint32_t keyLastMs = 0;

void refresh(void (*draw)(const Snap&), const Snap& s, bool full) {
    if (full) {
        display.setFullWindow();
        partialCount = 0;
        lastFullMs = millis();
    } else {
        display.setPartialWindow(0, 0, display.width(), display.height());
        partialCount++;
    }
    display.firstPage();
    do { draw(s); } while (display.nextPage());
    // powerOff (NOT hibernate): high voltage off, controller previous-frame
    // RAM retained so the next partial refresh diffs cleanly. See note above.
    display.powerOff();
}

}  // namespace

namespace Eink {

void init() {
    pinMode(PIN_KEY1, INPUT_PULLUP);
    pinMode(PIN_KEY2, INPUT_PULLUP);
    SPI.begin(PIN_EPD_SCK, -1, PIN_EPD_MOSI, PIN_EPD_CS);
    // serial_diag_bitrate MUST stay 0: GxEPD2's diagnostics print _PowerOn/
    // _Update_* timing lines from THIS core (Core 1) on every refresh, which
    // interleaves with Core 0's protocol JSON on the shared USB CDC and
    // corrupts newline-framed replies (observed: mangled device_info + inbound
    // parse failures from the TX congestion).
    display.init(0, true, 2, false);
    display.setRotation(0);
    u8f.begin(display);  // UTF-8/한글 text path (unifont) on the same canvas
    Serial.printf("[Eink] GDEY075T7 init %dx%d, partial=%d\n",
                  display.width(), display.height(),
                  (int)display.epd2.hasFastPartialUpdate);
    // static: Snap grew past 5KB (10 rows × work[152] + the multi-row strip)
    // — too big for the loop-task stack alongside the GxEPD2 page render.
    // init() and render() run on the same Core 1 loop task, so one static
    // scratch Snap is race-free.
    static Snap s; snapshot(s);
    refresh(drawSearching, s, true);
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
    bool k1 = digitalRead(PIN_KEY1), k2 = digitalRead(PIN_KEY2);
    if (((key1Prev && !k1) || (key2Prev && !k2)) && now - keyLastMs > 300) {
        keyLastMs = now;
        forceFull = true;
        lastHash = 0;  // force redraw even if content unchanged
        Serial.println("[Eink] button → full refresh");
    }
    key1Prev = k1; key2Prev = k2;
}

void render() {
    uint32_t now = millis();
    static Snap s; snapshot(s);  // static: see init() — Snap outgrew the task stack

    // InkDeck intentionally ignores the host Mac's display-sleep state. E-ink
    // retains the dashboard without panel refresh power, and this board is
    // always USB-powered, so replacing useful status with an asleep card saves
    // no meaningful display energy. Content updates continue while the Mac is
    // awake even if its monitors are off.

    bool searching = !s.bridgeConnected;
    uint32_t h = contentHash(s);
    // Ticker is outside the hash (tool-event churn must not strobe the
    // panel): it earns its own redraw at most once a minute; otherwise it
    // piggybacks on whatever refresh the hashed content triggers. The FIRST
    // ticker (blank → text) draws immediately — an empty bottom line for up
    // to a minute after boot read as "timeline broken".
    bool tickerDue = s.tickerCount > 0 &&
                     strcmp(s.tickerText[0], lastTickerShown) != 0 &&
                     (lastTickerShown[0] == '\0' || (now - lastDrawMs) >= 60000);
    if (h == lastHash && !forceFull && !tickerDue) return;
    if (!forceFull && (now - lastDrawMs) < MIN_REFRESH_INTERVAL_MS) return;  // coalesce bursts

    bool full = forceFull || firstDraw ||
                partialCount >= FULL_EVERY_N_PARTIALS ||
                (now - lastFullMs) > FULL_MAX_AGE_MS ||
                (searching != wasSearching);
    refresh(searching ? drawSearching : drawDashboard, s, full);

    lastHash = h;
    lastDrawMs = now;
    firstDraw = false;
    forceFull = false;
    wasSearching = searching;
    strncpy(lastTickerShown, s.tickerCount > 0 ? s.tickerText[0] : "", sizeof(lastTickerShown) - 1);
    lastTickerShown[sizeof(lastTickerShown) - 1] = '\0';
}

}  // namespace Eink

#endif  // BOARD_INKDECK
