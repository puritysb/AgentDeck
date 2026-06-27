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
// Agents are workers at desks on a tile grid. Stepped (snap) movement with a short hop, blocky
// fill-rect pixels — cheap on the P4. A STATIC base (carpet + grid + wall + windows + team-pod
// rugs/labels) is rendered once and memcpy'd each frame; only desks + workers + bubbles redraw,
// and the whole thing is capped at ~15 fps. That keeps the per-frame cost tiny vs. the old
// per-pixel aquarium (which fully recomputed 408×800 px every frame and stuttered).

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
// Wall a touch lighter than the mockup (#0c211d) so the band reads on the dim 10" panel,
// with a modest window glow — not the over-bright teal that was cluttering the caption area.
static const uint16_t C_wall = HEX565(0x0e241f), C_wallHi = HEX565(0x143731);
static const uint16_t C_window = HEX565(0x1f5048), C_windowGlow = HEX565(0x3d8576), C_sill = HEX565(0x0a1f1a);
static const uint16_t C_rug = HEX565(0x1d4a42), C_rug2 = HEX565(0x225751);
static const uint16_t C_deskTop = HEX565(0x34574f), C_deskHi = HEX565(0x3e655c), C_deskEdge = HEX565(0x1d342f);
static const uint16_t C_monFrame = HEX565(0x0a1916), C_monOff = HEX565(0x1a302b);
static const uint16_t C_bubble = HEX565(0x0a1714);
static const uint16_t C_label = HEX565(0xcfe6df), C_labelDim = HEX565(0x6f9a90);
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
    if (strstr(t, "claude"))   return 0xC07058;
    return 0x9aa0a8;
}
static const char* agentShort(const char* t) {
    if (!t) return "Agent";
    if (strstr(t, "openclaw")) return "OpenClaw";
    if (strstr(t, "codex"))    return "Codex";
    if (strstr(t, "opencode")) return "OpenCode";
    if (strstr(t, "claude"))   return "Claude";
    return "Agent";
}
// state → desk/bubble color (STATE.*.color)
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
    if (strstr(t, "codex"))    return CODEX_A8;
    if (strstr(t, "opencode")) return OPENCODE_A8;
    if (strstr(t, "claude"))   return OCTOPUS_A8;
    return nullptr;
}

// ── canvas ──
static lv_obj_t* canvas = nullptr;
static lv_draw_buf_t drawBuf;
static uint16_t* buf = nullptr;      // live frame
static uint16_t* base = nullptr;     // cached static scene (carpet+wall+windows+pods)
static bool baseDirty = true;
static int W = 0, H = 0;

// ── grid layout ──
static int tile = 40, cols = 7, rows = 14, gx = 0, gy = 0, u = 3, wallH = 24;
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

struct Worker {
    bool active = false;
    char agent[16], project[40], state[20], id[32];
    uint32_t accent;
    bool roamer = false;         // OpenClaw = mobile gateway: no desk, roams when active, corners when idle
    int seatC, seatR;            // desk cell (roamers: their resting corner)
    int col, row, prevCol, prevRow;
    uint32_t stepAtMs;
    int lingerC, lingerR; bool hasLinger;
    int wanderIn;
    int tmpC, tmpR; bool hasTmp; int tmpBackTick;
    char facing;                 // 'L','R','U','D'
    float bobPhase;
    uint32_t roamSeed;
};
static Worker wk[MAXAG];
static int nWk = 0;

// A desk cell belongs to a seated (non-roamer) worker.
static bool deskOccupied(int c, int r) {
    for (int i = 0; i < nWk; i++) if (wk[i].active && !wk[i].roamer && wk[i].seatC == c && wk[i].seatR == r) return true;
    return false;
}
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
static void blitGlyph(const uint8_t* a8, int cx, int cy, int dw, int dh, uint16_t col, bool flipX, uint8_t ga) {
    if (!a8 || dw <= 0 || dh <= 0) return;
    int x0 = cx - dw / 2, y0 = cy - dh / 2;
    for (int dy = 0; dy < dh; dy++) {
        int sy = dy * 64 / dh; if (sy > 63) sy = 63;
        const uint8_t* srow = a8 + sy * 64;
        for (int dx = 0; dx < dw; dx++) {
            int sx = dx * 64 / dw; if (sx > 63) sx = 63;
            uint8_t m = srow[flipX ? (63 - sx) : sx];
            if (m < 12) continue;
            blendPx(x0 + dx, y0 + dy, col, (uint8_t)((m * ga) / 255));
        }
    }
}

// ── 3×5 micro-glyphs for status bubbles (office.js GLY) ──
static const uint8_t GLY_q[5][3] = {{1,1,1},{0,0,1},{0,1,1},{0,0,0},{0,1,0}};
static const uint8_t GLY_b[5][3] = {{0,1,0},{0,1,0},{0,1,0},{0,0,0},{0,1,0}};
static const uint8_t GLY_z[5][3] = {{1,1,1},{0,0,1},{0,1,0},{1,0,0},{1,1,1}};
static void drawBubble(int bx, int by, char g, uint16_t col) {
    int bw = 5 * u, bh = 5 * u;
    blk(bx, by, bw, bh, C_bubble);
    blk(bx + u, by - u, bw - 2 * u, u, C_bubble);   // top notch
    blk(bx + u, by + bh, u, u, C_bubble);           // tail
    const uint8_t (*m)[3] = g == '?' ? GLY_q : g == '!' ? GLY_b : GLY_z;
    for (int r = 0; r < 5; r++) for (int c = 0; c < 3; c++)
        if (m[r][c]) blk(bx + (c + 1) * u, by + r * u, u, u, col);
}

// ── layout: tiles + project pods ──
static void buildLayout() {
    int mn = W < H ? W : H;
    tile = mn / 7; if (tile < 26) tile = 26; if (tile > 54) tile = 54;
    cols = W / tile; if (cols < 5) cols = 5;
    rows = H / tile; if (rows < 5) rows = 5;
    gx = (W - cols * tile) / 2;
    gy = (H - rows * tile) / 2;
    u = tile / 14; if (u < 2) u = 2;
    wallH = (int)(tile * 0.62f);

    // pack workers into project pods (team rooms); same project sits together
    podCount = 0;
    bool wide = W >= H;
    const int labelBand = 1, maxC = cols - 1;
    int curC = 1, curR = 1, rowH = 0;
    bool done[MAXAG] = {false};
    // Roamers (OpenClaw) don't sit at a project desk — give each a resting corner instead.
    const int corner[4][2] = { {1, rows - 2}, {cols - 2, rows - 2}, {1, 2}, {cols - 2, 2} };
    int roamN = 0;
    for (int a = 0; a < nWk; a++) {
        if (wk[a].roamer) {
            const int* cc = corner[roamN++ % 4];
            wk[a].seatC = cc[0]; wk[a].seatR = cc[1];
            done[a] = true;
        }
    }
    for (int a = 0; a < nWk; a++) {
        if (done[a]) continue;
        // gather members of this project
        int mem[MAXAG], mc = 0;
        for (int b = a; b < nWk; b++) if (!done[b] && strcmp(wk[b].project, wk[a].project) == 0) { mem[mc++] = b; done[b] = true; }
        int pc = (int)ceilf(sqrtf((float)mc)); int cap = wide ? 3 : 2;
        if (pc < 1) pc = 1; if (pc > cap) pc = cap;
        int pr = (mc + pc - 1) / pc;
        int wT = pc, hT = pr + labelBand;
        if (curC + wT > maxC && curC > 1) { curC = 1; curR += rowH + 1; rowH = 0; }
        Pod& pod = pods[podCount];
        strncpy(pod.project, wk[a].project, sizeof(pod.project) - 1); pod.project[sizeof(pod.project)-1] = '\0';
        pod.c = curC; pod.r = curR; pod.w = wT; pod.h = hT; pod.count = mc;
        for (int k = 0; k < mc; k++) {
            int sc = curC + (k % pc);
            int sr = curR + labelBand + k / pc; if (sr > rows - 2) sr = rows - 2;
            wk[mem[k]].seatC = sc; wk[mem[k]].seatR = sr;
        }
        podCount++;
        curC += wT + 1;
        if (hT > rowH) rowH = hT;
    }

    // Office props — a lounge (cooler + coffee), greenery and a filing cabinet around the
    // perimeter so the room reads as an office, not a classroom of rows. Skip any cell a desk
    // already owns; pods pack from the top-left so the bottom row + right edge are usually free.
    propCount = 0;
    const Prop cand[6] = {
        {1, 1, rows - 2}, {2, 2, rows - 2},          // water cooler + coffee (bottom-left lounge)
        {0, cols - 2, rows - 2}, {0, 1, 1},          // plants (bottom-right, top-left)
        {3, cols - 2, 1}, {0, cols - 2, rows / 2},   // cabinet (top-right) + a mid plant
    };
    for (int i = 0; i < 6 && propCount < (int)(sizeof(props)/sizeof(props[0])); i++) {
        const Prop& p = cand[i];
        if (p.c < 1 || p.c > cols - 1 || p.r < 1 || p.r > rows - 1) continue;
        if (deskOccupied(p.c, p.r)) continue;
        props[propCount++] = p;
    }
    baseDirty = true;
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

// ── static base render (carpet + grid + wall + windows + pod rugs + props) ──
static void renderBaseInto() {
    uint16_t* saveBuf = buf; buf = base;   // draw helpers target `base`
    // carpet checkerboard
    blk(0, 0, W, H, C_carpetA);
    for (int r = 0; r < rows; r++) for (int c = 0; c < cols; c++)
        if ((c + r) & 1) { int x, y; tilePx(c, r, x, y); blk(x, y, tile, tile, C_carpetB); }
    // faint grid seams
    for (int c = 0; c <= cols; c++) { int x = gx + c * tile; for (int y = gy; y < gy + rows * tile; y++) blendPx(x, y, C_carpetEdge, 90); }
    for (int r = 0; r <= rows; r++) { int y = gy + r * tile; for (int x = gx; x < gx + cols * tile; x++) blendPx(x, y, C_carpetEdge, 90); }
    // top wall band + highlight
    blk(0, 0, W, gy + wallH, C_wall);
    blk(0, gy + wallH - u, W, u, C_wallHi);
    // windows
    int winW = (int)(tile * 1.4f), gap = (int)(tile * 0.9f), x = gx + gap;
    while (x + winW < gx + cols * tile - gap) {
        blk(x, gy + u * 2, winW, wallH - u * 4, C_window);
        blk(x + u, gy + u * 2, u, wallH - u * 4, C_windowGlow);
        blk(x, gy + wallH - u * 2, winW, u, C_sill);
        x += winW + gap;
    }
    // pod rugs (team-room floor) — purely visual grouping; no text label.
    for (int i = 0; i < podCount; i++) {
        int px, py; tilePx(pods[i].c, pods[i].r, px, py);
        int rw = pods[i].w * tile, rh = pods[i].h * tile;
        int ry = py + (int)(tile * 0.82f);
        for (int yy = ry; yy < ry + (rh - (int)(tile * 0.82f) - u); yy++)
            for (int xx = px + u; xx < px + rw - u; xx++) blendPx(xx, yy, C_rug, 120);
    }
    // props (lounge + greenery + cabinet)
    for (int i = 0; i < propCount; i++) drawProp(props[i].kind, props[i].c, props[i].r);
    buf = saveBuf;
}

void init(lv_obj_t* parent) {
    if (canvas) return;
    W = OFFICE_W; H = g_screenH - OFFICE_TOP;   // sit below the full-width top bar
    buf  = (uint16_t*)ps_malloc((size_t)W * H * sizeof(uint16_t));
    base = (uint16_t*)ps_malloc((size_t)W * H * sizeof(uint16_t));
    if (!buf || !base) { Serial.println("[Office] buffer alloc failed"); return; }

    canvas = lv_canvas_create(parent);
    lv_draw_buf_init(&drawBuf, W, H, LV_COLOR_FORMAT_RGB565, W * sizeof(uint16_t), buf, (uint32_t)W * H * sizeof(uint16_t));
    lv_canvas_set_draw_buf(canvas, &drawBuf);
    lv_obj_align(canvas, LV_ALIGN_TOP_LEFT, 0, OFFICE_TOP);
    lv_obj_clear_flag(canvas, LV_OBJ_FLAG_CLICKABLE);   // taps fall through to the screen

    buildLayout();
    renderBaseInto();
    memcpy(buf, base, (size_t)W * H * sizeof(uint16_t));
    lv_obj_invalidate(canvas);
}

void setVisible(bool v) {
    if (!canvas) return;
    if (v) lv_obj_clear_flag(canvas, LV_OBJ_FLAG_HIDDEN);
    else   lv_obj_add_flag(canvas, LV_OBJ_FLAG_HIDDEN);
}

// ── movement (port of office.js step/target) ──
// Roamer (OpenClaw) free-floor target: a pseudo-random open cell, no desk, not occupied.
static void pickRoam(Worker& w, int self) {
    w.roamSeed = w.roamSeed * 1664525u + 1013904223u;   // LCG, no Math.random on firmware
    for (int tries = 0; tries < 12; tries++) {
        w.roamSeed = w.roamSeed * 1664525u + 1013904223u;
        int c = 1 + (int)((w.roamSeed >> 16) % (uint32_t)(cols > 2 ? cols - 2 : 1));
        int r = 2 + (int)((w.roamSeed >> 8) % (uint32_t)(rows > 4 ? rows - 4 : 1));
        if (!deskOccupied(c, r) && !workerCell(c, r, self) && !propCell(c, r)) { w.lingerC = c; w.lingerR = r; w.hasLinger = true; return; }
    }
    w.lingerC = w.seatC; w.lingerR = w.seatR; w.hasLinger = true;
}
static void targetFor(Worker& w, int& tc, int& tr) {
    if (w.hasTmp) { tc = w.tmpC; tr = w.tmpR; return; }
    if (w.roamer) {
        // OpenClaw: roams the whole floor while active; rests in its corner when idle.
        if (strcmp(w.state, "idle") == 0) { tc = w.seatC; tr = w.seatR; return; }
        if (!w.hasLinger) { int self = (int)(&w - wk); pickRoam(w, self); }
        tc = w.lingerC; tr = w.lingerR; return;
    }
    if (strcmp(w.state, "idle") == 0) {
        if (!w.hasLinger) {  // pick a free neighbour of the seat to loiter at
            const int dd[6][2] = {{0,1},{1,0},{-1,0},{1,1},{-1,1},{0,-1}};
            int self = (int)(&w - wk);
            w.lingerC = w.seatC; w.lingerR = w.seatR;
            for (int k = 0; k < 6; k++) {
                int c = w.seatC + dd[k][0], r = w.seatR + dd[k][1];
                if (c > 0 && c < cols - 1 && r > 1 && r < rows && !deskOccupied(c, r) && !workerCell(c, r, self) && !propCell(c, r)) { w.lingerC = c; w.lingerR = r; break; }
            }
            w.hasLinger = true;
        }
        tc = w.lingerC; tr = w.lingerR; return;
    }
    tc = w.seatC; tr = w.seatR;
}
static bool stepWorker(Worker& w, uint32_t nowMs) {
    int self = (int)(&w - wk);
    int tc, tr; targetFor(w, tc, tr);
    if (w.col == tc && w.row == tr) return false;
    int dx = (tc > w.col) - (tc < w.col), dy = (tr > w.row) - (tr < w.row);
    int order[2][2];
    if (abs(tc - w.col) >= abs(tr - w.row)) { order[0][0]=dx; order[0][1]=0; order[1][0]=0; order[1][1]=dy; }
    else                                    { order[0][0]=0; order[0][1]=dy; order[1][0]=dx; order[1][1]=0; }
    for (int t = 0; t < 2; t++) {
        int mx = order[t][0], my = order[t][1];
        if (!mx && !my) continue;
        int nc = w.col + mx, nr = w.row + my;
        if (nc < 0 || nc >= cols || nr < 1 || nr >= rows) continue;
        if (workerCell(nc, nr, self)) continue;            // never step onto another worker's cell
        if (propCell(nc, nr)) continue;                    // …or onto a prop (cooler/plant/cabinet)
        bool isDesk = deskOccupied(nc, nr);
        bool ownSeat = (nc == w.seatC && nr == w.seatR);
        if (isDesk && !ownSeat && !(tc == nc && tr == nr)) continue;
        w.prevCol = w.col; w.prevRow = w.row; w.stepAtMs = nowMs;
        w.col = nc; w.row = nr;
        w.facing = mx > 0 ? 'R' : mx < 0 ? 'L' : my < 0 ? 'U' : 'D';
        return true;
    }
    return false;
}

// ── per-frame draw ──
static void drawDesk(int seatC, int seatR, uint16_t screenCol, bool on) {
    int x, y; tilePx(seatC, seatR, x, y);
    int par = (seatC + seatR) & 1;
    // Stagger desks left/right + flip which way the desk faces by cell parity, so clustered
    // desks read as varied office pods instead of a classroom of identical aligned rows.
    int o = x + (tile - 14 * u) / 2 + (par ? -2 * u : 2 * u);
    bool faceUp = par;                                   // monitor on the far side from the worker
    int dy = faceUp ? (tile - 6 * u) : (1 * u);          // desk slab y within the cell
    blk(o, y + dy, 14 * u, 4 * u, C_deskTop);
    blk(o, y + dy, 14 * u, u, C_deskHi);
    blk(o, y + dy + 4 * u, 14 * u, u, C_deskEdge);
    int monY = faceUp ? (y + dy + 5 * u) : (y - u / 2);  // monitor below (faceUp) or above
    int monX = o + (par ? 4 * u : 4 * u);
    blk(monX, monY, 6 * u, 4 * u, C_monFrame);
    blk(monX + u, monY + (faceUp ? u : (int)(u * 0.5f)), 4 * u, (int)(2.4f * u), on ? screenCol : C_monOff);
}

// Drawn parameters for a worker this frame (shared by the painter + the change-detector).
struct WDraw { int icx, icy, dw, dh, sz; float cx, cyT, jit; char bub; uint16_t bubCol; };
static WDraw computeWorker(Worker& w, uint32_t now) {
    WDraw d{};
    float p = (now - w.stepAtMs) / 160.0f; if (p > 1) p = 1; if (p < 0) p = 0;
    int ax, ay, bx, by; tilePx(w.prevCol, w.prevRow, ax, ay); tilePx(w.col, w.row, bx, by);
    float cx = (ax + (bx - ax) * p) + tile / 2.0f;
    float cyT = (ay + (by - ay) * p) + tile / 2.0f;
    bool moving = p < 1 && (w.prevCol != w.col || w.prevRow != w.row);
    bool awaiting = strstr(w.state, "awaiting") != nullptr;
    bool error = strstr(w.state, "error") || strstr(w.state, "fail");
    bool idle = strcmp(w.state, "idle") == 0;
    float yoff = 0, squash = 0, jit = 0;
    if (moving) { yoff = -sinf(p * 3.14159f) * tile * 0.26f; squash = sinf(p * 3.14159f) * 0.13f; }
    else if (awaiting) { float s = fabsf(sinf(now / 250.0f + w.bobPhase)); yoff = -s * tile * 0.18f; squash = s * 0.08f; }
    else if (error)    { jit = sinf(now / 55.0f) * tile * 0.05f; }
    else               { yoff = sinf(now / (idle ? 900.0f : 520.0f) + w.bobPhase) * tile * (idle ? 0.025f : 0.05f); }
    d.sz  = (int)(tile * 0.62f * (awaiting ? 1.08f : 1.0f));
    float cy = cyT + tile * 0.06f + yoff;
    d.cx = cx; d.cyT = cyT; d.jit = jit;
    d.icx = (int)(cx + jit + 0.5f); d.icy = (int)(cy + 0.5f);
    d.dw = (int)(d.sz * (1 - squash)); d.dh = (int)(d.sz * (1 + squash));
    d.bub = 0; d.bubCol = 0;
    if (awaiting)      { d.bub = '?'; d.bubCol = HEX565(0xFFA93D); }
    else if (error)    { d.bub = '!'; d.bubCol = HEX565(0xFF6B6B); }
    else if (idle && !moving && ((now / 520) & 1)) { d.bub = 'z'; d.bubCol = HEX565(0x9fb0ac); }
    return d;
}
static uint32_t workerSig(Worker& w, uint32_t now) {   // hash of what's actually drawn
    WDraw d = computeWorker(w, now);
    uint32_t h = 2166136261u;
    h = (h * 16777619u) ^ (uint32_t)d.icx; h = (h * 16777619u) ^ (uint32_t)d.icy;
    h = (h * 16777619u) ^ (uint32_t)d.dw;  h = (h * 16777619u) ^ (uint32_t)d.dh;
    h = (h * 16777619u) ^ (uint32_t)d.bub; h = (h * 16777619u) ^ w.accent;
    return h;
}
static void drawWorker(Worker& w, uint32_t now) {
    WDraw d = computeWorker(w, now);
    int shW = (int)(d.sz * 0.46f), shH = (int)(d.sz * 0.16f);
    for (int dy = -shH/2; dy <= shH/2; dy++)
        for (int dx = -shW/2; dx <= shW/2; dx++) {
            float e = (float)(dx*dx)/(shW*shW/4.0f+1) + (float)(dy*dy)/(shH*shH/4.0f+1);
            if (e <= 1.0f) blendPx((int)(d.cx+d.jit)+dx, (int)(d.cyT + tile*0.32f)+dy, HEX565(0x06120f), 120);
        }
    blitGlyph(agentGlyphA8(w.agent), d.icx, d.icy, d.dw, d.dh, HEX565((uint32_t)w.accent), w.facing == 'L', 235);
    if (d.bub) drawBubble(d.icx + (int)(d.sz * 0.3f), d.icy - (int)(d.sz * 0.6f) - 5 * u, d.bub, d.bubCol);
}

static uint32_t lastDrawMs = 0, lastTickMs = 0, tickN = 0, stretchIn = 40;
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
        w.roamer = (strstr(si.agentType, "openclaw") != nullptr);  // gateway = mobile roamer
        if (!w.active) {  // first appearance → enter from the "door" (bottom centre)
            w.active = true; w.col = cols/2; w.row = rows-1; w.prevCol = w.col; w.prevRow = w.row;
            w.stepAtMs = now; w.facing='U'; w.hasLinger=false; w.hasTmp=false;
            w.wanderIn = 30 + (n*7)%40; w.bobPhase = n * 0.9f; w.roamSeed = (uint32_t)(n * 2654435761u + 12345u);
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
    if (changed) { buildLayout(); renderBaseInto(); forceFullDraw = true; }

    // ── logic tick @200ms (stepping + idle wander + occasional working "stretch") ──
    if (now - lastTickMs >= 200) {
        lastTickMs = now; tickN++;
        for (int i = 0; i < nWk; i++) {
            Worker& w = wk[i];
            if (w.hasTmp && w.col == w.tmpC && w.row == w.tmpR && (int)tickN > w.tmpBackTick) w.hasTmp = false;
            bool atTgt; { int tc,tr; targetFor(w,tc,tr); atTgt = (w.col==tc && w.row==tr); }
            if (w.roamer && strcmp(w.state, "idle") != 0) {
                // active OpenClaw keeps patrolling — short dwell, then a new floor target
                if (atTgt && --w.wanderIn <= 0) { w.hasLinger = false; w.wanderIn = 2 + (int)((i*5 + tickN) % 6); }
            } else if (strcmp(w.state, "idle") == 0 && atTgt && --w.wanderIn <= 0) {
                w.hasLinger = false; w.wanderIn = 30 + (i*13)%40;
            }
            stepWorker(w, now);
        }
        if (--stretchIn <= 0) {     // the 왔다갔다 beat — a working worker stretches its legs
            stretchIn = 40 + (tickN % 50);
            for (int i = 0; i < nWk; i++) {
                Worker& w = wk[i];
                if (strcmp(w.state,"processing")!=0 || w.hasTmp) continue;
                int tc,tr; targetFor(w,tc,tr); if (w.col!=tc || w.row!=tr) continue;
                const int sp[4][2] = {{0,1},{1,0},{-1,0},{0,2}};
                int pk = (i + tickN) % 4;
                int c = w.seatC + sp[pk][0], r = w.seatR + sp[pk][1];
                if (c>0 && c<cols-1 && r>1 && r<rows-1 && !deskOccupied(c,r)) { w.tmpC=c; w.tmpR=r; w.hasTmp=true; w.tmpBackTick=tickN+8; }
                break;
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
    for (int i = 0; i < nWk; i++) {
        Worker& w = wk[i]; if (w.roamer) continue;
        bool on = (w.col == w.seatC && w.row == w.seatR) && strcmp(w.state, "idle") != 0;
        sig = (sig * 16777619u) ^ (uint32_t)((w.seatC << 9) ^ (w.seatR << 4) ^ (on ? 1u : 0u) ^ stateColor(w.state));
    }
    if (!forceFullDraw && sig == lastSceneSig) return;   // nothing visibly changed → skip
    forceFullDraw = false;
    lastSceneSig = sig;

    memcpy(buf, base, (size_t)W * H * sizeof(uint16_t));

    // desks (lit only when owner present & active) — roamers have no desk
    for (int i = 0; i < nWk; i++) {
        Worker& w = wk[i];
        if (w.roamer) continue;
        bool present = (w.col == w.seatC && w.row == w.seatR);
        bool on = present && strcmp(w.state, "idle") != 0;
        drawDesk(w.seatC, w.seatR, HEX565((uint32_t)stateColor(w.state)), on);
    }
    // workers painter's-order by row
    int ord[MAXAG]; for (int i = 0; i < nWk; i++) ord[i] = i;
    for (int a = 0; a < nWk; a++) for (int b = a+1; b < nWk; b++)
        if (wk[ord[b]].row < wk[ord[a]].row) { int t=ord[a]; ord[a]=ord[b]; ord[b]=t; }
    for (int k = 0; k < nWk; k++) drawWorker(wk[ord[k]], now);

    lv_obj_invalidate(canvas);
}

#endif  // BOARD_IPS10
}  // namespace Office
