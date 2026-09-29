// Unity-include wrapper for the real TRMNL 7.5" e-ink render tree (direct-draw
// GxEPD2, no LVGL). Self-gated on BOARD_TRMNL_75. See fw/renderer.cpp for the
// per-env compilation rationale.
//
// The SimEink render entry point lives HERE (after the include) rather than in a
// separate file because the firmware's `display` object sits in eink_display.cpp's
// anonymous namespace — only code in this same translation unit can read the host
// framebuffer the GxEPD2_BW shim accumulated.
#include "../../../src/ui/eink/eink_display.cpp"

#ifdef BOARD_TRMNL_75
#include "../sim.h"
#include <Arduino.h>
#include <cstdlib>
#include <cassert>

// Panel bus instance (declared extern in the SPI shim). No real transfer on host.
SimSPIClass SPI;

bool SimEink::renderToPng(const char* scene, const char* path) {
  const bool simulateDecision = std::strcmp(scene, "decision") == 0;
  const bool aquarium = std::strcmp(scene, "aquarium") == 0;
  const bool aquariumOffline = std::strcmp(scene, "aquarium-offline") == 0;
  if (!SimScenes::apply(aquarium ? "multi" : aquariumOffline ? "offline" : simulateDecision ? "permission" : scene)) return false;
  Eink::init();
#if !defined(BOARD_SIM_PULL)
  if (aquarium) {
    // Exercise the actual footer hash: transient tool text must not spend an
    // EPD cycle, but a GLM change must. These are intentionally not a mirror hash.
    static Snap sample; snapshot(sample);
    sample.bridgeConnected = true; sample.usageStale = false; sample.zaiP = 10;
    const uint32_t before = paperHash(sample, PaperFace::Aquarium);
    strncpy(sample.tickerText[0], "different milestone", sizeof(sample.tickerText[0]));
    strncpy(sample.rows[0].work, "different tool call", sizeof(sample.rows[0].work));
    assert(before == paperHash(sample, PaperFace::Aquarium));
    sample.zaiP = 11;
    assert(before != paperHash(sample, PaperFace::Aquarium));
    sample.usageStale = true;
    const uint32_t stale = paperHash(sample, PaperFace::Aquarium);
    sample.zaiP = 12;
    assert(stale == paperHash(sample, PaperFace::Aquarium));
  }
#endif
#if !defined(BOARD_SIM_PULL)
  manualFace = (aquarium || aquariumOffline) ? PaperFace::Aquarium : PaperFace::Glance;
#endif
#if defined(BOARD_SIM_PULL)
  if (simulateDecision) {
    // Pixel-exact post-primary-action state: the real pull boards open an
    // eight-minute interactive lease before DECISION becomes eligible.
    interactiveLeaseUntilMs = g_sim_millis + FACE_HOLD_MS;
    faceHoldUntilMs = 0;
    suppressedDecisionHash = 0;
  }
#endif
#if defined(AGENTDECK_EPD47_UI)
  // SIM_EPD47_PAGE=limits renders the EPD47 Limits page (reached by touch on
  // the device) so its provider cards can be reviewed without hardware.
  if (const char* page = std::getenv("SIM_EPD47_PAGE"))
    if (std::strcmp(page, "limits") == 0) {
      epd47Page = AgentDeckEpd47::Page::Limits;
      epd47PageHoldUntilMs = g_sim_millis + 3600000;   // as a touch would hold it
    }
#endif
  // render() is content-hash + min-refresh-interval gated. In an --all run these
  // statics persist across scenes with millis() otherwise frozen, so advance the
  // virtual clock past the coalesce window and render twice to force a fresh draw.
  g_sim_millis += 3600;
  Eink::render();
  g_sim_millis += 3600;
  Eink::render();

  const uint8_t* buf = display.hostBuffer();   // anon-namespace global, visible here
  const int W = display.hostWidth(), H = display.hostHeight();
  if (!buf) return false;

  // Host ink codes (0..15 grayscale level, 16 = red) → RGB565 for the shared
  // PNG writer. Red appears only on the tri-color NM face and intermediate
  // levels only on the EPD47; the other panels emit 0/15 alone, so this is a
  // no-op for them.
  uint16_t* img = static_cast<uint16_t*>(std::malloc((size_t)W * H * sizeof(uint16_t)));
  if (!img) return false;
  for (int i = 0; i < W * H; i++) {
    if (buf[i] == 16) { img[i] = 0xF800; continue; }
    const uint8_t g = (uint8_t)(buf[i] * 17);         // 0..15 → 0..255
    img[i] = (uint16_t)(((g & 0xF8) << 8) | ((g & 0xFC) << 3) | (g >> 3));
  }
  bool ok = SimPng::writeRgb565(path, img, W, H);
  std::free(img);
  return ok;
}
#endif  // BOARD_TRMNL_75
