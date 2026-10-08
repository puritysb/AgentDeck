// Preserve terminal foreground, background and intensity in public canonical
// renderer frames. RGB payload numbers are consumed atomically, never as SGRs.
const palette = {30:'#111827',31:'#ef4444',32:'#22c55e',33:'#f59e0b',34:'#3b82f6',35:'#a855f7',36:'#06b6d4',37:'#d1d5db',90:'#6b7280',91:'#f87171',92:'#4ade80',93:'#fcd34d',94:'#60a5fa',95:'#c084fc',96:'#67e8f9',97:'#f9fafb'};
function applySgr(params, state) {
  const parts = params === '' ? [0] : params.split(';').map(Number);
  for(let i=0;i<parts.length;i++) {
    const code=parts[i];
    if(code===0) {state.color=null;state.background=null;state.dim=false;}
    else if(code===39) state.color=null;
    else if(code===49) state.background=null;
    else if(code===2) state.dim=true;
    else if(code===22) state.dim=false;
    else if(palette[code]) state.color=palette[code];
    else if(palette[code-10] && ((code>=40&&code<=47)||(code>=100&&code<=107))) state.background=palette[code-10];
    else if((code===38||code===48)&&parts[i+1]===2) {
      const rgb=parts.slice(i+2,i+5);
      if(rgb.length===3&&rgb.every(Number.isFinite)) state[code===38?'color':'background']='#'+rgb.map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');
      i+=4;
    }
  }
}
export function ansiScreenToFrame(text, cols, rows) {
  const state={color:null,background:null,dim:false};
  const empty=()=>({ch:' ',color:null,background:null,dim:false});
  const screen=Array.from({length:rows},()=>Array.from({length:cols},empty));
  let row=0,col=0,i=0;
  while(i<text.length) {
    const ch=text[i];
    if(ch==='\u001b'&&text[i+1]==='[') {
      let j=i+2;while(j<text.length&&!/[A-Za-z]/.test(text[j]))j++;
      const final=text[j],params=text.slice(i+2,j);
      if(final==='H'||final==='f') {const[r='1',c='1']=params.split(';');row=Math.max(0,Math.min(rows-1,Number(r)-1));col=Math.max(0,Math.min(cols-1,Number(c)-1));}
      else if(final==='K'&&params==='2') {screen[row]=Array.from({length:cols},()=>({ch:' ',...state}));col=0;}
      else if(final==='m') applySgr(params,state);
      i=j+1;continue;
    }
    if(ch==='\n') {row=Math.min(rows-1,row+1);col=0;i++;continue;}
    if(row>=0&&row<rows&&col>=0&&col<cols)screen[row][col]={ch,...state};
    col++;i++;
  }
  const lines=[],spans=[];
  for(const line of screen) {
    const last=line.findLastIndex(c=>c.ch!==' '||c.background!==null);
    if(last<0){lines.push('');spans.push([]);continue;}
    lines.push(line.slice(0,last+1).map(c=>c.ch).join(''));
    const runs=[];let start=0,run='',style=line[0];
    const flush=()=>{if(run.trim()||style.background!==null)runs.push({x:start,text:run,color:style.color,background:style.background,dim:style.dim});};
    for(let x=0;x<=last;x++) {
      const cell=line[x];
      if(cell.color!==style.color||cell.background!==style.background||cell.dim!==style.dim){flush();start=x;run=cell.ch;style=cell;}else run+=cell.ch;
    }
    flush();spans.push(runs);
  }
  return {lines,spans};
}
