#pragma once

#include <stdint.h>

// Serial-primary WiFi radio parking, as a pure decision.
//
// The rule: while the daemon drives a board over USB serial, serial IS the
// transport, and the 2.4 GHz radio only burns power and shared airtime. Park it
// once serial has been stable for a few seconds; restore it the moment serial
// goes away so WiFi (and WiFi OTA) recover.
//
// The decision reads the radio's ACTUAL parked state, never a private copy.
// Until 2026-10-07 the parking loop kept its own `static bool radioParked`,
// while `wifi_provision` (sent by the daemon's legacy token re-arm) restarted
// WiFi through wifiConnectWith() behind its back. The copy still said "parked",
// so the radio was never parked again: measured on the desk, EPD47 and NM ran
// USB and WiFi side by side for a day after one re-arm.
//
// `deferBootJoin` boards (the battery-capable e-ink panels) boot with the radio
// parked and join WiFi only once serial has had `bootGraceMs` to speak up: a
// desk unit on USB never associates at all, and an unplugged one joins a few
// seconds later than it used to.
namespace RadioPark {

enum class Action : uint8_t { None, Park, Restore };

struct Input {
    bool serialPrimary = false;   // serial JSON received recently
    bool parked = false;          // the radio's real state (Net::wifiRadioParked())
    uint32_t serialStableMs = 0;  // how long serialPrimary has held
    uint32_t uptimeMs = 0;
    bool deferBootJoin = false;
};

constexpr uint32_t PARK_AFTER_MS = 4000;
constexpr uint32_t BOOT_GRACE_MS = 10000;

inline Action decide(const Input& in, uint32_t parkAfterMs = PARK_AFTER_MS,
                     uint32_t bootGraceMs = BOOT_GRACE_MS) {
    if (in.serialPrimary)
        return (!in.parked && in.serialStableMs > parkAfterMs) ? Action::Park : Action::None;
    if (!in.parked) return Action::None;
    if (in.deferBootJoin && in.uptimeMs < bootGraceMs) return Action::None;
    return Action::Restore;
}

}  // namespace RadioPark
