#include "office.h"
#include "../theme.h"
#include "../display.h"
#include "../../state/agent_state.h"
#include "config.h"
#include <Arduino.h>
#include <math.h>
#include <string.h>
#include "creature_glyphs_generated.h"

// ── AgentDeck 10" "Pixel Office" (canonical: tenin/office.js) ────────────────────────────
// Agents are workers on a tile grid, clustered by project huddle. Each worker STAYS at its
// project seat and shows its live state in place — working (bob + floor glow), awaiting ('?'),
// resting (dimmed + 'z'), error ('!') — instead of drifting off to a shared lounge.
// A static base (carpet, huddle tables, props, labels) is rendered once and memcpy'd only when the
// drawn scene changes; workers and bubbles are cheap blocky sprites on top.

namespace Office {

#if !defined(BOARD_IPS10)
void init(lv_obj_t*) {}
void update(float) {}
void setVisible(bool) {}
#else

static constexpr int OFFICE_W   = 408;          // left band width
static constexpr int OFFICE_TOP = 56;           // full-width top bar height (keep == IPS10_TOPBAR_H)
static constexpr int MAXAG      = 10;

// ── palette (RGB565, from office.js `C`) ──
static inline uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b) {
    return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}
#define HEX565(h) rgb565((uint8_t)((h)>>16), (uint8_t)((h)>>8), (uint8_t)(h))
static const uint16_t C_carpetA = HEX565(0x173a33), C_carpetB = HEX565(0x143631), C_carpetEdge = HEX565(0x0e2a25);
static const uint16_t C_deskTop = HEX565(0x34574f), C_deskHi = HEX565(0x3e655c), C_deskEdge = HEX565(0x1d342f);
// Project-zone rug: a visibly bounded floor area under each huddle so seated
// creatures read as INSIDE their project room (the table alone only covered
// part of the seat rows — bottom-row agents looked parked outside the area).
static const uint16_t C_rug = HEX565(0x1c4a41), C_rugEdge = HEX565(0x2a5c52);
static const uint16_t C_bubble = HEX565(0x0a1714);
// Office props (office.js C): plant, water cooler, coffee machine + a filing cabinet.
static const uint16_t C_plantPot = HEX565(0x7a4a2c), C_plant = HEX565(0x3f8f63), C_plant2 = HEX565(0x4fa873);
static const uint16_t C_cooler = HEX565(0x2f6f8a), C_coolerTop = HEX565(0x9fe0ee);
static const uint16_t C_coffee = HEX565(0x2a2622), C_coffeeOn = HEX565(0xc07058);
static const uint16_t C_cabinet = HEX565(0x33514a), C_cabinetHi = HEX565(0x436a61), C_cabinetEdge = HEX565(0x1d342f);

// ── agent + state mapping (data.js AGENTS / STATE) ──
static uint32_t agentColor(const char* t) {
    if (!t) return 0x9aa0a8;
    if (strstr(t, "openclaw")) return 0xFF6B5B;
    if (strstr(t, "codex"))    return 0x6166E0;
    if (strstr(t, "opencode")) return 0x9aa0a8;
    if (strstr(t, "antigravity")) return 0xD2D6DC;
    if (strstr(t, "kiro"))    return 0x7C3AED;
    if (strstr(t, "claude"))   return 0xC07058;
    return 0x9aa0a8;
}
static const char* agentShort(const char* t) {
    if (!t) return "Agent";
    if (strstr(t, "openclaw")) return "OpenClaw";
    if (strstr(t, "codex"))    return "Codex";
    if (strstr(t, "opencode")) return "OpenCode";
    if (strstr(t, "antigravity")) return "Antigravity";
    if (strstr(t, "kiro"))    return "Kiro";
    if (strstr(t, "claude"))   return "Claude";
    return "Agent";
}
// state → bubble/accent color (STATE.*.color)
static uint32_t stateColor(const char* s) {
    if (strstr(s, "awaiting")) return 0xFFA93D;
    if (strstr(s, "error") || strstr(s, "fail")) return 0xFF6B6B;
    if (strcmp(s, "processing") == 0) return 0x3ED6E8;
    return 0x7a8a9c;  // idle
}
static const uint8_t* agentGlyphA8(const char* t) {
    using namespace CreatureGlyphs;
    if (!t) return nullptr;
    if (strstr(t, "openclaw")) return OPENCLAW_MARK_A8;
    if (strstr(t, "opencode")) return OPENCODE_A8;
    if (strstr(t, "codex"))    return CODEX_A8;
    if (strstr(t, "antigravity")) return ANTIGRAVITY_A8;
    if (strstr(t, "kiro"))    return KIRO_A8;
    if (strstr(t, "claude"))   return OCTOPUS_A8;
    return nullptr;
}

// ── canvas ──
static lv_obj_t* canvas = nullptr;
static lv_draw_buf_t drawBuf;
static uint16_t* buf = nullptr;      // live frame
static uint16_t* base = nullptr;     // cached static scene (carpet + huddle tables + props)
static bool baseDirty = true;
static int W = 0, H = 0;

// ── grid layout ──
static int tile = 40, cols = 7, rows = 14, gx = 0, gy = 0, u = 3;
static inline void tilePx(int c, int r, int& x, int& y) { x = gx + c * tile; y = gy + r * tile; }

// ── pods + props + workers ──
struct Pod { char project[40]; int c, r, w, h, count; };
static Pod pods[MAXAG];
static int podCount = 0;

struct Prop { int kind, c, r; };   // kind: 0 plant · 1 cooler · 2 coffee · 3 cabinet
static Prop props[8];
static int propCount = 0;
static bool propCell(int c, int r) {
    for (int i = 0; i < propCount; i++) if (props[i].c == c && props[i].r == r) return true;
    return false;
}

// ── room name-plate labels (LVGL overlays over the canvas) ──
static lv_obj_t* officeParent = nullptr;
static lv_obj_t* roomLabels[MAXAG + 2] = {nullptr};
static const char* projectBasename(const char* p) {
    const char* s = strrchr(p, '/'); const char* b = (s && s[1]) ? s + 1 : p;
    return (b && b[0]) ? b : "session";
}

struct Worker {
    bool active = false;
    char agent[16], project[40], state[20], id[32];
    uint32_t accent;
    int seatC, seatR;            // project-huddle slot (the worker's home; it never leaves it)
    int col, row, prevCol, prevRow;
    uint32_t stepAtMs;
    char facing;                 // 'L','R','U','D'
    float bobPhase;
};
static Worker wk[MAXAG];
static int nWk = 0;

// A grid cell currently held by another worker (logical position) — used to stop overlap.
static bool workerCell(int c, int r, int except) {
    for (int i = 0; i < nWk; i++) if (i != except && wk[i].active && wk[i].col == c && wk[i].row == r) return true;
    return false;
}

// ── pixel helpers (write straight into the live buffer) ──
static inline void blk(int x, int y, int w, int h, uint16_t col) {
    if (x < 0) { w += x; x = 0; } if (y < 0) { h += y; y = 0; }
    if (x + w > W) w = W - x; if (y + h > H) h = H - y;
    if (w <= 0 || h <= 0) return;
    for (int yy = y; yy < y + h; yy++) {
        uint16_t* row = buf + yy * W + x;
        for (int xx = 0; xx < w; xx++) row[xx] = col;
    }
}
// alpha-blend a solid color over the existing buffer pixel
static inline void blendPx(int x, int y, uint16_t col, uint8_t a) {
    if (x < 0 || y < 0 || x >= W || y >= H || a == 0) return;
    uint16_t* p = buf + y * W + x;
    if (a >= 250) { *p = col; return; }
    uint16_t d = *p;
    int sr = (col >> 11) & 0x1F, sg = (col >> 5) & 0x3F, sb = col & 0x1F;
    int dr = (d >> 11) & 0x1F, dg = (d >> 5) & 0x3F, db = d & 0x1F;
    int ia = 255 - a;
    int rr = (sr * a + dr * ia) / 255, rg = (sg * a + dg * ia) / 255, rb = (sb * a + db * ia) / 255;
    *p = (uint16_t)((rr << 11) | (rg << 5) | rb);
}

// blit a 64×64 A8 mask, tinted, into a dw×dh box centered at (cx,cy). nearest-neighbour scale,
// optional horizontal flip, global alpha. Used for the worker creature sprite.
// HSV(h°, S=1, V=1) → RGB565. Used to paint the Antigravity rainbow mark.
static inline uint16_t hue565(float h) {
    h = fmodf(h, 360.0f); if (h < 0) h += 360.0f;
    float hp = h / 60.0f;
    float x = 1.0f - fabsf(fmodf(hp, 2.0f) - 1.0f);
    float r = 0, g = 0, b = 0;
    if (hp < 1)      { r = 1; g = x; }
    else if (hp < 2) { r = x; g = 1; }
    else if (hp < 3) { g = 1; b = x; }
    else if (hp < 4) { g = x; b = 1; }
    else if (hp < 5) { r = x; b = 1; }
    else             { r = 1; b = x; }
    return rgb565((uint8_t)(r * 255), (uint8_t)(g * 255), (uint8_t)(b * 255));
}

static void blitGlyph(const uint8_t* a8, int cx, int cy, int dw, int dh, uint16_t col, bool flipX, uint8_t ga) {
    if (!a8 || dw <= 0 || dh <= 0) return;
    // The Antigravity mark is a spectral gradient, not a single colour — paint it
    // per-pixel via a colour wheel (the A8 mask only carries the shape/alpha).
    bool rainbow = (a8 == CreatureGlyphs::ANTIGRAVITY_A8);
    int x0 = cx - dw / 2, y0 = cy - dh / 2;
    for (int dy = 0; dy < dh; dy++) {
        int sy = dy * 64 / dh; if (sy > 63) sy = 63;
        const uint8_t* srow = a8 + sy * 64;
        for (int dx = 0; dx < dw; dx++) {
            int sx = dx * 64 / dw; if (sx > 63) sx = 63;
            int ssx = flipX ? (63 - sx) : sx;
            uint8_t m = srow[ssx];
            if (m < 12) continue;
            uint16_t pcol = col;
            if (rainbow) {
                // Angle around the mark centre: green left, warm top-right, blue
                // bottom-right — approximates the Antigravity spectral "A".
                float ang = atan2f((float)(32 - sy), (float)(ssx - 32)) * 57.2958f;
                pcol = hue565(ang - 60.0f);
            }
            blendPx(x0 + dx, y0 + dy, pcol, (uint8_t)((m * ga) / 255));
        }
    }
}

// ── 3×5 micro-glyphs for status bubbles (office.js GLY) ──
static const uint8_t GLY_q[5][3] = {{1,1,1},{0,0,1},{0,1,1},{0,0,0},{0,1,0}};
static const uint8_t GLY_b[5][3] = {{0,1,0},{0,1,0},{0,1,0},{0,0,0},{0,1,0}};
static const uint8_t GLY_z[5][3] = {{1,1,1},{0,0,1},{0,1,0},{1,0,0},{1,1,1}};
static const uint8_t GLY_w[5][3] = {{1,0,1},{0,1,0},{1,1,1},{0,1,0},{1,0,1}};  // 'working' spark
static void drawBubble(int bx, int by, char g, uint16_t col) {
    int bw = 5 * u, bh = 5 * u;
    blk(bx, by, bw, bh, C_bubble);
    blk(bx + u, by - u, bw - 2 * u, u, C_bubble);   // top notch
    blk(bx + u, by + bh, u, u, C_bubble);           // tail
    const uint8_t (*m)[3] = g == '?' ? GLY_q : g == '!' ? GLY_b : g == 'w' ? GLY_w : GLY_z;
    for (int r = 0; r < 5; r++) for (int c = 0; c < 3; c++)
        if (m[r][c]) blk(bx + (c + 1) * u, by + r * u, u, u, col);
}

// ── Minecraft block world ─────────────────────────────────────────────────────
static bool projectDelim(char c) {
    return c == '-' || c == '_' || c == ' ' || c == '.';
}
static char lowerAscii(char c) {
    return (c >= 'A' && c <= 'Z') ? (char)(c + ('a' - 'A')) : c;
}
static void trimProjectTail(char* s) {
    int n = (int)strlen(s);
    while (n > 0 && (projectDelim(s[n - 1]) || s[n - 1] == '#')) n--;
    s[n] = '\0';
}
static int projectDelimCount(const char* s, int len) {
    int count = 0;
    for (int i = 0; i < len && s[i]; i++) if (projectDelim(s[i])) count++;
    return count;
}
static void copyProjectPrefix(const char* in, int len, char* out, int outSz) {
    if (outSz <= 0) return;
    if (len >= outSz) len = outSz - 1;
    if (len < 0) len = 0;
    memcpy(out, in, (size_t)len);
    out[len] = '\0';
    trimProjectTail(out);
}
// Strip a trailing " #N" suffix so "Foo #1" / "Foo #2" group as the same task.
static void normProject(const char* in, char* out, int outSz) {
    const char* baseName = projectBasename(in);
    int n = (int)strlen(baseName), e = n;
    while (e > 0 && baseName[e-1] >= '0' && baseName[e-1] <= '9') e--;
    if (e < n && e > 0 && baseName[e-1] == '#') {
        int s = e - 1;
        while (s > 0 && baseName[s-1] == ' ') s--;
        n = s;
    }
    if (n <= 0 || n >= outSz) { strncpy(out, baseName, outSz-1); out[outSz-1] = '\0'; return; }
    memcpy(out, baseName, n); out[n] = '\0';
    trimProjectTail(out);
}
static bool sameProjectGroup(const char* a, const char* b, char* groupKey, int groupKeySz) {
    if (groupKeySz <= 0) return false;
    int i = 0, lastDelim = -1;
    for (; a[i] && b[i] && lowerAscii(a[i]) == lowerAscii(b[i]); i++) {
        if (projectDelim(a[i])) lastDelim = i;
    }
    if (!a[i] && !b[i]) {
        strncpy(groupKey, a, groupKeySz - 1);
        groupKey[groupKeySz - 1] = '\0';
        return true;
    }

    int stemLen = -1;
    if (!a[i] && projectDelim(b[i])) stemLen = i;          // "foo-bar" + "foo-bar-1"
    else if (!b[i] && projectDelim(a[i])) stemLen = i;     // "foo-bar-1" + "foo-bar"
    else if (lastDelim > 0) stemLen = lastDelim;           // "foo-bar-a" + "foo-bar-b"

    // Keep this conservative: only long, multi-token stems become fuzzy groups.
    // This catches multi-agent task folders like "claude-agents-md-check-*"
    // without collapsing short sibling projects like "agentdeck-ios" and "agentdeck-android".
    if (stemLen < 14 || projectDelimCount(a, stemLen) < 2 || projectDelimCount(b, stemLen) < 2) return false;
    copyProjectPrefix(a, stemLen, groupKey, groupKeySz);
    return groupKey[0] != '\0';
}
// A shared table the huddle gathers around (beveled blocky rect, static).
static void drawTable(int x, int y, int w, int h) {
    if (w < 8 || h < 8) return;
    blk(x + 2, y + h, w - 4, 2, HEX565(0x06120f));   // base shadow
    blk(x, y, w, h, C_deskTop);
    blk(x, y, w, 2, C_deskHi);
    blk(x, y + h - 2, w, 2, C_deskEdge);
}
static bool blockedCell(int c, int r);   // fwd

// ── layout: dynamic project huddles on the block world ──
static void buildLayout() {
    int mn = W < H ? W : H;
    tile = mn / 7; if (tile < 26) tile = 26; if (tile > 54) tile = 54;
    cols = W / tile; if (cols < 5) cols = 5;
    rows = H / tile; if (rows < 5) rows = 5;
    gx = (W - cols * tile) / 2;
    gy = (H - rows * tile) / 2;
    u = tile / 14; if (u < 2) u = 2;

    // Ambient props: potted plants in the top corners. (The REST lounge is gone — idle
    // agents now rest in place at their project seat rather than drifting to a shared band,
    // so the whole floor height is available for project huddles.)
    propCount = 0;
    const Prop pcand[2] = { {0, 1, 1}, {0, cols - 2, 1} };
    for (int i = 0; i < 2 && propCount < (int)(sizeof(props)/sizeof(props[0])); i++) {
        const Prop& p = pcand[i];
        if (p.c < 1 || p.c >= cols || p.r < 1 || p.r >= rows) continue;
        props[propCount++] = p;
    }

    // Dynamic project huddles: workers whose (normalized) project name matches cluster
    // into a small box placed across the floor (alternating columns, stacked), each in
    // a distinct slot so creatures gather but never overlap. Re-formed on any change.
    podCount = 0;
    bool done[MAXAG] = {false};
    int colCursor[2] = {1, 1};
    int huddleIdx = 0;
    for (int a = 0; a < nWk; a++) {
        if (done[a]) continue;
        char na[40]; normProject(wk[a].project, na, sizeof(na));
        char groupKey[40]; strncpy(groupKey, na, sizeof(groupKey) - 1); groupKey[sizeof(groupKey) - 1] = '\0';
        int mem[MAXAG], mc = 0;
        mem[mc++] = a; done[a] = true;
        for (int b = a + 1; b < nWk; b++) {
            if (done[b]) continue;
            char nb[40]; normProject(wk[b].project, nb, sizeof(nb));
            char nextKey[40];
            if (sameProjectGroup(groupKey, nb, nextKey, sizeof(nextKey)) ||
                sameProjectGroup(na, nb, nextKey, sizeof(nextKey))) {
                strncpy(groupKey, nextKey, sizeof(groupKey) - 1); groupKey[sizeof(groupKey) - 1] = '\0';
                mem[mc++] = b; done[b] = true;
            }
        }
        int slotCols = mc >= 5 ? 3 : (mc >= 2 ? 2 : 1);
        int slotRows = (mc + slotCols - 1) / slotCols;
        int boxW = slotCols, boxH = 1 + slotRows;          // nametag row + slot rows
        int side = huddleIdx & 1;
        int boxC = side == 0 ? 1 : (cols - 1 - boxW); if (boxC < 1) boxC = 1;
        int boxR = colCursor[side];
        if (boxR + boxH - 1 >= rows - 1) {                 // column full → try the other
            side ^= 1; boxC = side == 0 ? 1 : (cols - 1 - boxW); if (boxC < 1) boxC = 1; boxR = colCursor[side];
            if (boxR + boxH - 1 >= rows - 1) boxR = 1;
        }
        Pod& pod = pods[podCount];
        strncpy(pod.project, groupKey, sizeof(pod.project) - 1); pod.project[sizeof(pod.project)-1] = '\0';
        pod.c = boxC; pod.r = boxR; pod.w = boxW; pod.h = boxH; pod.count = mc;
        int placed = 0;
        for (int rr = 0; rr < slotRows && placed < mc; rr++)
            for (int cc = 0; cc < slotCols && placed < mc; cc++) {
                int sc = boxC + cc, sr = boxR + 1 + rr;
                if (sc < 1) sc = 1; if (sc > cols - 1) sc = cols - 1;
                if (sr > rows - 1) sr = rows - 1;
                while (blockedCell(sc, sr) && sc > 1) sc--;
                wk[mem[placed]].seatC = sc; wk[mem[placed]].seatR = sr;
                placed++;
            }
        colCursor[side] = boxR + boxH + 1;
        huddleIdx++;
        podCount++;
    }
    baseDirty = true;
}

static bool blockedCell(int c, int r) {
    for (int i = 0; i < propCount; i++) if (props[i].c == c && props[i].r == r) return true;
    return false;
}

// ── office prop sprite (blocky pixels, like office.js drawProp) ──
static void drawProp(int kind, int col, int row) {
    int x, y; tilePx(col, row, x, y);
    int cx = x + tile / 2;
    if (kind == 0) {              // potted plant
        blk(cx - 2 * u, y + tile - 4 * u, 5 * u, 3 * u, C_plantPot);
        blk(cx - 4 * u, y + tile - 9 * u, 8 * u, 6 * u, C_plant);
        blk(cx - u,     y + tile - 11 * u, 3 * u, 4 * u, C_plant2);
    } else if (kind == 1) {       // water cooler
        blk(cx - 3 * u, y + tile - 8 * u, 6 * u, 6 * u, C_cooler);
        blk(cx - 2 * u, y + tile - 11 * u, 5 * u, 4 * u, C_coolerTop);   // bottle
        blk(cx - 3 * u, y + tile - 2 * u, 6 * u, 2 * u, C_cabinetEdge);
    } else if (kind == 2) {       // coffee machine
        blk(cx - 3 * u, y + tile - 8 * u, 6 * u, 6 * u, C_coffee);
        blk(cx - 2 * u, y + tile - 6 * u, 4 * u, 2 * u, C_coffeeOn);     // warm pot
    } else {                      // filing cabinet
        blk(cx - 4 * u, y + tile - 11 * u, 8 * u, 10 * u, C_cabinet);
        blk(cx - 4 * u, y + tile - 11 * u, 8 * u, u, C_cabinetHi);
        blk(cx - 4 * u, y + tile - 6 * u, 8 * u, u, C_cabinetEdge);      // drawer seam
        blk(cx + 2 * u, y + tile - 9 * u, u, 2 * u, C_cabinetHi);        // handle
    }
}

// ── LVGL name-plate overlays ──
static void styleRoomLabel(lv_obj_t* lab) {
    lv_obj_set_style_text_font(lab, &font_kr_12, 0);
    lv_obj_set_style_bg_color(lab, lv_color_hex(0x06120F), 0);
    lv_obj_set_style_bg_opa(lab, (lv_opa_t)185, 0);
    lv_obj_set_style_pad_left(lab, 3, 0); lv_obj_set_style_pad_right(lab, 3, 0);
    lv_obj_set_style_pad_top(lab, 1, 0); lv_obj_set_style_pad_bottom(lab, 1, 0);
    lv_obj_set_style_radius(lab, 3, 0);
    lv_label_set_long_mode(lab, LV_LABEL_LONG_DOT);
    lv_obj_clear_flag(lab, LV_OBJ_FLAG_CLICKABLE);
}
static void placeRoomLabel(int idx, const char* text, int cellC, int cellR, int cellW, uint32_t txtColor) {
    const int N = (int)(sizeof(roomLabels) / sizeof(roomLabels[0]));
    if (idx < 0 || idx >= N || !officeParent) return;
    if (!roomLabels[idx]) { roomLabels[idx] = lv_label_create(officeParent); styleRoomLabel(roomLabels[idx]); }
    lv_obj_t* lab = roomLabels[idx];
    lv_obj_clear_flag(lab, LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_style_text_color(lab, lv_color_hex(txtColor), 0);
    lv_obj_set_width(lab, LV_SIZE_CONTENT);           // size to the name — a floating nametag
    lv_label_set_text(lab, text);
    // left-anchor over the huddle box. (No lv_obj_update_layout / width-measure here:
    // that forces a full-tree layout pass per label on every rebuild — costly + a
    // reentrancy risk in the render path.)
    int x, y; tilePx(cellC, cellR, x, y);
    int est = (int)strlen(text) * 8 + 12;             // rough chip width to bias toward centre
    int px = x + (cellW * tile) / 2 - est / 2; if (px < 1) px = 1;
    lv_obj_set_pos(lab, px, OFFICE_TOP + y + (tile - 16) / 2);
}
static void hideAllRoomLabels() {
    for (int k = 0; k < (int)(sizeof(roomLabels) / sizeof(roomLabels[0])); k++)
        if (roomLabels[k]) lv_obj_add_flag(roomLabels[k], LV_OBJ_FLAG_HIDDEN);
}
static void syncRoomLabels() {
    if (!officeParent) return;
    const int N = (int)(sizeof(roomLabels) / sizeof(roomLabels[0]));
    int idx = 0;
    for (int i = 0; i < podCount && idx < N; i++)   // floating project nametag over each huddle
        placeRoomLabel(idx++, projectBasename(pods[i].project), pods[i].c, pods[i].r, pods[i].w, 0xF4F4E8);
    for (int k = idx; k < N; k++) if (roomLabels[k]) lv_obj_add_flag(roomLabels[k], LV_OBJ_FLAG_HIDDEN);
}

// ── static base render: office carpet, huddle tables, REST band ──
static void renderBaseInto() {
    uint16_t* saveBuf = buf; buf = base;   // draw helpers target `base` (static, cached)
    // calm office carpet — soft checkerboard so the creatures read clearly on top
    blk(0, 0, W, H, C_carpetA);
    for (int r = 0; r < rows; r++)
        for (int c = 0; c < cols; c++)
            if ((c + r) & 1) { int x, y; tilePx(c, r, x, y); blk(x, y, tile, tile, C_carpetB); }
    for (int c = 0; c <= cols; c++) { int x = gx + c * tile; for (int y = gy; y < gy + rows * tile; y++) blendPx(x, y, C_carpetEdge, 60); }
    for (int r = 0; r <= rows; r++) { int y = gy + r * tile; for (int x = gx; x < gx + cols * tile; x++) blendPx(x, y, C_carpetEdge, 60); }
    // each project huddle: a bounded zone rug (the visible "room") + the shared
    // table the team gathers around. The rug spans ALL seat rows so every seated
    // creature — bottom row included — clearly sits inside its project area.
    for (int i = 0; i < podCount; i++) {
        int px, py; tilePx(pods[i].c, pods[i].r + 1, px, py);   // below the nametag row
        int tw = pods[i].w * tile, th = (pods[i].h - 1) * tile;
        blk(px - u, py - u, tw + 2 * u, th + 2 * u, C_rug);
        for (int x = px - u; x < px - u + tw + 2 * u; x++) {    // soft zone outline
            blendPx(x, py - u, C_rugEdge, 170); blendPx(x, py + th + u - 1, C_rugEdge, 170);
        }
        for (int y = py - u; y < py + th + u; y++) {
            blendPx(px - u, y, C_rugEdge, 170); blendPx(px + tw + u - 1, y, C_rugEdge, 170);
        }
        drawTable(px + u, py + th / 5, tw - 2 * u, (th * 3) / 5);
    }
    // props — potted plants in the top corners (ambient office greenery)
    for (int i = 0; i < propCount; i++) drawProp(props[i].kind, props[i].c, props[i].r);
    buf = saveBuf;
}

void init(lv_obj_t* parent) {
    if (canvas) return;
    W = OFFICE_W; H = g_screenH - OFFICE_TOP;   // sit below the full-width top bar
    buf  = (uint16_t*)ps_malloc((size_t)W * H * sizeof(uint16_t));
    base = (uint16_t*)ps_malloc((size_t)W * H * sizeof(uint16_t));
    if (!buf || !base) { Serial.println("[Office] buffer alloc failed"); return; }

    officeParent = parent;
    canvas = lv_canvas_create(parent);
    lv_draw_buf_init(&drawBuf, W, H, LV_COLOR_FORMAT_RGB565, W * sizeof(uint16_t), buf, (uint32_t)W * H * sizeof(uint16_t));
    lv_canvas_set_draw_buf(canvas, &drawBuf);
    lv_obj_align(canvas, LV_ALIGN_TOP_LEFT, 0, OFFICE_TOP);
    lv_obj_clear_flag(canvas, LV_OBJ_FLAG_CLICKABLE);   // taps fall through to the screen

    buildLayout();
    renderBaseInto();
    syncRoomLabels();
    memcpy(buf, base, (size_t)W * H * sizeof(uint16_t));
    lv_obj_invalidate(canvas);
}

void setVisible(bool v) {
    if (!canvas) return;
    if (v) { lv_obj_clear_flag(canvas, LV_OBJ_FLAG_HIDDEN); syncRoomLabels(); }
    else   { lv_obj_add_flag(canvas, LV_OBJ_FLAG_HIDDEN); hideAllRoomLabels(); }
}

// ── movement on the block world ──
// Centre column of a worker's huddle — agents face inward toward their team.
static int podCenterCol(const Worker& w) {
    char nw[40]; normProject(w.project, nw, sizeof(nw));
    for (int i = 0; i < podCount; i++) {
        char key[40];
        if (sameProjectGroup(pods[i].project, nw, key, sizeof(key))) return pods[i].c + pods[i].w / 2;
    }
    return w.seatC;
}
static void targetFor(Worker& w, int& tc, int& tr) {
    tc = w.seatC; tr = w.seatR;                // always its slot in the project huddle (never leaves)
}
static bool stepWorker(Worker& w, uint32_t nowMs) {
    int self = (int)(&w - wk);
    int tc, tr; targetFor(w, tc, tr);
    if (w.col == tc && w.row == tr) return false;
    // BFS shortest path around props + other creatures. The old greedy axis walk
    // only ever tried the two direct moves, so a SEATED teammate in the corridor
    // wedged late arrivals permanently just outside their own huddle (repro:
    // sim `crowd` scene — two workers parked outside the AgentDeck pod forever).
    // The floor grid is tiny (≤ ~15×47 cells) and this runs on the 200ms logic
    // tick only, so a full BFS per moving worker is negligible.
    static constexpr int GRID_MAX = 32 * 48;
    if (cols * rows > GRID_MAX) return false;
    static int16_t from[GRID_MAX];
    static int16_t fifo[GRID_MAX];
    for (int i = 0; i < cols * rows; i++) from[i] = -1;
    auto cellId = [&](int c, int r) { return (int16_t)(r * cols + c); };
    int16_t start = cellId(w.col, w.row), goal = cellId(tc, tr);
    from[start] = start;
    int head = 0, tail = 0;
    fifo[tail++] = start;
    // Neighbor order biases toward the target axis so open-floor motion keeps
    // the old straight-line look; BFS levels guarantee the path stays shortest.
    int dxp = (tc > w.col) - (tc < w.col), dyp = (tr > w.row) - (tr < w.row);
    if (dxp == 0) dxp = 1; if (dyp == 0) dyp = 1;
    const int dirs[4][2] = {{dxp, 0}, {0, dyp}, {-dxp, 0}, {0, -dyp}};
    while (head < tail && from[goal] < 0) {
        int16_t cur = fifo[head++];
        int cc = cur % cols, cr = cur / cols;
        for (int t = 0; t < 4; t++) {
            int nc = cc + dirs[t][0], nr = cr + dirs[t][1];
            if (nc < 0 || nc >= cols || nr < 1 || nr >= rows) continue;
            int16_t nid = cellId(nc, nr);
            if (from[nid] >= 0) continue;
            if (workerCell(nc, nr, self)) continue;                          // never overlap another creature
            if (blockedCell(nc, nr) && !(tc == nc && tr == nr)) continue;    // avoid props
            from[nid] = cur;
            fifo[tail++] = nid;
        }
    }
    if (from[goal] < 0) return false;   // seat momentarily unreachable → wait a tick
    int16_t step = goal;
    while (from[step] != start) step = from[step];
    int nc = step % cols, nr = step / cols;
    int mx = nc - w.col, my = nr - w.row;
    w.prevCol = w.col; w.prevRow = w.row; w.stepAtMs = nowMs;
    w.col = nc; w.row = nr;
    w.facing = mx > 0 ? 'R' : mx < 0 ? 'L' : my < 0 ? 'U' : 'D';
    return true;
}

// ── per-frame draw ──
// Drawn parameters for a worker this frame (shared by the painter + the change-detector).
struct WDraw { int icx, icy, dw, dh, sz; float cx, cyT, jit; char bub; uint16_t bubCol;
               uint8_t galpha;            // creature opacity (resting agents dim in place)
               int ringR; uint16_t ringCol;   // pulsing floor glow for working agents (0 = none)
               int animPhase; };          // quantized animation phase → drives scene-skip redraws
static WDraw computeWorker(Worker& w, uint32_t now) {
    WDraw d{};
    float p = (now - w.stepAtMs) / 160.0f; if (p > 1) p = 1; if (p < 0) p = 0;
    int ax, ay, bx, by; tilePx(w.prevCol, w.prevRow, ax, ay); tilePx(w.col, w.row, bx, by);
    float cx = (ax + (bx - ax) * p) + tile / 2.0f;
    float cyT = (ay + (by - ay) * p) + tile / 2.0f;
    bool moving = p < 1 && (w.prevCol != w.col || w.prevRow != w.row);
    bool awaiting = strstr(w.state, "awaiting") != nullptr;
    bool error = strstr(w.state, "error") || strstr(w.state, "fail");
    bool disconnected = strcmp(w.state, "disconnected") == 0 || w.state[0] == '\0';
    bool idle = strcmp(w.state, "idle") == 0 || disconnected;
    bool working = strcmp(w.state, "processing") == 0;
    float yoff = 0, squash = 0, jit = 0;
    if (moving) { yoff = -sinf(p * 3.14159f) * tile * 0.26f; squash = sinf(p * 3.14159f) * 0.13f; }
    else if (awaiting) { float s = fabsf(sinf(now / 250.0f + w.bobPhase)); yoff = -s * tile * 0.18f; squash = s * 0.08f; }
    else if (working)  { float s = fabsf(sinf(now / 300.0f + w.bobPhase)); yoff = -s * tile * 0.10f; squash = s * 0.05f; }  // gentle "busy" bob
    else if (error)    { jit = sinf(now / 55.0f) * tile * 0.05f; }
    // Only awaiting / working / moving agents animate; a settled idle agent is fully STATIC
    // (constant sig → the scene-skip in update() idles the panel → far lower power draw).
    d.sz  = (int)(tile * 0.62f * (awaiting ? 1.08f : 1.0f));
    float cy = cyT + tile * 0.06f + yoff;
    d.cx = cx; d.cyT = cyT; d.jit = jit;
    d.icx = (int)(cx + jit + 0.5f); d.icy = (int)(cy + 0.5f);
    d.dw = (int)(d.sz * (1 - squash)); d.dh = (int)(d.sz * (1 + squash));
    d.bub = 0; d.bubCol = 0;
    d.galpha = idle ? 120 : 235;                     // resting agents dim in place
    d.ringR = 0; d.ringCol = 0; d.animPhase = 0;
    if (awaiting) {
        d.bub = '?'; d.bubCol = HEX565(0xFFA93D);
        d.animPhase = (int)((fabsf(sinf(now / 250.0f + w.bobPhase))) * 16);
    } else if (error) {
        d.bub = '!'; d.bubCol = HEX565(0xFF6B6B);
        d.animPhase = (int)(now / 55) & 0x0F;
    } else if (working && !moving) {                 // in place → bob + pulsing floor glow + spark
        d.bub = 'w'; d.bubCol = HEX565(0x3ED6E8);
        float pr = (sinf(now / 300.0f + w.bobPhase) * 0.5f + 0.5f);   // 0..1
        d.ringR = (int)(d.sz * (0.34f + 0.18f * pr));
        d.ringCol = HEX565(0x3ED6E8);
        d.animPhase = (int)(pr * 16);
    } else if (idle && !moving) {
        d.bub = 'z'; d.bubCol = HEX565(0x9fb0ac);    // static (no toggle → no redraw)
    }
    return d;
}
static uint32_t workerSig(Worker& w, uint32_t now) {   // hash of what's actually drawn
    WDraw d = computeWorker(w, now);
    uint32_t h = 2166136261u;
    h = (h * 16777619u) ^ (uint32_t)d.icx; h = (h * 16777619u) ^ (uint32_t)d.icy;
    h = (h * 16777619u) ^ (uint32_t)d.dw;  h = (h * 16777619u) ^ (uint32_t)d.dh;
    h = (h * 16777619u) ^ (uint32_t)d.bub; h = (h * 16777619u) ^ w.accent;
    h = (h * 16777619u) ^ (uint32_t)w.facing;   // L/R flip changes the drawn sprite
    h = (h * 16777619u) ^ (uint32_t)d.galpha;   // dim (resting) vs full opacity
    h = (h * 16777619u) ^ (uint32_t)d.ringR;    // glow ring size + phase → animate while working
    h = (h * 16777619u) ^ (uint32_t)d.animPhase;
    return h;
}
static void drawWorker(Worker& w, uint32_t now) {
    WDraw d = computeWorker(w, now);
    // pulsing floor glow under working agents — a soft colored halo that says "busy" at a glance
    if (d.ringR > 0) {
        int gcx = (int)(d.cx + d.jit), gcy = (int)(d.cyT + tile * 0.32f);
        int rw = d.ringR, rh = (int)(d.ringR * 0.42f); if (rh < 1) rh = 1;
        for (int dy = -rh; dy <= rh; dy++)
            for (int dx = -rw; dx <= rw; dx++) {
                float e = (float)(dx*dx)/(rw*rw+1) + (float)(dy*dy)/(rh*rh+1);
                if (e <= 1.0f) blendPx(gcx + dx, gcy + dy, d.ringCol, (uint8_t)(95.0f * (1.0f - e)));
            }
    }
    int shW = (int)(d.sz * 0.46f), shH = (int)(d.sz * 0.16f);
    for (int dy = -shH/2; dy <= shH/2; dy++)
        for (int dx = -shW/2; dx <= shW/2; dx++) {
            float e = (float)(dx*dx)/(shW*shW/4.0f+1) + (float)(dy*dy)/(shH*shH/4.0f+1);
            if (e <= 1.0f) blendPx((int)(d.cx+d.jit)+dx, (int)(d.cyT + tile*0.32f)+dy, HEX565(0x06120f), 120);
        }
    blitGlyph(agentGlyphA8(w.agent), d.icx, d.icy, d.dw, d.dh, HEX565((uint32_t)w.accent), w.facing == 'L', d.galpha);
    if (d.bub) drawBubble(d.icx + (int)(d.sz * 0.3f), d.icy - (int)(d.sz * 0.6f) - 5 * u, d.bub, d.bubCol);
}

static uint32_t lastDrawMs = 0, lastTickMs = 0, tickN = 0;
static bool forceFullDraw = true;   // force a full redraw on init + any layout/base rebuild

void update(float dt) {
    if (!canvas) return;
    uint32_t now = millis();

    // ── rebuild the worker list from live sessions (and re-pack pods if the set changed) ──
    char prevKey[MAXAG][48]; int prevN = nWk;
    for (int i = 0; i < prevN; i++) snprintf(prevKey[i], sizeof(prevKey[i]), "%s|%s", wk[i].id, wk[i].project);

    lockState();
    int n = 0;
    for (uint8_t s = 0; s < g_state.sessionCount && n < MAXAG; s++) {
        if (!g_state.sessions[s].alive) continue;
        const SessionInfo& si = g_state.sessions[s];
        Worker& w = wk[n];
        strncpy(w.agent, si.agentType, sizeof(w.agent)-1); w.agent[sizeof(w.agent)-1]='\0';
        strncpy(w.state, si.state, sizeof(w.state)-1); w.state[sizeof(w.state)-1]='\0';
        const char* pj = si.projectName[0] ? si.projectName : "session";
        strncpy(w.project, pj, sizeof(w.project)-1); w.project[sizeof(w.project)-1]='\0';
        strncpy(w.id, si.id, sizeof(w.id)-1); w.id[sizeof(w.id)-1]='\0';
        w.accent = agentColor(si.agentType);
        if (!w.active) {  // first appearance → enter from the "door" (bottom centre)
            w.active = true; w.col = cols/2; w.row = rows-1; w.prevCol = w.col; w.prevRow = w.row;
            w.stepAtMs = now; w.facing='U'; w.bobPhase = n * 0.9f;
        }
        n++;
    }
    unlockState();
    for (int i = n; i < MAXAG; i++) wk[i].active = false;
    nWk = n;

    // membership changed? re-pack pods (seats) + base.
    bool changed = (n != prevN);
    if (!changed) for (int i = 0; i < n; i++) { char k[48]; snprintf(k,sizeof(k),"%s|%s",wk[i].id,wk[i].project);
        bool found=false; for (int j=0;j<prevN;j++) if (strcmp(k,prevKey[j])==0){found=true;break;} if(!found){changed=true;break;} }
    if (changed) { buildLayout(); renderBaseInto(); syncRoomLabels(); forceFullDraw = true; }

    // ── logic tick @200ms (stepping + idle wander) ──
    if (now - lastTickMs >= 200) {
        lastTickMs = now; tickN++;
        for (int i = 0; i < nWk; i++) {
            Worker& w = wk[i];
            bool moved = stepWorker(w, now);
            if (!moved) {   // settled at its seat → face the team (pod centre)
                int fx = podCenterCol(w);
                if (fx < w.col) w.facing = 'L'; else if (fx > w.col) w.facing = 'R';
            }
        }
    }

    // ── render @~15fps (hop interpolation + bob run on this faster cadence) ──
    if (now - lastDrawMs < 66) return;
    lastDrawMs = now;

    // Scene-change skip: only pay the 607 KB memcpy + full-canvas flush when the drawn scene
    // actually changes. A still office (everyone idle/seated) hashes the same every frame, so
    // we bail here with just a cheap sig pass — keeping the panel snappy instead of redrawing
    // 15×/s for nothing. forceFullDraw covers init + any layout/base rebuild.
    static uint32_t lastSceneSig = 0;
    uint32_t sig = 2166136261u;
    for (int i = 0; i < nWk; i++) sig = (sig * 16777619u) ^ workerSig(wk[i], now);
    if (!forceFullDraw && sig == lastSceneSig) return;   // nothing visibly changed → skip
    forceFullDraw = false;
    lastSceneSig = sig;

    memcpy(buf, base, (size_t)W * H * sizeof(uint16_t));

    // workers painter's-order by row
    int ord[MAXAG]; for (int i = 0; i < nWk; i++) ord[i] = i;
    for (int a = 0; a < nWk; a++) for (int b = a+1; b < nWk; b++)
        if (wk[ord[b]].row < wk[ord[a]].row) { int t=ord[a]; ord[a]=ord[b]; ord[b]=t; }
    for (int k = 0; k < nWk; k++) drawWorker(wk[ord[k]], now);

    lv_obj_invalidate(canvas);
}

#endif  // BOARD_IPS10
}  // namespace Office
