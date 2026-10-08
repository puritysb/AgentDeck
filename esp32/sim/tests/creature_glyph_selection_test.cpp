#include "ui/creature_glyph_selection.h"
#include "ui/companion/ci_companion.h"
#include <cassert>
#include <initializer_list>
int main() {
    static_assert(sizeof(CiCompanion::Memo[10]) == 240, "Other boards keep their original ten-owner cache");
    for (const char* unknown : std::initializer_list<const char*>{nullptr, "", "future-agent", "codex-future", "kiro-future", "monitor", "daemon"}) {
        const auto glyph = CreatureGlyphs::selectAgent(unknown);
        assert(!glyph.alpha && !glyph.features && glyph.featureCount == 0);
    }
    const auto claude = CreatureGlyphs::selectAgent("claude-code");
    assert(claude.alpha && claude.featureCount && claude.features[0].red == 0 && claude.lightMonoBody);
    assert(CreatureGlyphs::selectAgent("claude").alpha == claude.alpha);
    const auto codex = CreatureGlyphs::selectAgent("codex-app");
    assert(codex.alpha && codex.featureCount && codex.features[0].red == 255 && !codex.lightMonoBody);
    assert(CreatureGlyphs::selectAgent("codex-cli").alpha == codex.alpha);
    const auto openclaw = CreatureGlyphs::selectAgent("openclaw");
    assert(openclaw.alpha && openclaw.featureCount == 2 && openclaw.lightMonoBody);
    assert(openclaw.features[0].creatureMonochromeInk && !openclaw.features[1].creatureMonochromeInk);
    const auto opencode = CreatureGlyphs::selectAgent("opencode");
    assert(opencode.alpha && opencode.featureCount == 0);
    for (const char* agent : {"kiro-cli", "kiro-ide", "antigravity", "hermes", "zai"})
        assert(CreatureGlyphs::selectAgent(agent).alpha);
}
