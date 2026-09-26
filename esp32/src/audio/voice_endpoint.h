#pragma once
#include <cstddef>
#include <cstdint>

// IPS10 acoustic endpointing, independent of I2S/LVGL for deterministic tests.
// Energy is evidence of sound, not a partial transcript. Keep all audio until
// the endpoint; short pauses and low-energy consonants must not be trimmed.
namespace Audio {
class VoiceEndpoint {
public:
    static constexpr uint32_t SilenceMs=1200, NoSpeechMs=6000, CueGuardMs=450;
    enum class Result { Continue, Complete, NoSpeech };
    void observeNoise(uint16_t rms) {
        history_[cursor_]=rms;cursor_=(cursor_+1)%128;
        if(count_<128)++count_;
    }
    void begin(uint32_t now) {
        // Lower quintile of ~2 s before the wake: speech in the wake word
        // cannot raise the threshold as quickly as an exponential average.
        for(size_t i=0;i<count_;++i) sorted_[i]=history_[i];
        for(size_t i=1;i<count_;++i) {
            uint16_t value=sorted_[i];size_t j=i;
            while(j && sorted_[j-1]>value){sorted_[j]=sorted_[j-1];--j;}
            sorted_[j]=value;
        }
        noise_=count_>=16?sorted_[count_/5]:80;
        if(noise_<60)noise_=60;
        uint32_t threshold=uint32_t(noise_)*17/10+60;
        threshold_=threshold>30000?30000:static_cast<uint16_t>(threshold);
        start_=lastSpeech_=cueAt_=now;runMs_=voicedMs_=0;heard_=speaking_=false;
    }
    Result update(uint32_t now,uint16_t rms,uint32_t frameMs,bool cuePlaying=false) {
        // Ignore acoustic evidence during actual output and its echo tail.
        // PCM remains intact, including commands spoken over the cue.
        if(cuePlaying)cueAt_=now;
        if(now-start_<CueGuardMs || cuePlaying || now-cueAt_<200){speaking_=false;return Result::Continue;}
        const uint32_t hold=uint32_t(noise_)*13/10+40;
        const bool above=rms>=(heard_?hold:threshold_);
        if(above) {
            runMs_+=frameMs;
            voicedMs_+=frameMs;
            // Reject isolated keyboard clicks and short tone echoes.
            if(runMs_>=64 && voicedMs_>=160){heard_=true;lastSpeech_=now;}
        } else {
            runMs_=0;
            if(!heard_)voicedMs_=0;
        }
        speaking_=above && runMs_>=64;
        // Do not close during a new onset that has not yet met the 64 ms
        // confirmation window (e.g. speech resumes at the silence deadline).
        if(!above && heard_ && now-lastSpeech_>=SilenceMs)return Result::Complete;
        if(!above && !heard_ && now-start_>=NoSpeechMs)return Result::NoSpeech;
        return Result::Continue;
    }
    bool heard() const{return heard_;}
    bool speaking() const{return speaking_;}
    uint32_t quietMs(uint32_t now) const{return heard_?now-lastSpeech_:0;}
    uint16_t noise() const{return noise_;}
    uint16_t threshold() const{return threshold_;}
private:
    // Audio-owner lifetime storage: 512 B, no heap or per-frame sorting.
    uint16_t history_[128]{},sorted_[128]{};
    size_t count_=0,cursor_=0;
    uint16_t noise_=80,threshold_=196;
    uint32_t start_=0,lastSpeech_=0,cueAt_=0,runMs_=0,voicedMs_=0;
    bool heard_=false,speaking_=false;
};
}
