#include "../src/audio/pcm_write.h"
#include <cassert>
#include <vector>
int main() {
    const uint8_t pcm[]={1,2,3,4,5};
    std::vector<uint8_t> output; output.reserve(sizeof(pcm));
    auto shortWrite=[&](const uint8_t* p,size_t n){size_t take=n>2?2:n;output.insert(output.end(),p,p+take);return take;};
    assert(Audio::writePcmFully(pcm,5,shortWrite,[]{return false;})==5);
    assert(output==std::vector<uint8_t>(pcm,pcm+5));
    int calls=0;
    assert(Audio::writePcmFully(pcm,5,[&](const uint8_t*,size_t){return ++calls==1?size_t(2):size_t(0);},[]{return false;})==2);
    assert(calls==2);
    calls=0;
    assert(Audio::writePcmFully(pcm,5,[&](const uint8_t*,size_t){++calls;return size_t(2);},[&]{return calls==1;})==2);
    assert(Audio::writePcmFully(pcm,5,shortWrite,[]{return true;})==0);
}
