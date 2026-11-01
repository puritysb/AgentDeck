import type { DotDeckSnapshot } from './protocol.js';
import { defaultDotRGBA, validDotAppearance, DOT_HABITAT_RULES as H, DOT_APPEARANCE_RULES as R } from './dot-appearance.js';
import { dotDeckPresentation } from './dot-deck.js';
import { TERRARIUM_RULES } from './terrarium-rules.js';
export interface DotPixelHome { x: number; y: number; size?: number; beacon?: boolean; shell?: boolean }
/** A pearl and its shell in the inhabitant band. No fixed corner badge or separate status panel. */
export function paintDotPixels(rgb: Uint8Array, width: number, dot: DotDeckSnapshot | null | undefined, now = Date.now(), home?: DotPixelHome): Uint8Array {
  if (![11,32,64].includes(width) || !dot?.configured || rgb.length !== width*width*3) return rgb;
  const phase=dotDeckPresentation(dot,now);
  const out=dot.hosting && ['AWAITING ACTIVITY','WORKING','NEEDS YOU','COMPLETED','FAILED'].includes(phase.label);
  const size=Math.max(1,Math.min(width-2,Math.round(home?.size ?? Math.max(R.pixelMinSize,Math.floor(width/R.pixelSizeDivisor)))));
  const beacon=home?.beacon===true || width===11;
  const hx=Math.round(home?.x ?? width*H.homeX),hy=Math.round(home?.y ?? width*H.homeY);
  const pixel=(x:number,y:number,c:readonly number[],a=255) => {
    if(x<0 || y<0 || x>=width || y>=width) return;
    const i=(y*width+x)*3;
    for(let k=0;k<3;k++) rgb[i+k]=Math.round((c[k]*a+rgb[i+k]*(255-a))/255);
  };
  const rows=out ? TERRARIUM_RULES.hermesShellPixels.open : TERRARIUM_RULES.hermesShellPixels.closed;
  const unit=Math.max(1,Math.floor(size/7));
  const tint=[1,3,5].map(i=>parseInt(phase.color.slice(i,i+2),16));
  if(home?.shell!==false && (!beacon || !out)) for(let y=0;y<rows.length;y++) for(let x=0;x<rows[y].length;x++) if(rows[y][x]==='#')
    for(let dy=0;dy<unit;dy++) for(let dx=0;dx<unit;dx++) pixel(hx+(x-3)*unit+dx,hy+(y-rows.length+1)*unit+dy,tint);
  if(!out) return rgb;
  let rgba=defaultDotRGBA(size), sourceSize=size;
  if(validDotAppearance(dot.appearance)) { try { rgba=Uint8Array.from(atob(dot.appearance.rgba),c=>c.charCodeAt(0)); sourceSize=16; } catch { /* canonical pearl */ } }
  const x0=hx-Math.floor(size/2),y0=beacon ? hy-Math.floor(size/2) : hy-rows.length*unit-Math.floor(size*.7);
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const i=(Math.floor(y*sourceSize/size)*sourceSize+Math.floor(x*sourceSize/size))*4;
    pixel(x0+x,y0+y,[rgba[i],rgba[i+1],rgba[i+2]],rgba[i+3]);
  }
  return rgb;
}
