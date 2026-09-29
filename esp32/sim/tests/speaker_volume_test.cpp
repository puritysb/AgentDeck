// Compile the actual codec against NVS/I2C doubles, not a copied volume policy.
#define BOARD_IPS10
#include "../../src/audio/es8311_codec.cpp"
#include <cassert>

SimSerial Serial;
namespace UI {
static uint8_t registers[256]{};
bool hwI2cReadReg8(uint8_t, uint8_t reg, uint8_t* out) {
    *out = reg == 0xfd ? 0x83 : reg == 0xfe ? 0x11 : registers[reg];
    return true;
}
bool hwI2cWriteReg8(uint8_t, uint8_t reg, uint8_t value) {
    registers[reg] = value;
    return true;
}
}
int main() {
    assert(Es8311::present());
    assert(Es8311::volume() == 40);
    assert(Es8311::begin(16000));
    assert(UI::registers[0x32] == 0x77 && Preferences::writes == 0);
    assert(Es8311::setUserVolume(30));
    assert(Preferences::stored == 30 && Preferences::writes == 1);
    assert(Es8311::setUserVolume(30) && Preferences::writes == 1);
    Es8311::setVolume(70); // diagnostic adjustment must not overwrite user choice
    assert(Es8311::begin(16000) && Preferences::writes == 1);
    Es8311::loadVolume(); // boot-time read restores the persisted choice
    assert(Es8311::volume() == 30);
    Preferences::writeOk = false;
    assert(!Es8311::setUserVolume(40));
    assert(Es8311::volume() == 40 && Preferences::stored == 30);
    Preferences::writeOk = true;
    assert(Es8311::setUserVolume(40) && Preferences::stored == 40);
    Preferences::stored = 200; // corrupt/out-of-range setting falls back to board default
    Es8311::s_volume = BOARD_SPK_DEFAULT_VOLUME; Es8311::s_savedVolume = -1;
    Es8311::loadVolume();
    assert(Es8311::volume() == 40);
    Preferences::openOk = false;
    assert(!Es8311::setUserVolume(50));
}
