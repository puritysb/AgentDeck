#include "../src/audio/voice_endpoint.h"
#include <cassert>
#include <cstdio>
#include <cstdint>
using E=Audio::VoiceEndpoint;
static void room(E& e,uint16_t rms){for(int i=0;i<128;++i)e.observeNoise(rms);}
int main(){
    E e;room(e,900);
    for(int i=0;i<60;++i)e.observeNoise(5000);
    e.begin(0);assert(e.noise()==900);
    // Even a delayed cue and echo cannot create a command after a wake alone.
    for(uint32_t t=0;t<800;t+=16)
        assert(e.update(t,7000,16,t<600)==E::Result::Continue);
    assert(!e.heard());
    for(uint32_t t=800;t<6000;t+=16)
        assert(e.update(t,950,16)==E::Result::Continue);
    assert(e.update(6000,950,16)==E::Result::NoSpeech);
    e.begin(0);
    // A short sound after the cue is insufficient evidence of a command.
    for(uint32_t t=500;t<612;t+=16)e.update(t,9000,16);
    e.update(620,900,16);assert(!e.heard());
    for(uint32_t t=1000;t<=1400;t+=16)e.update(t,2600,16);
    assert(e.heard() && e.speaking());
    // A natural 900 ms pause within a sentence must not submit it.
    for(uint32_t t=1416;t<2300;t+=16)assert(e.update(t,900,16)==E::Result::Continue);
    for(uint32_t t=2300;t<=2700;t+=16)assert(e.update(t,2200,16)==E::Result::Continue);
    for(uint32_t t=2716;t<3900;t+=16)assert(e.update(t,900,16)==E::Result::Continue);
    assert(e.update(3900,900,16)==E::Result::Complete);
    // Speech resuming exactly at the deadline gets time to confirm its onset.
    e.begin(0);
    for(uint32_t t=500;t<=900;t+=16)e.update(t,2600,16);
    for(uint32_t t=2100;t<=2300;t+=16)assert(e.update(t,2600,16)==E::Result::Continue);
    E late;room(late,100);late.begin(0);
    for(uint32_t t=5990;t<=6230;t+=16)assert(late.update(t,700,16)==E::Result::Continue);
    assert(late.heard());
    E quiet;room(quiet,40);uint32_t base=UINT32_MAX-300;quiet.begin(base);
    for(uint32_t dt=500;dt<=900;dt+=16)quiet.update(base+dt,350,16);
    assert(quiet.heard());assert(quiet.update(base+2100,45,16)==E::Result::Complete);
    puts("Endpoint: wake-only, delayed cue/echo, clicks, natural pauses, late/soft speech and clock wrap PASS");
}
