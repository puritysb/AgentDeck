#include "config.h"
#if defined(BOARD_IPS10)
#include "ips10_workspace.h"
#include "ips10_ocean_generated.h"
#include "ips10_relief_claude_generated.h"
#include "ips10_relief_codex_generated.h"
#include "ips10_relief_openclaw_generated.h"
#include "../assets/logo.h"
#include "audio/mic_capture.h"
#include "audio/wake_word.h"
#include "../../util/usage_presentation.generated.h"
#include "../../util/collaboration_presentation.generated.h"
#include "../theme.h"
#include "../display.h"
#include "../../state/agent_state.h"
#include "../../util/utf8.h"
#include "../../util/memory.h"
#include "../../util/usage_format.h"
#include "../../util/usage_rows.h"
#include <Arduino.h>
#include "net/serial_client.h"
#include <cstdio>
#include <cstring>

LV_FONT_DECLARE(font_workspace_20);
LV_FONT_DECLARE(font_workspace_36);
LV_FONT_DECLARE(font_studio_28);
LV_FONT_DECLARE(font_studio_20);
LV_FONT_DECLARE(font_studio_16);

namespace IPS10Workspace {
namespace {
// IPS10 layout rhythm: outer 24, inter-panel 16, content inset 16.
namespace Grid { constexpr int Outer=24, Gap=16, Inset=16, Header=96, AgentRow=120; }
// Fixed stores avoid label heap churn while live state changes. LVGL owns the
// widgets; these stores are reused across orientation rebuilds, never allocated
// in update(). Only the selected session's eight newest events are copied.
template<size_t N> struct Text {
    lv_obj_t* obj = nullptr;
    char value[N] = {};
    void set(const char* s) {
        char normalized[N];
        snprintf(normalized, N, "%s", s?s:"");
        Utf8::utf8TrimEnd(normalized);
        Utf8::sanitizeLvglText(normalized);
        if (!strcmp(value, normalized)) return;
        snprintf(value,N,"%s",normalized);
        lv_label_set_text_static(obj, value);
    }
};
struct Row {
    char id[32], name[40], agent[16], state[20], tool[40], project[40];
    char activity[160], latest[120], hm[6];
    uint16_t children, latestRank; bool childrenKnown;
    uint32_t elapsed;
};
static Row rows[10];
static SessionInfo selected;
static TimelineEntry events[8];
static int count, eventCount, filter;
static char selectedId[32] = "";
static char presentedId[32] = "";
static bool history, voiceOpen, connected, overviewMode=true;
static uint32_t lastUpdate;
static lv_obj_t *root, *rail, *detail, *voicePane, *filters[4], *cards[10], *marks[10], *eventBox, *activityScroll;
static lv_obj_t *stateNodes[4], *eventCards[8], *historyButton, *focusGlyph;
static Text<12> censusValue[4];
static Text<80> link, summary, rosterTitle, heading, identity, stateText, census, empty;
static Text<200> activity, instruction;
static Text<56> rowTitle[10], rowState[10];
static Text<96> rowTool[10];
static Text<240> eventText[8];
static Text<64> eventMeta[8];
static Text<32> filterText[4], filterNumber[4], historyLabel;
static const lv_image_dsc_t* (*glyphFor)(const char*);
static int detailW, sceneW;
// Bounded, device-lifetime widget pools: ten projects / ten creatures total.
// The static ocean is cached once; live updates never allocate frame canvases.
static lv_obj_t *overview, *viewButton, *resourcePane, *pods[10], *seats[10], *creatures[10];
static Text<40> podName[10], seatState[10];
static Text<240> voiceHeard;
static Text<480> voiceSaid;
static Text<64> voiceAnswerLabel;
struct VoiceSnapshot { char target[40], question[240], answer[480], notice[160]; };
static VoiceSnapshot voicePending{}, voiceView{};
static portMUX_TYPE voiceMux = portMUX_INITIALIZER_UNLOCKED;
static Text<100> podStatus[10], overviewEmpty;
static Text<200> podLatest[10], ambientVoice;
static Text<120> attentionLine;
static Text<128> pageLabel;
static Text<160> agentActivity[10];
static Text<40> cohortLabel[10], childLabel[10];
static bool gatewayReady=false, retainedDetail=false;
static lv_obj_t* recentCaption;
// USAGE: one card per provider (UsageRows order). Header = brand mark, name
// and plan pill; up to two window rows = label, percent, bar, reset.
struct UsageSlot { lv_obj_t *track, *fill; Text<24> label; Text<8> value; Text<32> reset; };
struct UsageCard { lv_obj_t *card, *mark; Text<16> name; Text<40> plan; UsageSlot slot[2]; };
static UsageCard usageCards[UsageRows::MAX_GROUPS];
static lv_obj_t* modeButtons[2];
static lv_obj_t* voiceButton;
static lv_obj_t* voiceMeter;
static lv_obj_t* voiceBars[7];
static Text<96> voiceCaptureHint;
static Text<32> voiceControlLabel;
static uint32_t voiceLastUpdate=0;
static char lastVoicePhase[24]{};
static int meterLevel=0;

// Cache the static ocean after scaling/blending, once per orientation. Only
// this cold-path image source lives in PSRAM; hot LVGL/PPA draw buffers stay
// internal. Device-lifetime owner, at most 2,048,000 B: too large for stack or
// scarce SRAM, reused across screen rebuilds rather than allocated per frame.
static uint8_t* oceanPixels=nullptr;
static int oceanWidth=0, oceanHeight=0;
static constexpr size_t OceanBytes=1280*800*2;
static bool cachedOcean(lv_obj_t* parent, int w, int h) {
    const size_t bytes=lv_draw_buf_width_to_stride(w,LV_COLOR_FORMAT_RGB565)*h;
    if(bytes>OceanBytes)return false;
    if(!oceanPixels) {
        oceanPixels=static_cast<uint8_t*>(heap_caps_malloc(OceanBytes,MALLOC_CAP_SPIRAM));
        if(!oceanPixels){Serial.println("[Workspace] ocean cache unavailable; using flash source");return false;}
        logHeap("ips10-ocean-cache");
    }
    auto* canvas=lv_canvas_create(parent);
    lv_canvas_set_buffer(canvas,oceanPixels,w,h,LV_COLOR_FORMAT_RGB565);
    lv_obj_set_pos(canvas,0,0);lv_obj_clear_flag(canvas,LV_OBJ_FLAG_CLICKABLE);
    if(oceanWidth!=w || oceanHeight!=h) {
        lv_canvas_fill_bg(canvas,lv_color_hex(Theme::DeepSea),LV_OPA_COVER);
        // LVGL applies the same scale, antialiasing and opacity as the original
        // image widget; this work runs only during screen initialization.
        static lv_layer_t layer;
        static lv_draw_image_dsc_t draw;
        lv_canvas_init_layer(canvas,&layer);
        lv_draw_image_dsc_init(&draw);draw.src=&IPS10Ocean::image;
        draw.scale_x=draw.scale_y=w*400>=h*640?w*256/640:h*256/400;
        draw.pivot={0,0};draw.opa=LV_OPA_30;
        const int x=-(640*draw.scale_x/256-w)/2;
        lv_area_t area={x,0,x+639,399};
        lv_draw_image(&layer,&draw,&area);lv_canvas_finish_layer(canvas,&layer);
        oceanWidth=w;oceanHeight=h;
    }
    return true;
}

static int displayedSlot[10];
static lv_obj_t *voiceStatusPane, *attentionPane;
static int page=0, pageCount=1;
static uint32_t pageSince=0;
static bool pageHeld=false;
static char projectKeys[10][40];
static UsageRows::Group usageGroups[UsageRows::MAX_GROUPS];
static uint8_t usageGroupCount=0;
static int podFor[10], memberSlot[10], podMembers[10], projectCount;
static uint32_t brandColor(const char* agent) {
    if(!strcmp(agent,"claude-code") || !strcmp(agent,"claude")) return Theme::ClaudeBody;
    if(!strcmp(agent,"codex") || !strcmp(agent,"codex-cli") || !strcmp(agent,"codex-app")) return Theme::CloudBody;
    if(!strcmp(agent,"openclaw")) return Theme::CrayfishShell;
    if(!strncmp(agent,"kiro",4)) return Theme::KiroMark;
    if(!strcmp(agent,"antigravity")) return Theme::AntigravityMark;
    return Theme::OpenCodeOuter;
}
// Three flash-resident 112px reliefs (110.25 KiB total), shared by all seats.
// Unsupported agents retain their canonical glyph; unknown agents remain hidden.
static const lv_image_dsc_t* reliefFor(const char* agent) {
    if(!strcmp(agent,"claude-code") || !strcmp(agent,"claude"))return &IPS10Relief_claude::image;
    if(!strcmp(agent,"codex") || !strcmp(agent,"codex-cli") || !strcmp(agent,"codex-app"))return &IPS10Relief_codex::image;
    if(!strcmp(agent,"openclaw"))return &IPS10Relief_openclaw::image;
    return nullptr;
}
static portMUX_TYPE diagMux=portMUX_INITIALIZER_UNLOCKED;
static Diagnostics diag{};

static lv_obj_t* box(lv_obj_t* parent, int x, int y, int w, int h, uint32_t color) {
    auto* o = lv_obj_create(parent);
    lv_obj_set_pos(o,x,y); lv_obj_set_size(o,w,h);
    lv_obj_set_style_bg_color(o,lv_color_hex(color),0);
    lv_obj_set_style_bg_opa(o,LV_OPA_COVER,0);
    lv_obj_set_style_border_width(o,0,0);
    lv_obj_set_style_radius(o,16,0); lv_obj_set_style_pad_all(o,0,0);
    lv_obj_clear_flag(o,LV_OBJ_FLAG_SCROLLABLE);
    return o;
}
template<size_t N> static void label(Text<N>& t, lv_obj_t* p, int x,int y,int w,const lv_font_t* font,uint32_t color) {
    t.value[0]=0; t.obj=lv_label_create(p);
    lv_obj_set_pos(t.obj,x,y); lv_obj_set_width(t.obj,w);
    lv_obj_set_style_text_font(t.obj,font,0);
    lv_obj_set_style_text_color(t.obj,lv_color_hex(color),0);
    lv_label_set_long_mode(t.obj,LV_LABEL_LONG_DOT);
    lv_label_set_text_static(t.obj,t.value);
}
static void caption(lv_obj_t* p,const char* s,int x,int y,int w,uint32_t color=Theme::HUDDim) {
    auto* l=lv_label_create(p); lv_label_set_text_static(l,s);
    lv_obj_set_pos(l,x,y);lv_obj_set_width(l,w);
    lv_obj_set_style_text_font(l,&font_studio_20,0);
    lv_obj_set_style_text_color(l,lv_color_hex(color),0);
}
// ASCII label width from the public glyph API (usage rows are ASCII).
static int textWidth(const char* s,const lv_font_t* font) {
    int w=0;for(;*s;++s)w+=lv_font_get_glyph_width(font,static_cast<uint8_t>(*s),static_cast<uint8_t>(s[1]));
    return w;
}
static void visible(lv_obj_t* o,bool v) {
    if(v) lv_obj_clear_flag(o,LV_OBJ_FLAG_HIDDEN); else lv_obj_add_flag(o,LV_OBJ_FLAG_HIDDEN);
}
static int category(const char* s) {
    if(!strncmp(s,"awaiting",8) || !strcmp(s,"error")) return 1;
    if(!strcmp(s,"processing")) return 2;
    return 3;
}
static uint32_t colorFor(int c) { return c==1?Theme::StatusAmber:c==2?Theme::StatusBlue:Theme::HUDDim; }
static const char* nameFor(int c) { return c==1?"Attention":c==2?"Working":"Idle"; }
static bool matches(const Row& r) { return !filter || category(r.state)==filter; }
static void selectCb(lv_event_t* e) {
    const int i=static_cast<int>(reinterpret_cast<intptr_t>(lv_event_get_user_data(e)));
    if(i<0 || i>=count) return;
    snprintf(selectedId,sizeof(selectedId),"%s",rows[i].id);
    overviewMode=false; retainedDetail=false; history=false; lastUpdate=0; update();
}
static void filterCb(lv_event_t* e) {
    filter=static_cast<int>(reinterpret_cast<intptr_t>(lv_event_get_user_data(e)));
    page=0;pageSince=millis();
    lastUpdate=0; update();
    lv_obj_scroll_to_y(rail,0,LV_ANIM_OFF);
}
static void historyCb(lv_event_t*) { history=!history;lastUpdate=0;update();lv_obj_scroll_to_y(eventBox,0,LV_ANIM_OFF); }
static void viewCb(lv_event_t*) { overviewMode=!overviewMode;if(overviewMode)filter=0;lastUpdate=0;update(); }
static void pageCb(lv_event_t*) { pageHeld=!pageHeld;lastUpdate=0;update(); }
static void modeCb(lv_event_t* e) { overviewMode=lv_event_get_user_data(e)==nullptr;lastUpdate=0;update(); }
static void voiceCb(lv_event_t*) {
    if(!strcmp(Audio::voiceState(),"listening")){Audio::micStop(false);return;}
    voiceOpen=!voiceOpen;visible(voicePane,voiceOpen);
}
// Fast, small-area feedback runs before the 250 ms dashboard-data throttle.
// A phase transition bypasses even this 50 ms meter cadence. No state-lock
// walk or per-frame buffer allocation is needed to show microphone activity.
static void updateVoice(uint32_t now,bool force=false) {
    const char* phase=Audio::voiceState();
    const bool changed=strcmp(lastVoicePhase,phase)!=0;
    if(!changed && !force && voiceLastUpdate && now-voiceLastUpdate<50)return;
    voiceLastUpdate=now?now:1;
    if(changed) {
        snprintf(lastVoicePhase,sizeof(lastVoicePhase),"%s",phase);
        Serial.printf("[VoiceFeedback] state=%s captureElapsedMs=%lu\n",phase,(unsigned long)Audio::micElapsedMs(now));
    }
    char text[240];
    portENTER_CRITICAL(&voiceMux);voiceView=voicePending;portEXIT_CRITICAL(&voiceMux);
    const char* vs=phase;
    const char* owner=!strcmp(voiceView.target,"openclaw-personal")?"OpenClaw":voiceView.target[0]?voiceView.target:"OpenClaw";
    const char* voiceText=!Audio::micReady()?"Microphone unavailable":!strcmp(vs,"listening")?"Listening":!strcmp(vs,"sending")?"Sending audio":!strcmp(vs,"transcribing")?"Recognizing speech":!strcmp(vs,"waiting")?"Processing":!strcmp(vs,"speaking")?"Speaking":!strcmp(vs,"error")?"Voice error":(!strcmp(vs,"muted") || !WakeWord::enabled())?"Microphone muted":!WakeWord::ready()?"Wake word unavailable":!gatewayReady?"OpenClaw offline":"Say OpenClaw";
    snprintf(text,sizeof(text),"%s%s%s",voiceText,(!strcmp(vs,"waiting") || !strcmp(vs,"speaking"))?" · ":"",(!strcmp(vs,"waiting") || !strcmp(vs,"speaking"))?owner:"");
    ambientVoice.set(text);visible(voiceStatusPane,true);
    voiceHeard.set(!strcmp(vs,"error") && voiceView.notice[0]?voiceView.notice:voiceView.question[0]?voiceView.question:voiceView.notice);
    voiceSaid.set(voiceView.answer);visible(voiceSaid.obj,voiceView.answer[0]);
    snprintf(text,sizeof(text),"%s · Reply",owner);voiceAnswerLabel.set(text);visible(voiceAnswerLabel.obj,voiceView.answer[0]);
    lv_obj_set_width(voiceHeard.obj,voiceView.answer[0]?(g_screenW-96)/2:g_screenW-96);
    const bool listening=!strcmp(vs,"listening");
    visible(voiceButton,Audio::micReady());voiceControlLabel.set(listening?"Finish":"Voice controls");
    visible(voiceMeter,listening);visible(voiceCaptureHint.obj,listening);
    lv_obj_set_style_bg_color(voiceStatusPane,lv_color_hex(listening?Theme::ShallowWater:Theme::DeepSea),0);
    lv_obj_set_style_border_width(voiceStatusPane,listening?3:0,0);
    lv_obj_set_style_border_color(voiceStatusPane,lv_color_hex(Theme::StatusAmber),0);
    lv_obj_set_style_text_font(ambientVoice.obj,listening?&font_studio_28:&font_studio_16,0);
    lv_obj_set_style_text_color(ambientVoice.obj,lv_color_hex(listening?Theme::StatusAmber:Theme::StatusCyan),0);
    visible(voiceHeard.obj,!listening);
    if(listening) {
        visible(voiceSaid.obj,false);visible(voiceAnswerLabel.obj,false);
        const auto mic=Audio::micFeedback();
        voiceCaptureHint.set(mic.speaking?"Hearing you":mic.heard?(mic.quietMs>=450?"Finishing...":"Listening for more..."):"Speak now");
        const unsigned signal=mic.level>mic.noise?mic.level-mic.noise:0;
        const unsigned span=mic.threshold>mic.noise?mic.threshold-mic.noise:80;
        int target=int(signal*100/(span*3));if(target>100)target=100;
        meterLevel=target>meterLevel?target:(meterLevel*3+target)/4;
        static constexpr int shape[]={45,70,100,85,60,90,50};
        for(int i=0;i<7;++i) {
            const int height=4+meterLevel*shape[i]*32/10000;
            lv_obj_set_height(voiceBars[i],height);lv_obj_set_y(voiceBars[i],(36-height)/2);
        }
    } else meterLevel=0;
}
}

lv_obj_t* init(lv_obj_t* parent,const lv_image_dsc_t* (*glyph)(const char*)) {
    presentedId[0]=0;
    glyphFor=glyph; count=0; filter=0; history=false; voiceOpen=false;lastUpdate=0;
    overviewMode=true;page=0;pageSince=millis();pageHeld=false;
    voiceLastUpdate=0;lastVoicePhase[0]=0;meterLevel=0;
    const int w=g_screenW,h=g_screenH, railW=w>=1100?320:248;
    root=box(parent,0,0,w,h,Theme::DeepSea);lv_obj_set_style_radius(root,0,0);
    if(!cachedOcean(root,w,h)) {
    auto* ocean=lv_image_create(root);lv_image_set_src(ocean,&IPS10Ocean::image);
    const int oceanScale=w*400>=h*640?w*256/640:h*256/400;
    lv_image_set_pivot(ocean,0,0);lv_image_set_scale(ocean,oceanScale);lv_obj_set_x(ocean,-(640*oceanScale/256-w)/2);
    lv_obj_set_style_image_opa(ocean,LV_OPA_30,0);lv_obj_clear_flag(ocean,LV_OBJ_FLAG_CLICKABLE);
    }
    auto* logo=lv_image_create(root);lv_image_set_src(logo,&img_logo_48);lv_obj_set_pos(logo,24,16);lv_obj_set_style_image_recolor_opa(logo,LV_OPA_COVER,0);lv_obj_set_style_image_recolor(logo,lv_color_hex(Theme::StatusCyan),0);
    caption(root,"AgentDeck",84,23,240,Theme::HUDText);
    auto* wordmark=lv_obj_get_child(root,-1);lv_obj_set_style_text_font(wordmark,&font_studio_28,0);
    viewButton=box(root,w-332,16,308,48,Theme::DeepSea);
    for(int mode=0;mode<2;++mode) {
        modeButtons[mode]=box(viewButton,mode*154,0,154,48,Theme::ShallowWater);
        lv_obj_add_event_cb(modeButtons[mode],modeCb,LV_EVENT_CLICKED,reinterpret_cast<void*>(static_cast<intptr_t>(mode)));
        // Native geometric icons keep the switch legible without a font dependency.
        for(int k=0;k<3;++k) {
            auto* icon=box(modeButtons[mode],14+(mode?0:k*6),14+(mode?k*7:k%2*8),mode?18:5,mode?3:5,Theme::HUDText);
            lv_obj_clear_flag(icon,LV_OBJ_FLAG_CLICKABLE);
        }
        caption(modeButtons[mode],mode?"Details":"Aquarium",42,13,110,Theme::HUDText);
    }
    label(link,root,330,26,350,&font_studio_20,Theme::HUDDim);
    visible(link.obj,false);
    label(summary,root,24,76,w-248,&font_studio_20,Theme::HUDText);
    const int gap=12, fw=(w-48-gap*3)/4;
    for(int i=0;i<4;++i) {
        filters[i]=box(root,24+i*(fw+gap),118,fw,64,Theme::MidWater);
        lv_obj_add_flag(filters[i],LV_OBJ_FLAG_CLICKABLE);
        label(filterText[i],filters[i],16,24,fw-84,&font_studio_20,Theme::HUDDim);
        label(filterNumber[i],filters[i],fw-66,12,56,&font_workspace_36,Theme::HUDText);
        lv_obj_add_event_cb(filters[i],filterCb,LV_EVENT_CLICKED,reinterpret_cast<void*>(static_cast<intptr_t>(i)));
    }
    label(rosterTitle,root,24,205,railW,&font_studio_20,Theme::HUDDim);
    rail=box(root,24,238,railW,h-358,Theme::DeepSea);
    lv_obj_add_flag(rail,LV_OBJ_FLAG_SCROLLABLE);lv_obj_set_scroll_dir(rail,LV_DIR_VER);
    lv_obj_set_style_pad_bottom(rail,8,0);
    for(int i=0;i<10;++i) {
        cards[i]=box(rail,0,i*110,railW,100,Theme::MidWater);
        lv_obj_set_style_border_width(cards[i],2,0);
        marks[i]=lv_image_create(cards[i]);lv_obj_set_pos(marks[i],0,4);
        lv_obj_set_style_image_recolor_opa(marks[i],LV_OPA_COVER,0);
        label(rowTitle[i],cards[i],64,16,railW-80,&font_studio_20,Theme::HUDText);
        label(rowState[i],cards[i],64,44,railW-80,&font_studio_16,Theme::HUDDim);
        label(rowTool[i],cards[i],16,72,railW-32,&font_studio_16,Theme::HUDDim);
        lv_obj_set_height(rowTool[i].obj,18);
        lv_obj_add_event_cb(cards[i],selectCb,LV_EVENT_CLICKED,reinterpret_cast<void*>(static_cast<intptr_t>(i)));
    }
    detailW=w-railW-72;
    detail=box(root,48+railW,204,detailW,h-324,Theme::MidWater);
    lv_obj_add_flag(detail,LV_OBJ_FLAG_SCROLLABLE);lv_obj_set_scroll_dir(detail,LV_DIR_VER);
    label(heading,detail,24,16,detailW-124,&font_studio_20,Theme::HUDText);
    label(identity,detail,24,54,detailW-124,&font_studio_16,Theme::HUDDim);
    focusGlyph=lv_image_create(detail);lv_obj_set_pos(focusGlyph,detailW-88,8);
    lv_obj_set_style_image_recolor_opa(focusGlyph,LV_OPA_COVER,0);
    // These are reported collaboration counts, never inferred progress. The
    // raised tiles provide a glanceable map of active/completed/background work.
    const int nw=(detailW-64)/3;
    for(int i=0;i<4;++i) {
        stateNodes[i]=box(detail,24+i*(nw+8),90,nw,58,Theme::DeepSea);
        caption(stateNodes[i],CollaborationPresentation::Labels[i],10,8,nw-20);
        lv_obj_set_style_text_font(lv_obj_get_child(stateNodes[i],-1),&font_studio_16,0);
        label(censusValue[i],stateNodes[i],12,30,nw-20,&font_studio_20,Theme::HUDText);
    }
    label(stateText,detail,24,164,detailW-48,&font_studio_20,Theme::HUDText);
    activityScroll=box(detail,24,192,detailW-48,54,Theme::MidWater);
    lv_obj_add_flag(activityScroll,LV_OBJ_FLAG_SCROLLABLE);lv_obj_set_scroll_dir(activityScroll,LV_DIR_VER);
    label(activity,activityScroll,0,0,detailW-56,&font_workspace_20,Theme::HUDText);
    lv_label_set_long_mode(activity.obj,LV_LABEL_LONG_WRAP);
    label(census,detail,24,252,detailW-48,&font_studio_16,Theme::HUDDim);
    label(instruction,detail,24,276,detailW-48,&font_workspace_20,Theme::HUDDim);
    lv_obj_set_height(instruction.obj,44);
    historyButton=box(detail,detailW-166,324,142,48,Theme::ShallowWater);
    label(historyLabel,historyButton,14,16,120,&font_studio_20,Theme::HUDText);
    lv_obj_add_event_cb(historyButton,historyCb,LV_EVENT_CLICKED,nullptr);
    caption(detail,"Recent activity",24,340,detailW-212);recentCaption=lv_obj_get_child(detail,-1);
    eventBox=box(detail,24,386,detailW-48,h-324-402,Theme::MidWater);
    lv_obj_add_flag(eventBox,LV_OBJ_FLAG_SCROLLABLE);lv_obj_set_scroll_dir(eventBox,LV_DIR_VER);
    for(int i=0;i<8;++i) {
        eventCards[i]=box(eventBox,0,i*112,detailW-48,104,Theme::DeepSea);
        label(eventMeta[i],eventCards[i],14,12,detailW-76,&font_studio_16,Theme::StatusCyan);
        label(eventText[i],eventCards[i],14,36,detailW-76,&font_workspace_20,Theme::HUDText);
        lv_label_set_long_mode(eventText[i].obj,LV_LABEL_LONG_WRAP);
        lv_obj_set_height(eventText[i].obj,62);
    }
    sceneW=w-324;
    overview=box(root,24,96,sceneW,h-174,Theme::DeepSea);lv_obj_set_style_bg_opa(overview,LV_OPA_TRANSP,0);
    resourcePane=box(root,w-276,96,252,h-176,Theme::DeepSea);lv_obj_set_style_bg_opa(resourcePane,LV_OPA_70,0);
    lv_obj_set_style_bg_opa(resourcePane,LV_OPA_TRANSP,0);
    caption(resourcePane,UsagePresentation::Heading,4,16,220,Theme::HUDDim);   // baseline shared with the project title
    lv_obj_add_flag(resourcePane,LV_OBJ_FLAG_SCROLLABLE);lv_obj_set_scroll_dir(resourcePane,LV_DIR_VER);
    lv_obj_set_scrollbar_mode(resourcePane,LV_SCROLLBAR_MODE_ACTIVE);
    static const char* const usageAgents[UsageRows::MAX_GROUPS]={"claude-code","codex","zai","antigravity"};
    for(int p=0;p<UsageRows::MAX_GROUPS;++p) {
        auto& c=usageCards[p];
        c.card=box(resourcePane,0,44,252,160,Theme::DeepSea);lv_obj_set_style_bg_opa(c.card,LV_OPA_80,0);
        lv_obj_set_style_border_width(c.card,1,0);lv_obj_set_style_border_color(c.card,lv_color_hex(Theme::ShallowWater),0);
        c.mark=lv_image_create(c.card);lv_obj_set_pos(c.mark,12,8);lv_obj_clear_flag(c.mark,LV_OBJ_FLAG_CLICKABLE);
        lv_image_set_pivot(c.mark,0,0);lv_image_set_scale(c.mark,112);   // 64px mark → 28px
        const auto* mark=glyphFor?glyphFor(usageAgents[p]):nullptr;visible(c.mark,mark);
        if(mark){lv_image_set_src(c.mark,mark);
            // Antigravity's mark is multi-colour; the others are recoloured masks.
            if(p!=UsageRows::ANTIGRAVITY){lv_obj_set_style_image_recolor_opa(c.mark,LV_OPA_COVER,0);lv_obj_set_style_image_recolor(c.mark,lv_color_hex(brandColor(usageAgents[p])),0);}}
        label(c.name,c.card,48,10,130,&font_studio_20,Theme::HUDText);lv_obj_set_height(c.name.obj,font_studio_20.line_height);c.name.set(UsagePresentation::Providers[p]);
        label(c.plan,c.card,0,15,120,&font_studio_16,Theme::HUDText);
        lv_obj_set_width(c.plan.obj,LV_SIZE_CONTENT);lv_label_set_long_mode(c.plan.obj,LV_LABEL_LONG_CLIP);
        lv_obj_set_style_bg_color(c.plan.obj,lv_color_hex(Theme::ShallowWater),0);lv_obj_set_style_bg_opa(c.plan.obj,LV_OPA_COVER,0);
        lv_obj_set_style_radius(c.plan.obj,LV_RADIUS_CIRCLE,0);lv_obj_set_style_pad_hor(c.plan.obj,10,0);lv_obj_set_style_pad_ver(c.plan.obj,2,0);
        for(auto& sl:c.slot) {
            label(sl.label,c.card,14,0,140,&font_studio_16,Theme::HUDDim);
            label(sl.value,c.card,146,0,92,&font_studio_20,Theme::HUDText);lv_obj_set_style_text_align(sl.value.obj,LV_TEXT_ALIGN_RIGHT,0);
            sl.track=box(c.card,14,0,224,8,Theme::ShallowWater);lv_obj_set_style_radius(sl.track,4,0);
            sl.fill=box(sl.track,0,0,0,8,Theme::StatusCyan);lv_obj_set_style_radius(sl.fill,4,0);
            label(sl.reset,c.card,14,0,224,&font_studio_16,Theme::HUDFaint);
            lv_obj_set_height(sl.reset.obj,font_studio_16.line_height);
        }
    }
    label(pageLabel,overview,0,0,sceneW,&font_studio_16,Theme::HUDDim);
    lv_obj_add_flag(pageLabel.obj,LV_OBJ_FLAG_CLICKABLE);lv_obj_add_event_cb(pageLabel.obj,pageCb,LV_EVENT_CLICKED,nullptr);
    for(int i=0;i<10;++i) {
        pods[i]=box(overview,0,24,sceneW,560,Theme::MidWater);lv_obj_set_style_bg_opa(pods[i],LV_OPA_80,0);
        lv_obj_set_style_border_width(pods[i],0,0);lv_obj_set_style_border_side(pods[i],LV_BORDER_SIDE_RIGHT,0);lv_obj_set_style_border_color(pods[i],lv_color_hex(Theme::ShallowWater),0);
        label(podName[i],pods[i],16,16,sceneW-32,&font_studio_20,Theme::HUDText);
        label(podStatus[i],pods[i],16,44,sceneW-32,&font_studio_16,Theme::HUDDim);
        label(cohortLabel[i],pods[i],16,72,sceneW-32,&font_studio_16,Theme::HUDDim);
        label(podLatest[i],pods[i],16,480,sceneW-32,&font_workspace_20,Theme::HUDDim);
        lv_label_set_long_mode(podLatest[i].obj,LV_LABEL_LONG_WRAP);lv_obj_set_height(podLatest[i].obj,72);
        seats[i]=box(overview,0,0,100,126,Theme::DeepSea);lv_obj_set_style_bg_opa(seats[i],LV_OPA_TRANSP,0);
        lv_obj_add_event_cb(seats[i],selectCb,LV_EVENT_CLICKED,reinterpret_cast<void*>(static_cast<intptr_t>(i)));
        creatures[i]=lv_image_create(seats[i]);lv_image_set_pivot(creatures[i],0,0);lv_obj_clear_flag(creatures[i],LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_style_image_recolor_opa(creatures[i],LV_OPA_COVER,0);
        label(seatState[i],seats[i],0,104,100,&font_studio_16,Theme::HUDText);
        label(childLabel[i],seats[i],20,124,90,&font_studio_16,Theme::StatusCyan);
        label(agentActivity[i],overview,0,0,300,&font_workspace_20,Theme::HUDText);
        lv_label_set_long_mode(agentActivity[i].obj,LV_LABEL_LONG_WRAP);lv_obj_set_height(agentActivity[i].obj,68);
    }
    label(overviewEmpty,overview,16,180,sceneW-32,&font_studio_28,Theme::HUDDim);
    attentionPane=box(root,24,76,w-48,48,Theme::DeepSea);lv_obj_set_style_border_width(attentionPane,1,0);lv_obj_set_style_border_color(attentionPane,lv_color_hex(Theme::StatusAmber),0);
    label(attentionLine,attentionPane,14,12,w-76,&font_studio_20,Theme::StatusAmber);
    voiceStatusPane=box(root,24,h-112,w-48,96,Theme::DeepSea);
    label(ambientVoice,voiceStatusPane,16,10,w-268,&font_studio_16,Theme::StatusCyan);
    label(voiceHeard,voiceStatusPane,16,36,w-280,&font_workspace_20,Theme::HUDText);
    label(voiceSaid,voiceStatusPane,w/2,36,w/2-56,&font_workspace_20,Theme::HUDText);
    label(voiceAnswerLabel,voiceStatusPane,w/2,10,w/2-250,&font_studio_16,Theme::HUDDim);
    lv_label_set_long_mode(voiceHeard.obj,LV_LABEL_LONG_DOT);lv_obj_set_height(voiceHeard.obj,50);
    lv_label_set_long_mode(voiceSaid.obj,LV_LABEL_LONG_DOT);lv_obj_set_height(voiceSaid.obj,50);
    label(voiceCaptureHint,voiceStatusPane,16,54,w-400,&font_workspace_20,Theme::HUDText);
    voiceMeter=box(voiceStatusPane,w-328,46,112,36,Theme::DeepSea);
    lv_obj_set_style_bg_opa(voiceMeter,LV_OPA_TRANSP,0);
    for(int i=0;i<7;++i) {
        voiceBars[i]=box(voiceMeter,i*16,16,8,4,Theme::StatusAmber);
        lv_obj_set_style_radius(voiceBars[i],4,0);
    }
    visible(voiceMeter,false);visible(voiceCaptureHint.obj,false);
    label(empty,rail,12,12,railW-24,&font_studio_20,Theme::HUDDim);
    lv_label_set_long_mode(empty.obj,LV_LABEL_LONG_WRAP);

    auto* voice=box(root,w-192,h-104,152,32,Theme::ShallowWater);voiceButton=voice;
    label(voiceControlLabel,voice,8,5,140,&font_studio_20,Theme::HUDText);voiceControlLabel.set("Voice controls");
    lv_obj_add_event_cb(voice,voiceCb,LV_EVENT_CLICKED,nullptr);
    // A separate drawer preserves direct voice controls without consuming the
    // working surface while closed. Width is always the full screen minus 48.
    voicePane=box(root,w-584,h-302,560,178,Theme::ShallowWater);
    lv_obj_set_style_pad_all(voicePane,10,0);lv_obj_set_style_pad_row(voicePane,0,0);
    lv_obj_set_flex_flow(voicePane,LV_FLEX_FLOW_COLUMN);
    visible(voicePane,false);
    update();return voicePane;
}

void update() {
    if(!root) return;
    const uint32_t now=millis();
    updateVoice(now);
    if(lastUpdate && now-lastUpdate<250) return;
    lastUpdate=now?now:1;
    const uint32_t started=micros();
    int totals[4]={}; uint16_t rosterTotal;bool rosterRotating;
    lockState();
    connected=g_state.wsConnected || Net::serialConnected();
    gatewayReady=connected && g_state.gatewayConnected && !g_state.gatewayHasError;
    count=0;
    for(int i=0;i<g_state.sessionCount && i<10;++i) {
        const auto& s=g_state.sessions[i]; if(!s.alive || !s.id[0]) continue;
        auto& r=rows[count++];
        snprintf(r.id,sizeof(r.id),"%s",s.id);snprintf(r.name,sizeof(r.name),"%s",s.lastEventTask[0]?s.lastEventTask:s.projectName[0]?s.projectName:s.agentType);
        snprintf(r.project,sizeof(r.project),"%s",s.projectName);
        snprintf(r.agent,sizeof(r.agent),"%s",s.agentType);snprintf(r.state,sizeof(r.state),"%s",s.state);
        snprintf(r.tool,sizeof(r.tool),"%s",s.currentTool[0]?s.currentTool:s.activity[0]?s.activity:s.lastEventText);r.elapsed=s.elapsedSec;
        snprintf(r.activity,sizeof(r.activity),"%s",category(s.state)==1 && s.question[0]?s.question:s.activity[0]?s.activity:s.lastEventTask[0]?s.lastEventTask:s.currentTool);
        snprintf(r.latest,sizeof(r.latest),"%s",s.lastEventText);snprintf(r.hm,sizeof(r.hm),"%s",s.lastEventHm);
        r.latestRank=TIMELINE_MAX_ENTRIES;
        // Ring order, not HH:MM string order, remains correct across midnight.
        for(int e=0;e<g_state.timelineCount;++e) {
            const auto& item=g_state.timeline[(g_state.timelineHead+g_state.timelineCount-1-e+TIMELINE_MAX_ENTRIES)%TIMELINE_MAX_ENTRIES];
            if(strcmp(item.sessionId,s.id))continue;
            r.latestRank=e;
            snprintf(r.latest,sizeof(r.latest),"%s",item.detail[0]?item.detail:item.raw);
            snprintf(r.hm,sizeof(r.hm),"%s",item.hm);break;
        }
        r.children=s.childrenActive;r.childrenKnown=s.childrenKnown;
        ++totals[category(r.state)];
    }
    // Priority ordering is deterministic; selection still follows the ID.
    for(int i=1;i<count;++i) {
        static Row r; r=rows[i];int j=i; // Reused bounded scratch; keep the UI stack small.
        while(j>0 && category(rows[j-1].state)>category(r.state)) {rows[j]=rows[j-1];--j;}
        rows[j]=r;
    }
    totals[0]=count;rosterTotal=g_state.sessionsTotal;rosterRotating=g_state.sessionsRotating;
    int chosen=-1;
    for(int i=0;i<count;++i) if(matches(rows[i]) && !strcmp(rows[i].id,selectedId)) chosen=i;
    retainedDetail=chosen<0 && !overviewMode && selectedId[0] && !strcmp(selected.id,selectedId) && rosterTotal>count;
    if(chosen<0 && !retainedDetail) {
        for(int i=0;i<count;++i) if(matches(rows[i]) && (chosen<0 || category(rows[i].state)<category(rows[chosen].state))) chosen=i;
        snprintf(selectedId,sizeof(selectedId),"%s",chosen>=0?rows[chosen].id:"");history=false;
    }
    if(!retainedDetail)selected={};eventCount=0;
    for(int i=0;i<g_state.sessionCount && i<10;++i) if(selectedId[0] && !strcmp(g_state.sessions[i].id,selectedId)) selected=g_state.sessions[i];
    // No global/unattributed events in a session detail, even when project names
    // happen to match. A stable session ID is the sole join key.
    for(int i=0;i<g_state.timelineCount && eventCount<8 && selectedId[0];++i) {
        const int idx=(g_state.timelineHead+g_state.timelineCount-1-i+TIMELINE_MAX_ENTRIES)%TIMELINE_MAX_ENTRIES;
        const auto& e=g_state.timeline[idx];
        if(!strcmp(e.sessionId,selectedId)) events[eventCount++]=e;
    }
    usageGroupCount=UsageRows::build(g_state,usageGroups);
    unlockState();
    updateVoice(now,true);
    char text[240];
    // Hide-if-absent: raw Antigravity credits alone never create the pane.
    const bool hasQuota=usageGroupCount>0;
    sceneW=g_screenW-(hasQuota?316:48);
    visible(overview,overviewMode);visible(resourcePane,hasQuota);visible(rail,!overviewMode);visible(rosterTitle.obj,!overviewMode);
    const bool needsAttention=totals[1]>0 || !connected;
    visible(attentionPane,overviewMode && needsAttention);visible(summary.obj,!overviewMode);
    lv_obj_set_pos(overview,24,needsAttention?138:90);lv_obj_set_size(overview,sceneW,g_screenH-(needsAttention?266:218));
    for(int i=0;i<4;++i)visible(filters[i],!overviewMode);
    for(int i=0;i<2;++i) {
        const bool activeMode=overviewMode==(i==0);
        lv_obj_set_style_bg_opa(modeButtons[i],activeMode?LV_OPA_COVER:LV_OPA_TRANSP,0);
        lv_obj_set_style_border_width(modeButtons[i],activeMode?1:0,0);
        lv_obj_set_style_border_color(modeButtons[i],lv_color_hex(Theme::StatusCyan),0);
    }
    lv_obj_set_y(resourcePane,overviewMode?(needsAttention?178:130):g_screenW<1100?370:204);
    // Provider cards stack content-sized. A window row is one line —
    // "5h used  ....  resets 2h 15m  42%" — over its bar, so three full
    // providers fit the landscape pane without scrolling.
    const int quotaMax=g_screenH-lv_obj_get_y(resourcePane)-128;
    constexpr int HeaderH=44, RowH=42, CardGap=10, Top=52, BarW=224;
    for(int p=0;p<UsageRows::MAX_GROUPS;++p)visible(usageCards[p].card,false);
    int quotaY=Top;
    for(int i=0;i<usageGroupCount;++i) {
        const auto& g=usageGroups[i];auto& c=usageCards[g.provider];
        const int h=HeaderH+g.rowCount*RowH+(g.rowCount?4:0);
        visible(c.card,true);lv_obj_set_pos(c.card,0,quotaY);lv_obj_set_size(c.card,252,h);
        // Plan pill: tier plus the subscription's active-until date.
        UsageRows::planText(g,text,sizeof(text),"  ");c.plan.set(text);visible(c.plan.obj,text[0]);
        lv_obj_align(c.plan.obj,LV_ALIGN_TOP_RIGHT,-12,11);
        for(int s=0;s<2;++s) {
            auto& sl=c.slot[s];const bool on=s<g.rowCount;
            visible(sl.label.obj,on);visible(sl.value.obj,on);visible(sl.track,on);visible(sl.reset.obj,on);
            if(!on)continue;
            const auto& r=g.rows[s];const int y=HeaderH+s*RowH;
            snprintf(text,sizeof(text),"%s %s",r.label,r.left?"left":"used");sl.label.set(text);
            const int labelW=textWidth(text,&font_studio_16);
            snprintf(text,sizeof(text),"%d%%",r.shown());sl.value.set(text);
            const int valueW=textWidth(text,&font_studio_20);
            lv_obj_set_y(sl.label.obj,y+1);lv_obj_set_y(sl.value.obj,y-2);lv_obj_set_y(sl.track,y+24);
            lv_obj_set_width(sl.fill,r.shown()*BarW/100);
            // Same meaning, same colour across providers; amber only near the limit.
            lv_obj_set_style_bg_color(sl.fill,lv_color_hex(r.critical()?Theme::StatusAmber:Theme::StatusCyan),0);
            // The faint reset countdown sits between label and percent,
            // right-aligned — one line per window, same form on every row.
            const int resetW=BarW-labelW-valueW-24;
            sl.reset.set(r.reset);
            lv_obj_set_pos(sl.reset.obj,14+labelW+12,y+1);lv_obj_set_width(sl.reset.obj,resetW>0?resetW:0);
            lv_obj_set_style_text_align(sl.reset.obj,LV_TEXT_ALIGN_RIGHT,0);
        }
        quotaY+=h+CardGap;
    }
    lv_obj_set_height(resourcePane,quotaY>quotaMax?quotaMax:quotaY);
    projectCount=0;memset(podMembers,0,sizeof(podMembers));
    for(int i=0;i<count;++i) {
        podFor[i]=-1;if(!matches(rows[i]))continue;
        int group=-1;
        // Exact reported project identity only. Unnamed sessions remain separate.
        for(int j=0;j<i;++j) if(podFor[j]>=0 && rows[i].project[0] && !strcmp(rows[i].project,rows[j].project)) {group=podFor[j];break;}
        if(group<0) group=projectCount++;
        podFor[i]=group;memberSlot[i]=podMembers[group]++;
    }
    // Sort project spaces by identity, never by their changing activity state.
    int order[10], remap[10];
    for(int g=0;g<projectCount;++g) {
        order[g]=g;
        for(int i=0;i<count;++i)if(podFor[i]==g) {snprintf(projectKeys[g],40,"%s",rows[i].project[0]?rows[i].project:rows[i].id);break;}
    }
    for(int i=1;i<projectCount;++i){int key=order[i],j=i;while(j>0 && strcmp(projectKeys[order[j-1]],projectKeys[key])>0){order[j]=order[j-1];--j;}order[j]=key;}
    for(int i=0;i<projectCount;++i)remap[order[i]]=i;
    for(int i=0;i<count;++i)if(podFor[i]>=0)podFor[i]=remap[podFor[i]];
    memset(podMembers,0,sizeof(podMembers));
    for(int i=0;i<count;++i)if(podFor[i]>=0){++podMembers[podFor[i]];memberSlot[i]=0;for(int j=0;j<count;++j)if(podFor[j]==podFor[i] && strcmp(rows[j].id,rows[i].id)<0)++memberSlot[i];}
    const int capacity=g_screenW>=1100?3:1;
    pageCount=(projectCount+capacity-1)/capacity;if(pageCount<1)pageCount=1;
    if(page>=pageCount)page=0;
    if(overviewMode && !pageHeld && now-pageSince>=12000){page=(page+1)%pageCount;pageSince=now;}
    if(rosterTotal>count)snprintf(text,sizeof(text),"%d of %u agents · %s · Projects %d/%d · %s",count,rosterTotal,rosterRotating?"Roster rotates 60s":"Priority view",page+1,pageCount,pageHeld?"Paused":"12s");
    else snprintf(text,sizeof(text),"%d agents · %d projects%s",count,projectCount,pageCount>1?(pageHeld?" · Paused":" · Auto rotate 12s"):"");
    if(rosterTotal>count && pageCount==1)snprintf(text,sizeof(text),"%d of %u agents · %s",count,rosterTotal,rosterRotating?"Roster rotates 60s":"Priority view");
    pageLabel.set(text);visible(pageLabel.obj,count>0);
    const int columns=projectCount<capacity?(projectCount?projectCount:1):capacity;
    const int projectWidth=(sceneW-(columns-1)*Grid::Gap)/columns;
    int maxPeers=0;bool pageHasLatest=false;
    for(int g=page*capacity;g<projectCount && g<(page+1)*capacity;++g){const int peers=podMembers[g]<3?podMembers[g]:3;if(peers>maxPeers)maxPeers=peers;}
    for(int i=0;i<count;++i)if(podFor[i]>=page*capacity && podFor[i]<(page+1)*capacity && rows[i].latest[0])pageHasLatest=true;
    int projectX=0;
    const int peerRows=projectWidth>=600?1:maxPeers;
    const int rowBudget=(g_screenH-(needsAttention?178:130)-128-Grid::Header-(pageHasLatest?88:16))/(peerRows?peerRows:1);
    const int rowHeight=rowBudget<Grid::AgentRow?(rowBudget<96?96:rowBudget):Grid::AgentRow;
    const int ph=Grid::Header+peerRows*rowHeight+(pageHasLatest?88:16);
    for(int i=0;i<10;++i)displayedSlot[i]=-1;
    for(int g=0;g<10;++g) {
        const bool show=g<projectCount && g/capacity==page;visible(pods[g],show);if(!show)continue;
        const int pw=projectWidth;
        lv_obj_set_pos(pods[g],projectX,40);projectX+=pw+Grid::Gap;lv_obj_set_size(pods[g],pw,ph);
        int first=-1,working=0,attention=0;
        for(int i=0;i<count;++i)if(podFor[i]==g){if(first<0)first=i;working+=category(rows[i].state)==2;attention+=category(rows[i].state)==1;}
        lv_obj_set_width(podName[g].obj,pw-32);lv_label_set_long_mode(podName[g].obj,LV_LABEL_LONG_DOT);lv_obj_set_height(podName[g].obj,font_studio_20.line_height);lv_obj_set_width(podStatus[g].obj,pw-32);
        podName[g].set(rows[first].project[0]?rows[first].project:"Unnamed project");
        snprintf(text,sizeof(text),"%d %s · %d working",podMembers[g],podMembers[g]==1?"agent":"agents",working);podStatus[g].set(text);
        int members[10],nMembers=0;
        for(int i=0;i<count;++i)if(podFor[i]==g)members[nMembers++]=i;
        // Attention stays in view; reserve one slot for fair rotation of others.
        for(int i=1;i<nMembers;++i){int v=members[i],j=i;while(j>0 && (category(rows[members[j-1]].state)>category(rows[v].state) || (category(rows[members[j-1]].state)==category(rows[v].state) && strcmp(rows[members[j-1]].id,rows[v].id)>0))){members[j]=members[j-1];--j;}members[j]=v;}
        const int pinned=attention<2?attention:2;
        const int slots=nMembers<3?nMembers:3,rotating=slots-pinned,remaining=nMembers-pinned;
        for(int j=0;j<pinned;++j)displayedSlot[members[j]]=j;
        const int offset=remaining?((now/8000)*rotating)%remaining:0;
        for(int j=0;j<rotating;++j)displayedSlot[members[pinned+(offset+j)%remaining]]=pinned+j;
        snprintf(text,sizeof(text),"Showing %d of %d · Rotate 8s",slots,nMembers);cohortLabel[g].set(text);visible(cohortLabel[g].obj,nMembers>3);lv_obj_set_width(cohortLabel[g].obj,pw-44);
        int recent=first;for(int i=0;i<count;++i)if(podFor[i]==g && rows[i].latestRank<rows[recent].latestRank)recent=i;
        visible(podLatest[g].obj,rows[recent].latest[0]);
        lv_obj_set_pos(podLatest[g].obj,16,Grid::Header+peerRows*rowHeight+16);lv_obj_set_width(podLatest[g].obj,pw-32);
        snprintf(text,sizeof(text),"Latest %s\n%s",rows[recent].hm,rows[recent].latest);podLatest[g].set(text);
    }
    for(int i=0;i<10;++i) {
        const bool show=i<count && displayedSlot[i]>=0;visible(seats[i],show);visible(agentActivity[i].obj,show);if(!show)continue;
        if(lv_obj_get_parent(seats[i])!=pods[podFor[i]])lv_obj_set_parent(seats[i],pods[podFor[i]]);
        if(lv_obj_get_parent(agentActivity[i].obj)!=pods[podFor[i]])lv_obj_set_parent(agentActivity[i].obj,pods[podFor[i]]);
        const int pw=projectWidth; // LVGL may not have resolved this frame's resized bounds yet.
        const int cat=category(rows[i].state),slot=displayedSlot[i];
        const int peers=podMembers[podFor[i]]<3?podMembers[podFor[i]]:3;
        const bool across=pw>=600;
        const int cellW=across?(pw-32-(peers-1)*16)/peers:pw-32;
        const int rowX=16+(across?slot*(cellW+16):0),rowY=Grid::Header+(across?0:slot*rowHeight);
        // One aligned agent row: illustration left, state and work right.
        lv_obj_set_pos(seats[i],rowX,rowY);lv_obj_set_size(seats[i],cellW,rowHeight-8);
        const auto* relief=reliefFor(rows[i].agent);const auto* glyph=relief?relief:glyphFor?glyphFor(rows[i].agent):nullptr;visible(creatures[i],glyph);
        lv_obj_set_style_image_recolor_opa(creatures[i],relief?LV_OPA_TRANSP:LV_OPA_COVER,0);
        if(glyph){if(lv_image_get_src(creatures[i])!=glyph)lv_image_set_src(creatures[i],glyph);lv_image_set_scale(creatures[i],relief?219:320);lv_obj_set_style_image_opa(creatures[i],cat==3?LV_OPA_60:LV_OPA_COVER,0);lv_obj_set_style_image_recolor(creatures[i],lv_color_hex(brandColor(rows[i].agent)),0);}
        lv_obj_set_pos(creatures[i],0,cat==1 && overviewMode && connected?((now/300+i)%2?0:4):4);
        snprintf(text,sizeof(text),"#%d %s",memberSlot[i]+1,cat==1?"! Attention":cat==2?"Working":"Idle");seatState[i].set(text);
        lv_obj_set_pos(seatState[i].obj,96,0);lv_obj_set_width(seatState[i].obj,cellW-96);
        lv_obj_set_pos(childLabel[i].obj,96,rowHeight-24);lv_obj_set_width(childLabel[i].obj,cellW-96);
        snprintf(text,sizeof(text),"%u workers",rows[i].children);childLabel[i].set(text);visible(childLabel[i].obj,rows[i].childrenKnown && rows[i].children>0);
        lv_obj_set_style_text_color(seatState[i].obj,lv_color_hex(cat==1?Theme::StatusAmber:Theme::HUDDim),0);
        // The canonical creature is already the graphical anchor; no disconnected icon column.
        lv_obj_set_pos(agentActivity[i].obj,rowX+96,rowY+24);lv_obj_set_width(agentActivity[i].obj,cellW-96);lv_obj_set_height(agentActivity[i].obj,rows[i].childrenKnown && rows[i].children?rowHeight-50:rowHeight-30);
        agentActivity[i].set(rows[i].activity);visible(agentActivity[i].obj,rows[i].activity[0]);
        lv_obj_set_style_text_color(agentActivity[i].obj,lv_color_hex(cat==1?Theme::StatusAmber:Theme::HUDText),0);

    }
    visible(overviewEmpty.obj,!projectCount);overviewEmpty.set(count?"No sessions match this filter.":"Waiting for agents");
    if(!connected)attentionLine.set("Disconnected · Last received state");
    else if(totals[1]) {int first=0;while(first<count && category(rows[first].state)!=1)++first;snprintf(text,sizeof(text),"Attention %d · %s · %s",totals[1],rows[first].project,rows[first].activity);attentionLine.set(text);}
    else {snprintf(text,sizeof(text),"%d projects · %d working · %d idle",projectCount,totals[2],totals[3]);attentionLine.set(text);}
    lv_obj_set_style_text_color(attentionLine.obj,lv_color_hex(totals[1]?Theme::StatusAmber:Theme::HUDText),0);
    link.set(connected?"Connected":"Disconnected");
    lv_obj_set_style_text_color(link.obj,lv_color_hex(connected?Theme::HUDDim:Theme::StatusAmber),0);
    if(!connected) snprintf(text,sizeof(text),"Disconnected · Reconnecting");
    else if(totals[1]) snprintf(text,sizeof(text),"%d %s",totals[1],totals[1]==1?"session needs attention":"sessions need attention");
    else if(totals[2]) snprintf(text,sizeof(text),"%d agents working",totals[2]);
    else snprintf(text,sizeof(text),"%s",count?"Ready for the next task":"Waiting for agents");
    summary.set(text);
    for(int i=0;i<4;++i) {
        filterText[i].set(i?nameFor(i):"All");
        snprintf(text,sizeof(text),"%d",totals[i]);filterNumber[i].set(text);
        lv_obj_set_style_bg_color(filters[i],lv_color_hex(filter==i?Theme::ShallowWater:Theme::MidWater),0);
        lv_obj_set_style_border_width(filters[i],filter==i?2:0,0);
        lv_obj_set_style_border_color(filters[i],lv_color_hex(i?colorFor(i):Theme::StatusCyan),0);
    }
    if(rosterTotal>count) snprintf(text,sizeof(text),"Sessions · %d of %u",count,rosterTotal);
    else snprintf(text,sizeof(text),g_screenW<1100?"Sessions":"Sessions / inspect");
    rosterTitle.set(text);
    int shown=0;
    for(int i=0;i<10;++i) {
        const bool show=i<count && matches(rows[i]);visible(cards[i],show);if(!show)continue;
        const auto& r=rows[i];const int cat=category(r.state);
        lv_obj_set_y(cards[i],shown++*110);
        lv_obj_set_style_border_color(cards[i],lv_color_hex(!strcmp(r.id,selectedId)?Theme::StatusCyan:Theme::MidWater),0);
        rowTitle[i].set(r.name);
        snprintf(text,sizeof(text),"%s  /  %s",r.agent,nameFor(cat));rowState[i].set(text);
        lv_obj_set_style_text_color(rowState[i].obj,lv_color_hex(colorFor(cat)),0);
        rowTool[i].set(r.tool[0]?r.tool:"No active tool");
        const auto* glyph=glyphFor?glyphFor(r.agent):nullptr;visible(marks[i],glyph);
        if(glyph) {if(lv_image_get_src(marks[i])!=glyph)lv_image_set_src(marks[i],glyph);lv_image_set_scale(marks[i],128);lv_obj_set_style_image_recolor(marks[i],lv_color_hex(brandColor(r.agent)),0);}
    }
    visible(empty.obj,!shown);empty.set(count?"No matching sessions":"Waiting for agents");
    // Keep known quotas beside every view. Detail prioritizes actual content.
    lv_obj_set_x(voicePane,sceneW>584?sceneW-536:24);
    const bool portrait=g_screenW<1100;
    const int rw=portrait?sceneW:hasQuota?224:280;
    detailW=portrait?sceneW:sceneW-rw-24;
    lv_obj_set_y(rosterTitle.obj,220);lv_obj_set_size(rail,rw,portrait?112:g_screenH-366);lv_obj_set_scroll_dir(rail,portrait?LV_DIR_HOR:LV_DIR_VER);lv_obj_set_width(rosterTitle.obj,rw);
    lv_obj_set_pos(detail,portrait?24:48+rw,portrait?370:204);lv_obj_set_y(resourcePane,overviewMode?(needsAttention?178:130):portrait?370:204);lv_obj_set_size(detail,detailW,portrait?g_screenH-498:g_screenH-332);
    for(int i=0;i<4;++i){const int fw=(sceneW-36)/4;lv_obj_set_x(filters[i],24+i*(fw+12));lv_obj_set_width(filters[i],fw);lv_obj_set_width(filterText[i].obj,portrait?fw-16:fw-70);lv_obj_set_pos(filterText[i].obj,portrait?8:16,portrait?5:24);lv_obj_set_style_text_font(filterText[i].obj,portrait?&font_studio_16:&font_studio_20,0);lv_obj_set_pos(filterNumber[i].obj,fw-52,portrait?22:12);}
    for(int i=0;i<10;++i){const int cardW=portrait?224:rw;lv_obj_set_width(cards[i],cardW);if(portrait)lv_obj_set_pos(cards[i],i*236,0);else lv_obj_set_x(cards[i],0);lv_obj_set_width(rowTitle[i].obj,cardW-80);lv_obj_set_height(rowTitle[i].obj,font_studio_20.line_height);lv_obj_set_width(rowState[i].obj,cardW-32);lv_obj_set_x(rowState[i].obj,16);lv_obj_set_y(rowState[i].obj,48);lv_obj_set_width(rowTool[i].obj,cardW-32);}
    lv_obj_set_width(heading.obj,detailW-112);lv_obj_set_width(identity.obj,detailW-48);lv_obj_set_x(focusGlyph,detailW-80);
    visible(detail,!overviewMode && (chosen>=0 || retainedDetail));
    if(strcmp(presentedId,selectedId)) {
        snprintf(presentedId,sizeof(presentedId),"%s",selectedId);
        lv_obj_scroll_to_y(eventBox,0,LV_ANIM_OFF);
        lv_obj_scroll_to_y(activityScroll,0,LV_ANIM_OFF);
    }
    if(chosen>=0 || retainedDetail) {
        heading.set(selected.lastEventTask[0]?selected.lastEventTask:selected.projectName[0]?selected.projectName:selected.agentType);
        snprintf(text,sizeof(text),"%s  /  %s  /  %lus",selected.agentType,selected.modelName[0]?selected.modelName:"Model unavailable",static_cast<unsigned long>(selected.elapsedSec));identity.set(text);
        const int cat=category(selected.state);
        const auto* fg=glyphFor?glyphFor(selected.agentType):nullptr;visible(focusGlyph,fg);
        if(fg){if(lv_image_get_src(focusGlyph)!=fg)lv_image_set_src(focusGlyph,fg);lv_obj_set_style_image_recolor(focusGlyph,lv_color_hex(brandColor(selected.agentType)),0);}
        int knownNodes=0;
        for(int i=0;i<4;++i)knownNodes+=(i<2?selected.childrenKnown:selected.coordinationKnown);
        int shownNodes=0;
        for(int i=0;i<4;++i) {
            const bool known=i<2?selected.childrenKnown:selected.coordinationKnown;
            visible(stateNodes[i],known);
            if(!known)continue;
            const int columns=knownNodes<2?knownNodes:2;
            const int nw=(detailW-48-(columns-1)*8)/columns;
            lv_obj_set_pos(stateNodes[i],24+(shownNodes%columns)*(nw+8),82+(shownNodes/columns)*66);++shownNodes;lv_obj_set_width(stateNodes[i],nw);lv_obj_set_width(lv_obj_get_child(stateNodes[i],0),nw-20);
            const unsigned value=i==0?selected.childrenActive:i==1?selected.childrenCompleted:i==2?selected.spawnedActive:selected.backgroundJobs;
            snprintf(text,sizeof(text),"%u",value);censusValue[i].set(text);
        }
        const int y=knownNodes?82+((knownNodes+1)/2)*66+28:82;
        const int phase=CollaborationPresentation::phase(cat==1,cat==2,selected.childrenKnown?selected.childrenActive:0,selected.coordinationKnown?selected.spawnedActive:0,selected.coordinationKnown?selected.backgroundJobs:0);
        census.set(CollaborationPresentation::Scope);visible(census.obj,knownNodes>0);
        lv_obj_set_pos(census.obj,24,y-26);lv_obj_set_width(census.obj,detailW-48);
        snprintf(text,sizeof(text),"%s%s%s",phase==2?"Waiting on work":nameFor(cat),selected.currentTool[0]?" · ":"",selected.currentTool);stateText.set(text);lv_obj_set_y(stateText.obj,y);lv_obj_set_width(stateText.obj,detailW-48);
        activity.set(cat==1 && selected.question[0]?selected.question:selected.activity[0]?selected.activity:selected.lastEventText);
        lv_obj_set_pos(activityScroll,24,y+32);lv_obj_set_width(activityScroll,detailW-48);lv_obj_set_width(activity.obj,detailW-56);lv_obj_set_height(activity.obj,LV_SIZE_CONTENT);lv_obj_update_layout(activity.obj);
        const int maxActivity=history?54:96,measured=lv_obj_get_height(activity.obj);
        const int activityH=activity.value[0]?(measured>maxActivity?maxActivity:measured<28?28:measured):0;
        lv_obj_set_height(activityScroll,activityH);visible(activityScroll,activityH>0);

        instruction.set(retainedDetail?"Saved detail · Agent is on another roster page":cat==1?"Review this request in the agent terminal.":"");visible(instruction.obj,retainedDetail || cat==1);
        const int after=y+activityH+40;
        lv_obj_set_y(instruction.obj,after);lv_obj_set_width(instruction.obj,detailW-48);
        const int eventStart=after+((retainedDetail || cat==1)?52:8);
        lv_obj_set_pos(historyButton,detailW-150,eventStart);lv_obj_set_size(historyButton,126,36);lv_obj_set_pos(historyLabel.obj,10,7);
        historyLabel.set(history?"Summary":"History");visible(historyButton,eventCount>0);
        lv_obj_set_pos(recentCaption,24,eventStart+6);lv_obj_set_width(recentCaption,detailW-190);visible(recentCaption,eventCount>0);
        lv_obj_set_pos(eventBox,24,eventStart+48);lv_obj_set_size(eventBox,detailW-48,lv_obj_get_height(detail)-eventStart-60>120?lv_obj_get_height(detail)-eventStart-60:120);
        for(int i=0;i<8;++i){lv_obj_set_width(eventCards[i],detailW-48);lv_obj_set_width(eventText[i].obj,detailW-76);lv_obj_set_width(eventMeta[i].obj,detailW-76);}
        int eventY=0;
        for(int i=0;i<8;++i) {
            const bool show=i<(history?8:2) && i<eventCount;visible(eventCards[i],show);if(!show)continue;
            const auto& e=events[i];
            const char* kind=!strcmp(e.type,"chat_response")?"Response":!strcmp(e.type,"chat_start")?"Request":!strcmp(e.type,"tool_request")?"Tool call":!strcmp(e.type,"tool_result")?"Tool result":!strcmp(e.type,"error")?"Error":!strcmp(e.type,"task_start")?"Task started":"Activity";
            snprintf(text,sizeof(text),"%s  /  %s%s",e.hm,kind,i==0?" / latest":"");eventMeta[i].set(text);
            eventText[i].set(e.detail[0]?e.detail:e.raw);
            lv_obj_set_height(eventText[i].obj,history?LV_SIZE_CONTENT:62);
            lv_obj_update_layout(eventText[i].obj);
            int eh=history?lv_obj_get_height(eventText[i].obj)+50:104;if(eh<104)eh=104;
            lv_obj_set_y(eventCards[i],eventY);lv_obj_set_height(eventCards[i],eh);eventY+=eh+8;
        }
        if(!eventCount) {
            visible(eventCards[0],true);eventMeta[0].set("Recent activity");eventText[0].set("No events received for this session.");
        }
    }
    const uint32_t elapsed=micros()-started;
    portENTER_CRITICAL(&diagMux);
    ++diag.updates;diag.lastUpdateUs=elapsed;
    if(elapsed>diag.maxUpdateUs)diag.maxUpdateUs=elapsed;
    diag.width=g_screenW;diag.height=g_screenH;diag.sessions=count;diag.visibleSessions=shown;
    diag.filter=filter;diag.eventCount=eventCount;diag.connected=connected;
    diag.usageVisible=hasQuota;diag.quotaWindows=0;for(int i=0;i<usageGroupCount;++i)diag.quotaWindows+=usageGroups[i].rowCount;diag.rosterTotal=rosterTotal;diag.rosterRotating=rosterRotating;
    diag.history=history;diag.voiceOpen=voiceOpen;diag.overview=overviewMode;diag.projects=projectCount;
    portEXIT_CRITICAL(&diagMux);
}
void voiceStarted(const char* target) {
    portENTER_CRITICAL(&voiceMux);voicePending={};snprintf(voicePending.target,sizeof(voicePending.target),"%s",target?target:"");portEXIT_CRITICAL(&voiceMux);
}
void voiceTranscript(const char* text) { portENTER_CRITICAL(&voiceMux);snprintf(voicePending.question,sizeof(voicePending.question),"%s",text?text:"");portEXIT_CRITICAL(&voiceMux); }
void voiceAnswer(const char* text) { portENTER_CRITICAL(&voiceMux);snprintf(voicePending.answer,sizeof(voicePending.answer),"%s",text?text:"");portEXIT_CRITICAL(&voiceMux); }
void voiceNotice(const char* text) { portENTER_CRITICAL(&voiceMux);snprintf(voicePending.notice,sizeof(voicePending.notice),"%s",text?text:"");portEXIT_CRITICAL(&voiceMux); }
Diagnostics diagnostics() {
    portENTER_CRITICAL(&diagMux);const Diagnostics out=diag;portEXIT_CRITICAL(&diagMux);
    return out;
}
const char* selectedSession() { return selectedId; }
}
#endif
