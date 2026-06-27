/**
 * APME Web Dashboard — self-contained inline HTML.
 * Served at GET /apme by both Node.js daemon and Swift daemon.
 * No external dependencies — vanilla JS + CSS + fetch polling.
 *
 * Layout: left panel (runs list + tabs) | right panel (run detail).
 */

export function apmeDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentDeck — Agent Performance Monitoring & Evaluation</title>
<style>
:root{--bg:#0f172a;--surface:#1e293b;--border:#334155;--text:#e2e8f0;--muted:#94a3b8;--dim:#64748b;--green:#22c55e;--yellow:#f59e0b;--red:#ef4444;--blue:#3b82f6;--accent:#818cf8}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;font-size:13px;height:100vh;overflow:hidden}

/* ── Header ── */
header{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid var(--border);background:var(--surface)}
header h1{font-size:16px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:8px}
.live{width:8px;height:8px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
header .status{margin-left:auto;font-size:11px;color:var(--dim)}

/* ── Split layout ── */
.split{display:flex;height:calc(100vh - 49px)}
.left{width:55%;min-width:400px;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.right{flex:1;overflow-y:auto;padding:20px;background:var(--bg)}

/* ── Tabs ── */
.tabs{display:flex;gap:0;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0}
.tab{padding:10px 16px;font-size:12px;font-weight:500;color:var(--dim);cursor:pointer;border:none;background:none;border-bottom:2px solid transparent;transition:all 0.15s}
.tab:hover{color:var(--muted)}
.tab.active{color:var(--accent);border-bottom-color:var(--accent)}

/* ── Table ── */
.table-wrap{flex:1;overflow-y:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{position:sticky;top:0;text-align:left;color:var(--dim);font-weight:500;padding:8px 10px;background:var(--surface);border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:0.3px}
td{padding:7px 10px;border-bottom:1px solid rgba(51,65,85,0.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px}
tr{cursor:pointer;transition:background 0.1s}
tr:hover td{background:rgba(30,42,59,0.8)}
tr.selected td{background:rgba(99,102,241,0.15);border-left:2px solid var(--accent)}
.task-col{max-width:250px;color:var(--muted);font-style:italic}

/* ── Scores / badges ── */
.score{font-weight:600;font-variant-numeric:tabular-nums}
.score-high{color:var(--green)}
.score-mid{color:var(--yellow)}
.score-low{color:var(--red)}
.score-na{color:var(--dim)}
.badge{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;display:inline-block}
.badge-committed{background:#166534;color:#bbf7d0}
.badge-abandoned{background:#7f1d1d;color:#fecaca}
.badge-iterated{background:#78350f;color:#fef3c7}
.badge-exploratory{background:var(--surface);color:var(--muted);border:1px solid var(--border)}
.badge-pending{background:var(--surface);color:var(--dim)}
.badge-cat{background:var(--surface);color:var(--accent);border:1px solid rgba(129,140,248,0.3);font-size:10px;padding:1px 6px;border-radius:4px}

/* ── Detail panel ── */
.detail-empty{display:flex;align-items:center;justify-content:center;height:100%;color:var(--dim);font-size:14px}
.detail-header{margin-bottom:16px}
.detail-header h2{font-size:16px;font-weight:600;color:var(--text);margin-bottom:4px}
.detail-header .meta-row{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.detail-header .meta-row span{display:flex;align-items:center;gap:4px}

.section{margin-bottom:16px}
.section-head{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:0.5px;padding-bottom:6px;margin-bottom:8px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.section-score{font-size:14px;font-weight:700}

.done-item,.missed-item{padding:4px 0;font-size:12px}
.done-item::before{content:'✓ ';color:var(--green);font-weight:700}
.missed-item::before{content:'✗ ';color:var(--red);font-weight:700}
.reasoning{font-size:12px;color:var(--muted);line-height:1.5;margin-top:8px;padding:10px;background:var(--surface);border-radius:6px;border-left:3px solid var(--accent)}

.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}
.metric-card{background:var(--surface);border-radius:8px;padding:12px;text-align:center}
.metric-card .val{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.metric-card .lbl{font-size:10px;color:var(--dim);text-transform:uppercase;margin-top:2px}

.composite-bar{height:8px;background:var(--surface);border-radius:4px;overflow:hidden;margin:8px 0}
.composite-fill{height:100%;border-radius:4px;transition:width 0.3s}

.turn-card{background:var(--surface);border-radius:6px;padding:10px 12px;margin-bottom:6px}
.turn-card .turn-idx{color:var(--accent);font-weight:600;font-size:11px}
.turn-card .turn-prompt{color:var(--text);font-size:12px;margin:4px 0}
.turn-card .turn-stats{font-size:11px;color:var(--dim);display:flex;gap:12px}

.weight-line{font-family:'SF Mono',Menlo,monospace;font-size:11px;color:var(--muted);margin-top:6px}

.vibe-bar{display:flex;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid var(--border)}
.vibe-btn{padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:all 0.15s}
.vibe-btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,0.3)}
.vibe-approve{background:#166534;color:#bbf7d0}
.vibe-reject{background:#7f1d1d;color:#fecaca}
.vibe-current{font-size:11px;color:var(--dim);display:flex;align-items:center;margin-left:8px}

.panel{display:none}.panel.visible{display:block;height:100%}
.empty{color:var(--dim);font-style:italic;padding:20px;text-align:center}
</style>
</head>
<body>
<header>
  <h1><span class="live"></span> Agent Performance Monitoring & Evaluation</h1>
  <span class="status" id="status">Loading...</span>
</header>

<div class="split">
  <!-- Left: runs list + tabs -->
  <div class="left">
    <div class="tabs">
      <button class="tab active" onclick="showTab('runs')">Runs</button>
      <button class="tab" onclick="showTab('recommend')">Recommend</button>
      <button class="tab" onclick="showTab('scorecard')">Scorecard</button>
      <button class="tab" onclick="showTab('categories')">Categories</button>
    </div>
    <div class="table-wrap">
      <div class="panel visible" id="panel-runs">
        <div style="display:flex;gap:6px;padding:8px 10px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0">
          <select id="f-agent" onchange="applyFilter()" style="background:var(--bg);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:11px"><option value="">All Agents</option></select>
          <select id="f-model" onchange="applyFilter()" style="background:var(--bg);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:11px"><option value="">All Models</option></select>
          <select id="f-project" onchange="applyFilter()" style="background:var(--bg);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:11px"><option value="">All Projects</option></select>
          <select id="f-cat" onchange="applyFilter()" style="background:var(--bg);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:11px"><option value="">All Categories</option></select>
          <select id="f-outcome" onchange="applyFilter()" style="background:var(--bg);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:11px"><option value="">All Outcomes</option></select>
        </div>
        <table><thead><tr>
          <th>Agent</th><th>Model</th><th>Project</th><th>Category</th><th>Score</th><th>Outcome</th><th>Vibe</th><th>Task</th><th>Time</th>
        </tr></thead><tbody id="runs-body"></tbody></table>
      </div>
      <div class="panel" id="panel-recommend"><div id="recommend-content" class="empty">Loading...</div></div>
      <div class="panel" id="panel-scorecard"><div id="scorecard-content" class="empty">Loading...</div></div>
      <div class="panel" id="panel-categories"><div id="categories-content" class="empty">Loading...</div></div>
    </div>
  </div>

  <!-- Right: detail -->
  <div class="right" id="detail-panel">
    <div class="detail-empty">Select a run to view details</div>
  </div>
</div>

<script>
const B=location.origin;let selId=null;let allRuns=[];
const AUTH=new URLSearchParams(location.search).get('token')||'';
function api(path){const sep=path.includes('?')?'&':'?';return B+path+(AUTH?sep+'token='+encodeURIComponent(AUTH):'')}

function showTab(n){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('visible'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('panel-'+n).classList.add('visible');
  event.target.classList.add('active');
}
function fs(s){if(s==null)return'<span class="score score-na">—</span>';const p=Math.round(s*100),c=p>=70?'high':p>=40?'mid':'low';return'<span class="score score-'+c+'">'+p+'%</span>'}
function fo(o){if(!o)return'';return'<span class="badge badge-'+o+'">'+o+'</span>'}
function fd(ms){if(!ms)return'';const s=Math.round(ms/1000);return s>=3600?Math.floor(s/3600)+'h'+Math.floor((s%3600)/60)+'m':s>=60?Math.floor(s/60)+'m'+s%60+'s':s+'s'}
function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function barColor(pct){return pct>=70?'var(--green)':pct>=40?'var(--yellow)':'var(--red)'}

function populateFilters(runs){
  const sets={agent:new Set(),model:new Set(),project:new Set(),cat:new Set(),outcome:new Set()};
  for(const r of runs){
    if(r.agentType)sets.agent.add(r.agentType);
    if(r.modelId)sets.model.add(r.modelId);
    if(r.projectName)sets.project.add(r.projectName);
    if(r.taskCategory)sets.cat.add(r.taskCategory);
    if(r.outcome)sets.outcome.add(r.outcome);
  }
  const fill=(id,vals)=>{const s=document.getElementById(id);const cur=s.value;const opts=s.querySelectorAll('option');
    while(s.options.length>1)s.remove(1);
    [...vals].sort().forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;s.add(o)});
    s.value=cur;};
  fill('f-agent',sets.agent);fill('f-model',sets.model);fill('f-project',sets.project);fill('f-cat',sets.cat);fill('f-outcome',sets.outcome);
}
function applyFilter(){renderRuns(allRuns)}
function filterRuns(runs){
  const fa=document.getElementById('f-agent').value;
  const fm=document.getElementById('f-model').value;
  const fp=document.getElementById('f-project').value;
  const fc=document.getElementById('f-cat').value;
  const fo2=document.getElementById('f-outcome').value;
  return runs.filter(r=>(!fa||r.agentType===fa)&&(!fm||r.modelId===fm)&&(!fp||r.projectName===fp)&&(!fc||r.taskCategory===fc)&&(!fo2||r.outcome===fo2));
}
function renderRuns(runs){
  const filtered=filterRuns(runs);
  const tb=document.getElementById('runs-body');
  tb.innerHTML=filtered.map(r=>{
      const sc=r.overallScore??r.compositeScore;
      const dur=r.endedAt&&r.startedAt?r.endedAt-r.startedAt:null;
      const task=r.taskPrompt?r.taskPrompt.slice(0,80):'';
      const tm=r.startedAt?new Date(r.startedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';
      const sel=r.id===selId?' class="selected"':'';
      const vb=r.vibe?.verdict==='approve'?'<span style="color:var(--green);font-weight:700">✓</span>':r.vibe?.verdict==='reject'?'<span style="color:var(--red);font-weight:700">✗</span>':'<span style="color:var(--dim)">—</span>';
      return'<tr'+sel+' onclick="selectRun(\\''+r.id+'\\')">'+
        '<td>'+(r.agentType||'—')+'</td>'+
        '<td>'+(r.modelId||'—').slice(0,16)+'</td>'+
        '<td>'+(r.projectName||'—')+'</td>'+
        '<td>'+(r.taskCategory?'<span class="badge-cat">'+r.taskCategory+'</span>':'—')+'</td>'+
        '<td>'+fs(sc)+'</td>'+
        '<td>'+fo(r.outcome)+'</td>'+
        '<td>'+vb+'</td>'+
        '<td class="task-col" title="'+esc(r.taskPrompt||'')+'">'+esc(task)+'</td>'+
        '<td>'+tm+(dur?' · '+fd(dur):'')+'</td></tr>';
    }).join('');
    if(!filtered.length)tb.innerHTML='<tr><td colspan="9" class="empty" style="padding:0">'+(runs.length?'No runs match filters':renderEmptyState())+'</td></tr>';
}
/**
 * Rich first-use empty state. Replaces a bare "No runs yet" message with
 * an onboarding card so new users understand what APME will do once they
 * run their first session. Kept inline (no template file) because the
 * dashboard ships as a single JS string for the daemon HTTP route.
 */
function renderEmptyState(){
  return '<div style="padding:48px 32px;text-align:center;line-height:1.6">'+
    '<div style="font-size:32px;margin-bottom:16px">📊</div>'+
    '<div style="font-size:16px;color:var(--muted);font-weight:600;margin-bottom:8px">No APME reports yet</div>'+
    '<div style="font-size:13px;color:var(--dim);max-width:420px;margin:0 auto 20px">'+
      'APME evaluates each coding agent session after it finishes — task quality, outcome, and vibe scores. Start Claude Code or Codex in your own workspace and come back here once it completes.'+
    '</div>'+
    '<div style="font-size:12px;color:var(--dim);border-top:1px solid var(--border);padding-top:16px;max-width:420px;margin:0 auto">'+
      '<div style="font-weight:600;margin-bottom:6px;color:var(--muted)">Quick start</div>'+
      '<div style="text-align:left;padding-left:16px">'+
        '<div>1. Enable AgentDeck hooks in Settings → Claude Code Hooks</div>'+
        '<div>2. Run your coding agent in your own workspace</div>'+
        '<div>3. When the agent finishes its turn, a row appears here</div>'+
      '</div>'+
    '</div>'+
  '</div>';
}
async function loadRuns(){
  try{
    const r=await fetch(api('/apme/runs?limit=50'));const d=await r.json();allRuns=(d.runs||[]).filter(r=>r.taskCategory!=='_empty'&&r.taskPrompt);
    populateFilters(allRuns);renderRuns(allRuns);
    document.getElementById('status').textContent=allRuns.length+' runs · '+new Date().toLocaleTimeString();
  }catch(e){document.getElementById('status').textContent='Error: '+e.message}
}

async function selectRun(id){
  selId=id;loadRuns();
  const el=document.getElementById('detail-panel');
  el.innerHTML='<div class="detail-empty">Loading...</div>';
  try{
    let r=await fetch(api('/apme/run/'+id));if(!r.ok)r=await fetch(api('/apme/run?id='+id));
    const d=await r.json();const run=d.run||{};const evals=d.evals||[];const turns=d.turns||[];const tasks=d.tasks||[];const vibe=d.vibe;

    // Normalize field names — Node.js uses snake_case, Swift may use camelCase in some paths.
    const startedAt=run.started_at??run.startedAt;
    const endedAt=run.ended_at??run.endedAt;
    const agentType=run.agent_type??run.agentType??'';
    const modelId=run.model_id??run.modelId??'—';
    const projectName=run.project_name??run.projectName??'—';
    const taskPrompt=run.task_prompt??run.taskPrompt;
    const taskCategory=run.task_category??run.taskCategory;
    const outcome=run.outcome;
    const outcomeConf=run.outcome_confidence??run.outcomeConfidence??'';
    const effJson=run.efficiency_json??run.efficiencyJson;
    const compScore=run.composite_score??run.compositeScore;
    const layer1Skipped=run.layer1_skipped_reason??run.layer1SkippedReason;

    const dur=endedAt&&startedAt?endedAt-startedAt:null;
    const tm=startedAt?new Date(startedAt).toLocaleString():'—';

    let h='<div class="detail-header">';
    h+='<h2>'+agentType+' / '+modelId+' / '+projectName+'</h2>';
    h+='<div class="meta-row">';
    h+='<span>🕐 '+tm+(dur?' · '+fd(dur):'')+'</span>';
    if(taskCategory)h+='<span><span class="badge-cat">'+taskCategory+'</span></span>';
    h+='<span style="font-family:monospace;font-size:11px;color:var(--dim);cursor:pointer" onclick="navigator.clipboard.writeText(\\''+run.id+'\\');this.textContent=\\'copied!\\';;setTimeout(()=>this.textContent=\\''+run.id.slice(0,12)+'\\',1000)" title="Click to copy full ID">'+run.id.slice(0,12)+'</span>';
    h+='</div></div>';

    // Task prompt
    if(taskPrompt){
      h+='<div class="section"><div class="section-head">Task</div>';
      h+='<div style="line-height:1.6;color:var(--text)">'+esc(taskPrompt.slice(0,600))+'</div></div>';
    }

    // Active session notice
    if(!endedAt){
      h+='<div class="section" style="padding:10px 12px;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.3);border-radius:6px;color:var(--blue);font-size:12px">⏳ Session active — score, category, and outcome appear after the session ends.</div>';
    }

    // Composite score bar
    if(compScore!=null){
      const pct=Math.round(compScore*100);
      h+='<div class="section"><div class="section-head"><span>Composite Score</span><span class="section-score" style="color:'+barColor(pct)+'">'+pct+'%</span></div>';
      h+='<div class="composite-bar"><div class="composite-fill" style="width:'+pct+'%;background:'+barColor(pct)+'"></div></div>';
      const je=evals.find(e=>e.metric==='overall'&&e.layer==='llm_judge');
      h+='<div class="weight-line">outcome('+(outcome||'—')+')×0.4 + judge('+(je?Math.round(je.score*100)+'%':'—')+')×0.3 + efficiency×0.2 + vibe('+(vibe?.verdict||'—')+')×0.1</div>';
      h+='</div>';
    }

    // Outcome
    if(outcome){
      h+='<div class="section"><div class="section-head"><span>Outcome</span><span style="font-size:11px;color:var(--dim)">'+outcomeConf.toUpperCase()+'</span></div>';
      h+=fo(outcome)+'</div>';
    }

    // Judge
    const jEvals=evals.filter(e=>e.layer==='llm_judge');
    if(jEvals.length>0){
      const ov=jEvals.find(e=>e.metric==='overall');
      h+='<div class="section"><div class="section-head"><span>LLM Judge</span>'+fs(ov?.score)+'</div>';
      h+='<div class="metric-grid">';
      for(const e of jEvals.filter(e=>e.metric!=='overall')){
        const p=Math.round(e.score*100);
        h+='<div class="metric-card"><div class="val" style="color:'+barColor(p)+'">'+p+'%</div><div class="lbl">'+e.metric.replace(/_/g,' ')+'</div></div>';
      }
      h+='</div>';
      if(ov?.raw){try{
        const raw=JSON.parse(ov.raw);
        if(raw.done?.length)for(const i of raw.done)h+='<div class="done-item">'+esc(i)+'</div>';
        if(raw.missed?.length)for(const i of raw.missed)h+='<div class="missed-item">'+esc(i)+'</div>';
        if(raw.reasoning)h+='<div class="reasoning">'+esc(raw.reasoning.slice(0,500))+'</div>';
      }catch{}}
      h+='</div>';
    }

    // Efficiency
    if(effJson){try{
      const eff=JSON.parse(effJson);
      h+='<div class="section"><div class="section-head">Efficiency</div><div class="metric-grid">';
      if(eff.diffLines!=null)h+='<div class="metric-card"><div class="val">'+eff.diffLines+'</div><div class="lbl">Lines Changed</div></div>';
      if(eff.tokensPerChange!=null)h+='<div class="metric-card"><div class="val">'+eff.tokensPerChange+'</div><div class="lbl">Tokens/Line</div></div>';
      if(eff.toolEfficiency!=null)h+='<div class="metric-card"><div class="val">'+eff.toolEfficiency+'</div><div class="lbl">Lines/Tool Call</div></div>';
      if(eff.timeToCompleteSec!=null)h+='<div class="metric-card"><div class="val">'+fd(eff.timeToCompleteSec*1000)+'</div><div class="lbl">Duration</div></div>';
      h+='</div></div>';
    }catch{}}

    // Deterministic
    const dEvals=evals.filter(e=>e.layer==='deterministic');
    if(dEvals.length>0){
      h+='<div class="section"><div class="section-head">Deterministic Checks</div>';
      for(const e of dEvals){
        const icon=e.score===1?'<span style="color:var(--green)">✓</span>':'<span style="color:var(--red)">✗</span>';
        let info='';
        if(e.raw){try{const r=JSON.parse(e.raw);info=' <span style="color:var(--dim);font-size:11px">('+r.command+', '+(r.durationMs?Math.round(r.durationMs/1000)+'s':'')+')</span>'}catch{}}
        h+='<div style="padding:4px 0">'+icon+' '+e.metric+info+'</div>';
      }
      h+='</div>';
    }else if(layer1Skipped){
      h+='<div class="section"><div class="section-head">Deterministic Checks</div>';
      h+='<div style="font-size:12px;color:var(--muted);line-height:1.5">LLM-only evaluation for this run. Deterministic project checks were skipped ('+esc(layer1Skipped)+').</div>';
      h+='</div>';
    }

    // Tasks — meaningful per-task units bounded by clear/session_end/manual/idle_gap
    if(tasks.length>0){
      h+='<div class="section"><div class="section-head">Tasks ('+tasks.length+')</div>';
      for(const tk of tasks){
        const idx=tk.task_index??tk.taskIndex??0;
        const sig=tk.boundary_signal??tk.boundarySignal??'open';
        const sigLabel=sig==='todo_complete'?'TODO done':sig==='clear'?'/clear':sig==='session_end'?'Session end':sig==='manual'?'Manual':sig==='idle_gap'?'Idle gap':sig;
        const summary=tk.summary||'';
        const cat=tk.task_category??tk.taskCategory;
        const cscore=tk.composite_score??tk.compositeScore;
        const oc=tk.outcome;
        const sa=tk.started_at??tk.startedAt;
        const ea=tk.ended_at??tk.endedAt;
        const dur=ea&&sa?fd(ea-sa):'open';
        const firstT=tk.first_turn_index??tk.firstTurnIndex;
        const lastT=tk.last_turn_index??tk.lastTurnIndex;
        const turnSpan=(firstT!=null&&lastT!=null)?(firstT===lastT?'turn '+firstT:'turns '+firstT+'–'+lastT):'';
        h+='<div class="turn-card">';
        h+='<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">';
        h+='<span class="turn-idx">Task '+(idx+1)+'</span>';
        h+='<span style="font-size:11px;color:var(--dim)">'+sigLabel+(turnSpan?' · '+turnSpan:'')+' · '+dur+'</span>';
        if(cscore!=null)h+=fs(cscore);else h+='<span style="font-size:11px;color:var(--dim)">…</span>';
        h+='</div>';
        const ocGlyph=oc==='success'?'✓':oc==='partial'?'△':oc==='fail'?'✗':oc==='abandoned'?'⊘':'';
        const ocColor=oc==='success'?'var(--green)':oc==='fail'?'var(--red)':oc==='partial'?'var(--orange,#f59e0b)':oc==='abandoned'?'var(--dim)':'var(--dim)';
        if(cat||oc)h+='<div style="margin-top:4px">'+(cat?'<span class="badge-cat">'+cat+'</span>':'')+(oc?' <span style="font-size:11px;color:'+ocColor+';margin-left:6px">'+ocGlyph+' '+oc+'</span>':'')+'</div>';
        if(summary)h+='<div style="color:var(--muted);font-size:12px;margin:6px 0 0;padding:6px 8px;background:var(--bg);border-radius:4px;border-left:2px solid var(--accent)">'+esc(summary.slice(0,500))+'</div>';
        h+='</div>';
      }
      h+='</div>';
    }

    // Turns
    if(turns.length>0){
      h+='<div class="section"><div class="section-head">Turns ('+turns.length+')</div>';
      for(const t of turns){
        const pr=t.prompt?esc(t.prompt.slice(0,150)):'(no prompt)';
        const d2=t.ended_at&&t.started_at?fd((t.ended_at-t.started_at)):'open';
        const tc=t.tool_calls||0;const fm=t.files_modified||0;const fc=t.files_created||0;
        const resp=t.response?esc(t.response.slice(0,300)):'';
        // Turn-level judge score (mid-session eval)
        const te=t.turnEvals||[];const tov=te.find(e=>e.metric==='overall'&&e.layer==='turn_judge');
        const tRaw=tov?.raw?JSON.parse(tov.raw):null;
        h+='<div class="turn-card">';
        h+='<div style="display:flex;align-items:center;justify-content:space-between">';
        h+='<span class="turn-idx">Turn '+t.turn_index+'</span>';
        if(tov!=null)h+=fs(tov.score);else h+='<span style="font-size:11px;color:var(--dim)">—</span>';
        h+='</div>';
        h+='<div class="turn-prompt">"'+pr+'"</div>';
        if(resp)h+='<div style="color:var(--muted);font-size:12px;margin:4px 0;padding:6px 8px;background:var(--bg);border-radius:4px;border-left:2px solid var(--accent)">'+resp+(t.response&&t.response.length>300?'...':'')+'</div>';
        if(tRaw?.reasoning)h+='<div class="reasoning" style="font-size:11px;margin-top:4px">'+esc(tRaw.reasoning.slice(0,300))+'</div>';
        h+='<div class="turn-stats"><span>'+tc+' tools</span><span>'+fm+' edits</span><span>'+fc+' creates</span><span>'+d2+'</span></div>';
        h+='</div>';
      }
      h+='</div>';
    }

    // Vibe + copy
    h+='<div class="vibe-bar">';
    h+='<button class="vibe-btn vibe-approve" onclick="submitVibe(\\''+run.id+'\\',\\'approve\\')">👍 Approve</button>';
    h+='<button class="vibe-btn vibe-reject" onclick="submitVibe(\\''+run.id+'\\',\\'reject\\')">👎 Reject</button>';
    h+='<button class="vibe-btn" style="background:var(--surface);color:var(--muted);border:1px solid var(--border);margin-left:auto" onclick="copyRunReport(\\''+run.id+'\\')">📋 Copy Report</button>';
    if(vibe)h+='<span class="vibe-current">'+vibe.verdict+(vibe.note?' — '+esc(vibe.note):'')+'</span>';
    h+='</div>';

    el.innerHTML=h;
  }catch(e){el.innerHTML='<div class="detail-empty">Error: '+e.message+'</div>'}
}

function copyRunReport(rid){
  const el=document.getElementById('detail-panel');
  if(!el)return;
  // Build text report from the detail panel content
  const text=el.innerText.replace(/👍 Approve|👎 Reject|📋 Copy Report/g,'').trim();
  const header='Run: '+rid+'\\nURL: '+location.href;
  navigator.clipboard.writeText(header+'\\n\\n'+text).then(()=>{
    const btn=el.querySelector('[onclick*="copyRunReport"]');
    if(btn){const orig=btn.textContent;btn.textContent='Copied!';setTimeout(()=>btn.textContent=orig,1500)}
  });
}

async function submitVibe(rid,v){
  try{await fetch(api('/apme/vibe'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:rid,verdict:v})});selectRun(rid)}
  catch(e){alert('Error: '+e.message)}
}

async function loadScorecard(){
  try{const r=await fetch(api('/apme/scorecard'));const d=await r.json();const c=d.scorecards||[];
  if(!c.length){document.getElementById('scorecard-content').innerHTML='<div class="empty">No scorecard data yet</div>';return}
  let h='<table><thead><tr><th>Model</th><th>Agent</th><th>Runs</th><th>Score</th><th>Tests</th><th>Cost</th><th>$/Quality</th></tr></thead><tbody>';
  for(const s of c)h+='<tr><td>'+s.modelId+'</td><td>'+s.agentType+'</td><td>'+s.runs+'</td><td>'+fs(s.avgOverall)+'</td><td>'+fs(s.avgTestsPass)+'</td><td>'+(s.totalCost!=null?'$'+s.totalCost.toFixed(2):'—')+'</td><td>'+(s.costPerQuality!=null?'$'+s.costPerQuality.toFixed(2):'—')+'</td></tr>';
  h+='</tbody></table>';document.getElementById('scorecard-content').innerHTML=h;
  }catch(e){document.getElementById('scorecard-content').innerHTML='<div class="empty">Error: '+e.message+'</div>'}
}

async function loadCategories(){
  try{const r=await fetch(api('/apme/categories'));const d=await r.json();const c=d.categories||[];
  if(!c.length){document.getElementById('categories-content').innerHTML='<div class="empty">No category data yet</div>';return}
  let h='<table><thead><tr><th>Category</th><th>Model</th><th>Runs</th><th>Score</th><th>Tests</th><th>Cost</th></tr></thead><tbody>';
  for(const s of c)h+='<tr><td><span class="badge-cat">'+s.taskCategory+'</span></td><td>'+s.modelId+'</td><td>'+s.runs+'</td><td>'+fs(s.avgOverall)+'</td><td>'+fs(s.avgTestsPass)+'</td><td>'+(s.totalCost!=null?'$'+s.totalCost.toFixed(2):'—')+'</td></tr>';
  h+='</tbody></table>';document.getElementById('categories-content').innerHTML=h;
  }catch(e){document.getElementById('categories-content').innerHTML='<div class="empty">Error: '+e.message+'</div>'}
}

/**
 * Recommend tab — surfaces the recommender payoff: for each task category,
 * which agent/model performs best. Ranks the (agent, model, category)
 * sample-granularity scorecard (v_sample_scorecard) by quality, tie-broken by
 * cost-per-quality. The top row per category is the recommended default — this
 * is the "which agent/model is good at what" answer APME exists to produce.
 */
async function loadRecommend(){
  try{
    const r=await fetch(api('/apme/samples'));const d=await r.json();
    const rows=(d.scorecards||[]).filter(s=>s.taskCategory&&s.taskCategory!=='_empty'&&s.avgQuality!=null);
    const el=document.getElementById('recommend-content');
    if(!rows.length){el.innerHTML='<div class="empty">Not enough evaluated tasks yet — recommendations appear once tasks have composite scores.</div>';return}
    const byCat={};
    for(const s of rows){(byCat[s.taskCategory]=byCat[s.taskCategory]||[]).push(s)}
    let h='<div style="padding:12px 14px">';
    h+='<div style="font-size:12px;color:var(--muted);margin-bottom:14px;line-height:1.5">Best agent/model per task category — ranked by quality, tie-broken by cost-per-quality. ★ marks the recommended default for that kind of task.</div>';
    for(const cat of Object.keys(byCat).sort()){
      const list=byCat[cat].sort((a,b)=>(b.avgQuality-a.avgQuality)||((a.costPerQuality==null?1e9:a.costPerQuality)-(b.costPerQuality==null?1e9:b.costPerQuality)));
      const best=list[0];
      h+='<div style="margin-bottom:18px">';
      h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap"><span class="badge-cat">'+esc(cat)+'</span>';
      h+='<span style="font-size:12px;color:var(--muted)">Best: <b style="color:var(--text)">'+esc(best.agentType||'?')+' / '+esc(best.modelId||'?')+'</b> · '+fs(best.avgQuality)+' · '+(best.costPerQuality!=null?'$'+best.costPerQuality.toFixed(3)+'/q':'—')+' · '+best.samples+' samples</span></div>';
      h+='<table style="margin-top:4px"><thead><tr><th>Agent</th><th>Model</th><th>Quality</th><th>$/Quality</th><th>Cost</th><th>Samples</th></tr></thead><tbody>';
      for(const s of list){
        const isBest=s===best;
        h+='<tr'+(isBest?' style="background:rgba(34,197,94,0.08)"':'')+'><td>'+(isBest?'★ ':'')+esc(s.agentType||'—')+'</td><td>'+esc((s.modelId||'—').slice(0,22))+'</td><td>'+fs(s.avgQuality)+'</td><td>'+(s.costPerQuality!=null?'$'+s.costPerQuality.toFixed(3):'—')+'</td><td>'+(s.totalCost!=null?'$'+s.totalCost.toFixed(2):'—')+'</td><td>'+s.samples+'</td></tr>';
      }
      h+='</tbody></table></div>';
    }
    h+='</div>';
    el.innerHTML=h;
  }catch(e){document.getElementById('recommend-content').innerHTML='<div class="empty">Error: '+e.message+'</div>'}
}

loadRuns();loadRecommend();loadScorecard();loadCategories();
setInterval(loadRuns,15000);setInterval(loadRecommend,30000);setInterval(loadScorecard,30000);setInterval(loadCategories,30000);
</script>
</body>
</html>`;
}
