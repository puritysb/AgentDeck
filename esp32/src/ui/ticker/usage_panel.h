#pragma once
// Provider-card USAGE panel for LVGL pages that rebuild on change (the
// T-Display-S3-Pro Focus Strip and Pocket). One card per UsageRows group:
// brand-dot header with the plan tier, then up to two slots — a window
// (label, percent, bar, reset) or the provider's plan in the slot a missing
// window leaves. Cards sit side by side (`columns`) or stack.

#include <lvgl.h>
#include "../../util/usage_rows.h"

namespace UsagePanel {

struct Fonts {
    const lv_font_t* small;   // labels, resets, plan until
    const lv_font_t* header;  // provider name
    const lv_font_t* value;   // percent / tier
};

uint32_t providerColor(UsageRows::Provider p);

// Build the cards into `parent` inside the rect. Objects are created fresh —
// callers clean the parent on their own signature change.
void render(lv_obj_t* parent, int x, int y, int w, int h,
            const UsageRows::Group* groups, uint8_t count, bool columns, const Fonts& fonts);

}  // namespace UsagePanel
