#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>

namespace HabitatSpacing {
struct Rect { float x, y, w, h; };
inline bool overlaps(const Rect& a, const Rect& b) {
    return a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;
}
// Pixel-space packing is local to firmware; the authored cross-platform homes
// remain unchanged. Existing free positions never move. Try nearby obstacle
// edges before a bounded grid, so travelling residents slide along neighbours.
inline Rect place(Rect wanted, const Rect* obstacles, size_t count, int w, int h, bool round, float lowerEdge=-1, size_t ignore=size_t(-1)) {
    const float margin=2;
    const float bottom=lowerEdge<0 ? float(h) : std::min(float(h),lowerEdge);
    auto fit=[&](Rect r) {
        r.x=std::max(margin,std::min(float(w)-margin-r.w,r.x));
        r.y=std::max(margin,std::min(bottom-margin-r.h,r.y));return r;
    };
    auto valid=[&](const Rect& r) {
        if(round) {
            const float radius=std::min(w,h)*.5f-margin;
            for(int i=0;i<4;++i) {
                float dx=r.x+(i&1?r.w:0)-w*.5f,dy=r.y+(i&2?r.h:0)-h*.5f;
                if(dx*dx+dy*dy>radius*radius)return false;
            }
        }
        for(size_t i=0;i<count;++i)if(i!=ignore && overlaps(r,obstacles[i]))return false;
        return true;
    };
    wanted=fit(wanted);
    if(valid(wanted))return wanted;
    Rect best=wanted;float cost=1e30f;
    auto consider=[&](Rect candidate) {
        candidate=fit(candidate);
        const float dx=candidate.x-wanted.x,dy=candidate.y-wanted.y,d=dx*dx+dy*dy;
        if(d<cost && valid(candidate)){best=candidate;cost=d;}
    };
    for(size_t i=0;i<count;++i) {
        if(i==ignore)continue;
        const auto& o=obstacles[i];
        consider({o.x-wanted.w-margin,wanted.y,wanted.w,wanted.h});
        consider({o.x+o.w+margin,wanted.y,wanted.w,wanted.h});
        consider({wanted.x,o.y-wanted.h-margin,wanted.w,wanted.h});
        consider({wanted.x,o.y+o.h+margin,wanted.w,wanted.h});
    }
    const int step=std::max(4,std::min(w,h)/20);
    for(int y=2;y+wanted.h<bottom-2;y+=step)
        for(int x=2;x+wanted.w<w-2;x+=step)consider({float(x),float(y),wanted.w,wanted.h});
    // An overfull habitat retains the original body rather than dropping an
    // owner or shrinking an identity below its readable size.
    return best;
}
}
