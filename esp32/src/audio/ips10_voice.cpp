#include "../../boards/board_config.h"
#if defined(BOARD_IPS10)
#include "mic_capture.h"
#include "voice_endpoint.h"
#include "wake_word.h"
#include "speaker_playback.h"
#include "es8311_codec.h"
#include "../net/ws_client.h"
#include "../net/wifi_manager.h"
#include "../ui/widgets/hud_bar.h"
#include "../ui/widgets/ips10_workspace.h"
#include "../util/memory.h"
#include <Arduino.h>
#include <atomic>
#include <cmath>
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

namespace Audio {
namespace {
constexpr size_t RATE = 16000, MAX_SAMPLES = RATE * 31, PRE_SAMPLES = RATE / 4;
constexpr uint32_t MAX_MS = 30000;
VoiceEndpoint endpoint;
std::atomic<uint16_t> noiseLevel{80}, speechThreshold{196}, quietMs{0};
std::atomic<bool> speechActive{false}, speechHeard{false};
// One owner task reads I2S, maintains the frontend and lends a frozen upload buffer.
// No UI/network callback reads I2S or writes capture buffers.
std::atomic<bool> ready{false}, capturing{false};
std::atomic<uint16_t> level{0};
std::atomic<uint32_t> started{0}, resultAt{0};
std::atomic<bool> deliveredResult{false}, replyAllowed{true};
std::atomic<uint32_t> replyGeneration{0};
enum class Phase { Idle, Listening, Sending, Transcribing, Waiting, Speaking, Error };
std::atomic<Phase> phase{Phase::Idle};
TaskHandle_t task = nullptr;
portMUX_TYPE commandMux = portMUX_INITIALIZER_UNLOCKED;
enum class Command { None, Start, Stop, Cancel };
Command command = Command::None;
Command pendingStop = Command::None;
char requestedSession[40]{};
// Device-lifetime PSRAM storage, not stack/internal DMA: at most 1,000,000 B.
int16_t* utterance = nullptr;
int16_t* pre = nullptr;
static int16_t raw[512], mono[512];
size_t prePos = 0, preCount = 0, used = 0;
char session[40]{};
bool active = false, automatic = false;
uint32_t closeAt = 0, cooldownUntil = 0, waitingSince = 0;
bool closing = false, wasSuppressed = true, pendingNotice = false;
int slot = -1;

// ES8311 RX has historically supplied interleaved signal + empty slots despite
// MONO configuration. Detect that shape without discarding real mono input.
size_t normalize(size_t samples) {
    unsigned zeros[2] = {0,0};
    for (size_t i=0;i<samples;++i) if (raw[i]>=-2 && raw[i]<=2) ++zeros[i&1];
    size_t half=samples/2;
    if (half && zeros[1]*100>=half*95 && zeros[0]*100<half*95) slot=0;
    else if (half && zeros[0]*100>=half*95 && zeros[1]*100<half*95) slot=1;
    // Keep the established framing through digital silence. Reset at boot.
    size_t n=0;
    for(size_t i=slot<0?0:size_t(slot);i<samples;i+=slot<0?1:2) mono[n++]=raw[i];
    return n;
}
void beginCapture(const char* target, bool wake) {
    if (!Net::wifiConnected() || Net::voiceUploadBusy()) {
        capturing=false; phase=Phase::Error; HUD::notify("Voice needs WiFi - try again"); return;
    }
    snprintf(session,sizeof(session),"%s",target);
    IPS10Workspace::voiceStarted(target);
    ++replyGeneration; replyAllowed=true;resultAt=0;
    automatic=wake; closing=false; used=0;
    if (wake) {
        // Keep the end of the wake word + immediate command onset. The host
        // recognizer receives the entire utterance; it is never re-recorded.
        for(size_t i=0;i<preCount;++i) utterance[used++]=pre[(prePos+PRE_SAMPLES-preCount+i)%PRE_SAMPLES];
    }
    started=millis();endpoint.begin(started);
    noiseLevel=endpoint.noise();speechThreshold=endpoint.threshold();
    quietMs=0;speechActive=false;speechHeard=false;
    active=true; capturing=true; phase=Phase::Listening;
    HUD::setListening(wake?"OpenClaw - listening":"Listening");
    playTone(1047,120,0.28f);
    Serial.printf("[WakeVoice] capture %s target=%s noise=%u threshold=%u\n",wake?"wake":"PTT",session,unsigned(endpoint.noise()),unsigned(endpoint.threshold()));
}
void finish(bool cancel) {
    if(cancel) {replyAllowed=false;++replyGeneration;}
    speechActive=false;
    active=false; capturing=false; closing=false; automatic=false; cooldownUntil=millis()+1000;
    WakeWord::reset(); preCount=0;
    if(cancel || !used) {phase=Phase::Idle;HUD::notify(cancel?"Voice cancelled":"Heard nothing");return;}
    // The network borrows this buffer until voiceUploadBusy() clears.
    // beginCapture refuses every new recording during that ownership window.
    bool queued=Net::queueVoiceHttpUpload(reinterpret_cast<uint8_t*>(utterance),used*2,
        "ips_10",session,RATE,uint32_t(used*1000/RATE));
    waitingSince=millis(); pendingNotice=false; phase=queued?Phase::Sending:Phase::Error;
    HUD::notify(queued?"OpenClaw - sending":"Voice upload failed - try again");
    Serial.printf("[WakeVoice] capture end samples=%u queued=%d\n",unsigned(used),int(queued));
}
void run(void*) {
    bool kws=WakeWord::init();
    Serial.printf("[WakeVoice] continuous capture ready, kws=%d\n",int(kws));
    for(;;) {
        Command next; char target[40];
        portENTER_CRITICAL(&commandMux);
        next=command;command=Command::None;
        if(next==Command::None) {next=pendingStop;pendingStop=Command::None;}
        memcpy(target,requestedSession,sizeof(target));
        portEXIT_CRITICAL(&commandMux);
        if(next==Command::Start) { if(playbackActive()) playbackStop(); beginCapture(target,false); }
        if(next==Command::Cancel) finish(true);
        if(next==Command::Stop && active) {closing=true;closeAt=millis()+300;}
        size_t bytes=captureRead(reinterpret_cast<uint8_t*>(raw),sizeof(raw));
        if(!bytes) {vTaskDelay(pdMS_TO_TICKS(10));continue;}
        size_t n=normalize(bytes/2);
        uint64_t sum=0;int64_t signedSum=0;
        for(size_t i=0;i<n;++i) {int32_t v=mono[i];sum+=uint64_t(v*v);signedSum+=v;}
        const double mean=n?double(signedSum)/n:0;
        const double variance=n?double(sum)/n-mean*mean:0;
        uint16_t rms=variance>0?uint16_t(sqrt(variance)):0;level=rms;
        uint32_t now=millis();
        if(active) {
            size_t add=n<MAX_SAMPLES-used?n:MAX_SAMPLES-used;
            memcpy(utterance+used,mono,add*sizeof(int16_t));used+=add;
            const auto decision=endpoint.update(now,rms,uint32_t(n*1000/RATE),playbackActive());
            speechActive=endpoint.speaking();speechHeard=endpoint.heard();
            quietMs=uint16_t(endpoint.quietMs(now)>65535?65535:endpoint.quietMs(now));
            if(closing && int32_t(now-closeAt)>=0) finish(false);
            else if(now-started.load()>=MAX_MS || used==MAX_SAMPLES) finish(false);
            else if(automatic && decision!=VoiceEndpoint::Result::Continue) {
                Serial.printf("[VoiceEndpoint] %s elapsedMs=%lu quietMs=%u rms=%u threshold=%u\n",
                    decision==VoiceEndpoint::Result::Complete?"complete":"no-speech",
                    (unsigned long)(now-started.load()),unsigned(quietMs.load()),unsigned(rms),unsigned(endpoint.threshold()));
                finish(decision==VoiceEndpoint::Result::NoSpeech);
                if(decision==VoiceEndpoint::Result::NoSpeech)HUD::notify("No speech detected - try again");
            }
            vTaskDelay(1);continue;
        }
        if(phase==Phase::Sending && !Net::voiceUploadBusy()) phase=Phase::Transcribing;
        uint32_t result=resultAt.exchange(0);
        if(result) {phase=deliveredResult?Phase::Waiting:Phase::Error;waitingSince=now;}
        bool playback=playbackActive();
        if(playback) {phase=Phase::Speaking;cooldownUntil=now+700;}
        else if(phase==Phase::Speaking) phase=Phase::Idle;
        if(phase==Phase::Sending || phase==Phase::Transcribing || phase==Phase::Waiting) {
            if(now-waitingSince>25000 && !pendingNotice) {
                pendingNotice=true;
                HUD::notify(phase==Phase::Sending?"Still sending audio":phase==Phase::Transcribing?"Still recognizing speech":"OpenClaw is still working");
            }
            // Host personal turns can run for ten minutes. Explicit re-wake
            // supersedes their reply generation; silence alone does not.
            // A lost result must nevertheless have a bounded recovery path.
            if(now-waitingSince>11*60*1000) {
                phase=Phase::Error;replyAllowed=false;++replyGeneration;
                HUD::notify("Voice response timed out - try again");
            }
        }
        bool suppressed=!WakeWord::enabled() || playback || Net::voiceUploadBusy() ||
            phase==Phase::Sending || int32_t(now-cooldownUntil)<0;
        if(suppressed) {if(!wasSuppressed) WakeWord::reset();wasSuppressed=true;preCount=0;}
        else {
            if(wasSuppressed) WakeWord::reset();wasSuppressed=false;
            endpoint.observeNoise(rms);
            for(size_t i=0;i<n;++i) {pre[prePos]=mono[i];prePos=(prePos+1)%PRE_SAMPLES;if(preCount<PRE_SAMPLES)++preCount;}
            if(WakeWord::process(mono,n)) {
                Serial.printf("[WakeVoice] detected score=%u\n",unsigned(WakeWord::score()));
                beginCapture("openclaw-personal",true);
            }
        }
        vTaskDelay(1);
    }
}
}
bool micInit() {
    if(ready) return true;
    if(!playbackInit() || !captureReady() || !Es8311::begin(RATE)) return false;
    utterance=static_cast<int16_t*>(heap_caps_malloc(MAX_SAMPLES*2,MALLOC_CAP_SPIRAM));
    pre=static_cast<int16_t*>(heap_caps_malloc(PRE_SAMPLES*2,MALLOC_CAP_SPIRAM));
    if(!utterance || !pre) {free(utterance);free(pre);utterance=pre=nullptr;Serial.println("[WakeVoice] no PSRAM");return false;}
    // P4 optimized kernels need >8KB stack; internal allocation once at startup.
    if(xTaskCreate(run,"ips10_voice",12288,nullptr,3,&task)!=pdPASS) {
        free(utterance);free(pre);utterance=pre=nullptr;Serial.println("[WakeVoice] task allocation failed");return false;
    }
    replyGeneration=esp_random();
    ready=true;return true;
}
bool micReady(){return ready;}
bool micCapturing(){return capturing;}
uint32_t micElapsedMs(uint32_t now){return capturing?now-started.load():0;}
void micStart(const char* target){
    if(!ready || !target || !target[0])return;
    bool expected=false;if(!capturing.compare_exchange_strong(expected,true))return;
    portENTER_CRITICAL(&commandMux);
    snprintf(requestedSession,sizeof(requestedSession),"%s",target);command=Command::Start;
    portEXIT_CRITICAL(&commandMux);
}
bool micReplyAllowed(){return replyAllowed;}
uint32_t micReplyGeneration(){return replyGeneration;}
void micStop(bool cancel){
    if(cancel){replyAllowed=false;++replyGeneration;}
    portENTER_CRITICAL(&commandMux);pendingStop=cancel?Command::Cancel:Command::Stop;portEXIT_CRITICAL(&commandMux);
}
void micPump(){} // single lifetime task owns I2S, including manual PTT
uint16_t micLevel(){return level;}
MicFeedback micFeedback(){return {level.load(),noiseLevel.load(),speechThreshold.load(),quietMs.load(),speechActive.load(),speechHeard.load()};}
void micVoiceResult(bool delivered){deliveredResult=delivered;resultAt=millis();}
const char* voiceState(){
    switch(phase.load()){
        case Phase::Listening:return "listening";case Phase::Sending:return "sending";
        case Phase::Transcribing:return "transcribing";case Phase::Waiting:return "waiting";case Phase::Speaking:return "speaking";
        case Phase::Error:return "error";default:return WakeWord::enabled()?"wake":"muted";
    }
}
}
#endif
