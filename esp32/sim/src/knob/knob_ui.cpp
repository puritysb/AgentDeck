// Unity-include wrapper for the T-Embed "Companion Knob" render tree. Same
// rationale as src/fw/renderer.cpp: compiling the firmware source through the
// sim's own src_dir builds it under .pio/build/<env>/ with THIS env's board
// defines, instead of freezing them in a shared object. Pass-through only —
// the firmware stays the single copy of the UI.
#include "../../../src/ui/knob/knob_ui.cpp"
