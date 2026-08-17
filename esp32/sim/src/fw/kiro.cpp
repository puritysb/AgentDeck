// Unity-include wrapper. Compiling the firmware terrarium source through the
// sim's own src_dir forces PlatformIO to build it under the per-env build dir
// (.pio/build/<env>/) with THIS env's board defines. Referencing it directly via
// build_src_filter's ../.. path instead lands the object in a shared
// .pio/build/src/, freezing board #if branches (IS_ROUND, canvas format, MAX_*)
// to whichever env compiled first — a cross-board correctness bug. Do not inline
// the source here; keep it a pass-through so the firmware stays the single copy.
#include "../../../src/ui/terrarium/kiro.cpp"
