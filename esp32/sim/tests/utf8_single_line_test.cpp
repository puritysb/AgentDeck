#include "util/utf8.h"
#include <cassert>
#include <cstring>
int main() {
    char ascii[] = "first\r\nsecond\tthird";
    Utf8::singleLine(ascii);
    assert(strcmp(ascii, "first  second third") == 0);
    char korean[] = "한글\n다음";
    Utf8::singleLine(korean);
    assert(strcmp(korean, "한글 다음") == 0);
    char cut[] = {'x', (char)0xed, (char)0x95, 0};
    Utf8::singleLine(cut);
    assert(strcmp(cut, "x") == 0);
    Utf8::singleLine(nullptr);
}
