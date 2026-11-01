#include "ui/terrarium/habitat_spacing.h"
#include <array>
#include <cassert>
#include <cmath>
using namespace HabitatSpacing;
int main(){
    std::array<Rect,15> occupied{};
    occupied[0]={50,20,260,64};occupied[1]={94,234,172,96};occupied[2]={152,170,56,50};
    size_t count=3;
    for(int i=0;i<8;++i){
        const Rect wanted{150,145,38,46};
        const auto r=place(wanted,occupied.data(),count,360,360,true,215);
        assert(r.y+r.h<=213);
        for(size_t j=0;j<count;++j)assert(!overlaps(r,occupied[j]));
        for(int k=0;k<4;++k){float dx=r.x+(k&1?r.w:0)-180,dy=r.y+(k&2?r.h:0)-180;assert(dx*dx+dy*dy<=178*178);}
        occupied[count++]=r;
    }
    const Rect clear{20,100,16,20};
    const auto same=place(clear,nullptr,0,135,160,false);
    assert(same.x==clear.x && same.y==clear.y);
    // Packing does not mutate an authored home or invent a smaller identity.
    const auto r=place({-20,-30,16,20},nullptr,0,135,160,false);
    assert(r.x>=2 && r.y>=2 && r.w==16 && r.h==20);
    const Rect full{0,0,135,160};
    const auto fallback=place(clear,&full,1,135,160,false);
    assert(fallback.w==clear.w && fallback.h==clear.h);
}
