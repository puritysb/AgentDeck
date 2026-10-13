#include "ui/matrix/matrix_reading.h"
#include "ui/matrix/matrix_font.h"
#include <cassert>
#include <cstring>

int main() {
    char out[8];
    struct Case { const char* in; const char* expected; int width; };
    const Case cases[] = {
        {"2h 48m", "2H48M", 6}, {"12h 34m", "12H34M", 6},
        {"5d 4h", "5D4H", 6}, {"8m", "8M", 6}, {"now", "NOW", 6},
        {"0m", "0M", 6}, {"", "--", 6}, {nullptr, "--", 6},
        {"~7/28", "--", 6}, {"unknown", "--", 6}, {"999999999d", "--", 6},
        {"12h 34m", "12H+", 5}, {"12hBAD", "--", 6},
        {"3h 2d", "--", 6}, {"2h 4h", "--", 6}, {"   ", "--", 6}
    };
    for (const auto& c : cases) {
        MatrixReading::resetText(c.in, c.width, out);
        assert(!std::strcmp(out, c.expected));
        assert(MatrixFont::textWidth(out) <= c.width * 4 - 1);
    }
    assert(9 + MatrixFont::textWidth("12H34M") == 32);
    assert(!MatrixReading::countdown(1.99f));
    assert(MatrixReading::countdown(2));
    assert(MatrixReading::countdown(5.99f));
    assert(!MatrixReading::countdown(6));
    assert(!MatrixReading::second(5.99f, true, true));
    assert(MatrixReading::second(6, true, true));
    assert(MatrixReading::second(11.99f, true, true));
    assert(!MatrixReading::second(12, true, true));
    assert(MatrixReading::second(0, false, true));
    assert(!MatrixReading::second(8, true, false));
    assert(MatrixFont::charToIndex('+') != 0);
    MatrixReading::Clock clock;
    assert(!clock.advance(3, true, MatrixReading::PairSeconds));
    assert(MatrixReading::countdown(clock.elapsed()));
    assert(!clock.advance(60, false, MatrixReading::PairSeconds));
    assert(clock.elapsed() == 3); // HOLD keeps the very same time/window phase.
    assert(!MatrixReading::second(clock.elapsed(), true, true));
    assert(!clock.advance(3, true, MatrixReading::PairSeconds));
    assert(MatrixReading::second(clock.elapsed(), true, true));
    assert(clock.advance(6, true, MatrixReading::PairSeconds));
    assert(clock.elapsed() == 0); // Resume reaches next page; no paused-time jump.
    clock.advance(3, true, MatrixReading::PairSeconds);
    clock.reset(); // Manual page navigation starts at the provider introduction.
    assert(!MatrixReading::countdown(clock.elapsed()));
}
