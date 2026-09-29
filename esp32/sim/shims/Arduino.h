#pragma once
// Host shim for <Arduino.h> — provides the tiny slice of the Arduino core that
// the AgentDeck terrarium render surface actually touches (millis/micros, a
// stderr Serial, map(), a deterministic random(), and ps_malloc → malloc).
//
// Deliberately does NOT define the Arduino min()/max() macros: the firmware
// uses `using std::min/max`, and the macros would break those call sites.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstdarg>
#include <cstring>
#include <cstddef>
#include <string>
// Pre-load the libstdc++ headers whose inline min()/max() members would
// otherwise be macro-expanded after the BOARD_TRMNL_75 min/max macros below
// (gcc/libstdc++ builds; libc++ never trips this). Include guards make any
// later transitive include a no-op, so the macros never see these bodies.
// <cmath> matters too: on gcc it drags in bits/specfun.h + tr1 internals
// whose numeric_limits<>::max() calls the macro would corrupt.
#include <algorithm>
#include <limits>
#include <cmath>
#include <chrono>
#include <random>

// Arduino String / flash-string types referenced by Adafruit_GFX.h signatures.
// The e-ink path only uses the const char* overloads, but the types must exist.
class __FlashStringHelper;
class String {
  std::string _s;
public:
  String() {}
  String(const char* s) : _s(s ? s : "") {}
  unsigned length() const { return (unsigned)_s.size(); }
  char charAt(unsigned i) const { return i < _s.size() ? _s[i] : '\0'; }
  char operator[](unsigned i) const { return charAt(i); }
  const char* c_str() const { return _s.c_str(); }
};

// Adafruit_GFX.h keys off ARDUINO >= 100 to include Arduino.h/Print.h (vs the
// legacy WProgram.h) — declare a modern version so it takes the right branch.
#ifndef ARDUINO
#define ARDUINO 10819
#endif

#if defined(BOARD_TRMNL_75)
// The e-ink render tree + Adafruit_GFX use Arduino's min()/max() macros. Safe to
// define here: this env never compiles the terrarium (which relies on the real
// std::min/max, which these macros would shadow).
#ifndef max
#define max(a, b) ((a) > (b) ? (a) : (b))
#endif
#ifndef min
#define min(a, b) ((a) < (b) ? (a) : (b))
#endif
#endif

// GPIO no-ops (e-ink panel reset/busy pins).
#ifndef INPUT
#define INPUT 0
#endif
#ifndef OUTPUT
#define OUTPUT 1
#endif
#ifndef INPUT_PULLUP
#define INPUT_PULLUP 2
#endif
#ifndef HIGH
#define HIGH 1
#endif
#ifndef LOW
#define LOW 0
#endif
inline void pinMode(int, int) {}
inline void digitalWrite(int, int) {}
inline int  digitalRead(int) { return 0; }

// Arduino math helpers used by Adafruit_GFX (fillArc etc.).
#include <cmath>
#ifndef PI
#define PI 3.1415926535897932384626433832795
#endif
inline double radians(double deg) { return deg * (PI / 180.0); }
inline double degrees(double rad) { return rad * (180.0 / PI); }
#ifndef constrain
#define constrain(x, lo, hi) ((x) < (lo) ? (lo) : ((x) > (hi) ? (hi) : (x)))
#endif

// Virtual clock. Advanced by the sim driver (SimDisplay::tick) so rendered
// frames are deterministic and reproducible instead of wall-clock dependent.
extern unsigned long g_sim_millis;
inline unsigned long millis() { return g_sim_millis; }
inline unsigned long micros() { return g_sim_millis * 1000UL; }
inline void delay(unsigned long) {}
inline void delayMicroseconds(unsigned int) {}

// Arduino map() — integer range remap.
inline long map(long x, long in_min, long in_max, long out_min, long out_max) {
  if (in_max == in_min) return out_min;
  return (x - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
}

// Deterministic Arduino random() (seeded in sim_main for reproducible frames).
long arduino_random(long howbig);
long arduino_random(long howsmall, long howbig);
void randomSeed(unsigned long seed);
// Arduino exposes these as random(); alias without colliding with POSIX random(void).
#define random(...) arduino_random(__VA_ARGS__)

// PROGMEM / flash-read helpers (AVR-era; plain deref on host). Used by the
// matrix glyph tables (matrix_font.h).
#ifndef PROGMEM
#define PROGMEM
#endif
inline uint8_t  pgm_read_byte(const void* p) { return *reinterpret_cast<const uint8_t*>(p); }
inline uint16_t pgm_read_word(const void* p) { return *reinterpret_cast<const uint16_t*>(p); }
inline uint32_t pgm_read_dword(const void* p) { return *reinterpret_cast<const uint32_t*>(p); }
inline void*    pgm_read_ptr(const void* p) { return *reinterpret_cast<void* const*>(p); }

// PSRAM allocators → host heap.
inline void* ps_malloc(size_t n) { return std::malloc(n); }
inline void* ps_calloc(size_t n, size_t s) { return std::calloc(n, s); }
inline void* ps_realloc(void* p, size_t n) { return std::realloc(p, n); }

// Minimal Serial → stderr (keeps stdout clean for potential piping).
struct SimSerial {
  void begin(unsigned long) {}
  void print(const char* s) { std::fputs(s, stderr); }
  void print(int v) { std::fprintf(stderr, "%d", v); }
  void println(const char* s) { std::fputs(s, stderr); std::fputc('\n', stderr); }
  void println(int v) { std::fprintf(stderr, "%d\n", v); }
  void println() { std::fputc('\n', stderr); }
  int printf(const char* fmt, ...) {
    va_list ap; va_start(ap, fmt);
    int r = std::vfprintf(stderr, fmt, ap); va_end(ap); return r;
  }
};
extern SimSerial Serial;
