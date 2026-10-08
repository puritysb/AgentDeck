#include "crayfish.h"
#include "draw.h"
#include "creature_glyphs_generated.h"
#include "../theme.h"
#include "config.h"
#include <cmath>

/**
 * Front-facing crayfish — canonical OpenClaw mark rendered from a generated mask.
 *
 * DORMANT:  completely still, dropped down, dimmed (alpha 0.4)
 * SITTING:  nearly still on rocks, subtle heartbeat glow only
 * ROUTING:  signal waves, glow, eye flash
 * SICK:     desaturated and offset
 */

constexpr float SVG_VB = 120.0f;
constexpr float HEARTBEAT_PERIOD = 4.0f;

namespace Crayfish {

void init() {}

void render(uint16_t* buf, int w, int h, float time, CrayfishState state) {
    if (state == CrayfishState::DORMANT) return;

    // Body size from layout config
    float bodyW = w * Layout::CfWidthFrac;
    float scale = bodyW / SVG_VB;

    int cx = (int)(Layout::CfHomeX * w);
    int baseY;

    uint32_t shellColor = Theme::CrayfishShell;
    uint32_t shellDark = Theme::CrayfishDark;
    uint8_t alpha = 255;
    float vertBob = 0;

    switch (state) {
        case CrayfishState::SITTING: {
            baseY = (int)(Layout::CfSittingY * h);
            // Nearly still — matches Android's 0.008f factor (imperceptible)
            vertBob = fastSin(time * 0.5f) * bodyW * 0.008f;

            // Heartbeat glow (4s double-pulse) — very subtle
            float cycle = fmodf(time, HEARTBEAT_PERIOD);
            float pulse = 0;
            if (cycle < 0.15f) {
                pulse = fastSin(cycle / 0.15f * M_PI);
            } else if (cycle >= 0.25f && cycle < 0.40f) {
                pulse = fastSin((cycle - 0.25f) / 0.15f * M_PI) * 0.6f;
            }
            if (pulse > 0.01f) {
                int glowR = (int)(bodyW * (0.25f + pulse * 0.08f));
                Draw::circle(cx, baseY, glowR, Theme::CrayfishEye, (uint8_t)(pulse * 20));
            }
            break;
        }

        case CrayfishState::ROUTING: {
            baseY = (int)(Layout::CfRoutingY * h);
            vertBob = fastSin(time * 3.0f) * bodyW * 0.05f;

            // Body color pulse
            float colorPulse = (fastSin(time * 4.0f) * 0.5f + 0.5f) * 0.3f;
            shellColor = lerpColor(Theme::CrayfishShell, Theme::CrayfishBodyLight, colorPulse);
            shellDark = lerpColor(Theme::CrayfishDark, Theme::CrayfishShell, colorPulse);

            // Shell glow
            float glow = fastSin(time * 4.0f) * 0.5f + 0.5f;
            int glowR = (int)(bodyW * (0.4f + glow * 0.15f));
            Draw::circle(cx, baseY, glowR, Theme::CrayfishEye, (uint8_t)(glow * 38));

            // Signal waves (arcs behind creature)
            for (int i = 0; i < 4; i++) {
                float prog = fmodf(time * 2.0f + i * 0.25f, 1.0f);
                int waveR = (int)(bodyW * 0.3f + prog * w * 0.15f);
                uint8_t waveAlpha = (uint8_t)((1.0f - prog) * 90);
                for (int a = 120; a < 240; a += 3) {
                    float rad = a * M_PI / 180.0f;
                    int wx = cx + (int)(fastCos(rad) * waveR);
                    int wy = baseY + (int)(fastSin(rad) * waveR);
                    Draw::pixelA(wx, wy, Theme::CrayfishEye, waveAlpha);
                    Draw::pixelA(wx + 1, wy, Theme::CrayfishEye, waveAlpha / 2);
                }
            }
            break;
        }

        case CrayfishState::SICK: {
            baseY = (int)(Layout::CfSittingY * h) + (int)(bodyW * 0.08f);
            vertBob = fastSin(time * 0.7f) * bodyW * 0.02f;
            alpha = 178;
            shellColor = lerpColor(Theme::CrayfishShell, 0x8B7B7B, 0.55f);
            shellDark = lerpColor(Theme::CrayfishDark, 0x5A4A4A, 0.55f);
            break;
        }

        default:
            return;
    }

    int cy = baseY + (int)vertBob;

    // Exact design/brand/openclaw.svg mark. State animation moves/tints the
    // generated mask but never reconstructs the claws, antennae, or body.
    int bodyBox = max(1, (int)(120 * scale));
    int tiltOffX = state == CrayfishState::SICK ? (int)(bodyBox * 0.04f) : 0;
    int bodyX0 = cx - bodyBox / 2 + tiltOffX;
    int bodyY0 = cy - bodyBox / 2;
    Draw::alphaMaskGradient(CreatureGlyphs::OPENCLAW_MARK_A8,
                            CreatureGlyphs::OPENCLAW_MARK_W, CreatureGlyphs::OPENCLAW_MARK_H,
                            bodyX0, bodyY0, bodyBox, bodyBox, shellColor, shellDark, alpha);
    Draw::featureLayers(CreatureGlyphs::OPENCLAW_MARK_FEATURES, CreatureGlyphs::OPENCLAW_MARK_FEATURE_COUNT,
                        CreatureGlyphs::OPENCLAW_MARK_W, CreatureGlyphs::OPENCLAW_MARK_H,
                        bodyX0, bodyY0, bodyBox, bodyBox, alpha);

}

}  // namespace Crayfish
