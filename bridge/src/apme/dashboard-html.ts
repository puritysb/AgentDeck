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
/* Graph needs a column flex box so the canvas can claim the leftover height. */
.panel#panel-graph.visible{display:flex;flex-direction:column}
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
      <button class="tab" onclick="showTab('tasks')">Tasks</button>
      <button class="tab" onclick="showTab('graph')">Graph</button>
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
      <!-- Tasks: every processed work unit, paged server-side. The Runs tab
           lists sessions; this lists the units the judge actually scores. -->
      <div class="panel" id="panel-tasks">
        <div style="display:flex;gap:6px;padding:8px 10px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap;align-items:center">
          <input id="t-q" placeholder="Search prompt / summary" oninput="taskSearchDebounced()" style="background:var(--bg);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:11px;flex:1;min-width:140px">
          <select id="t-agent" onchange="loadTasks(0)" style="background:var(--bg);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:11px"><option value="">All Agents</option></select>
          <select id="t-project" onchange="loadTasks(0)" style="background:var(--bg);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:11px"><option value="">All Projects</option></select>
          <select id="t-cat" onchange="loadTasks(0)" style="background:var(--bg);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:11px"><option value="">All Categories</option></select>
          <select id="t-state" onchange="loadTasks(0)" style="background:var(--bg);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:11px"><option value="">All</option><option value="closed">Closed</option><option value="open">Open</option></select>
        </div>
        <table><thead><tr>
          <th>Task</th><th>Agent</th><th>Project</th><th>Category</th><th>Turns</th><th>Tools</th><th>Score</th><th>Outcome</th><th>Time</th>
        </tr></thead><tbody id="tasks-body"></tbody></table>
        <div id="tasks-pager" style="display:flex;gap:8px;align-items:center;justify-content:center;padding:10px;font-size:11px;color:var(--dim)"></div>
      </div>
      <!-- Graph: the row store as a property graph. Self-contained force
           layout — the dashboard ships as one inlined HTML document. -->
      <div class="panel" id="panel-graph">
        <div style="display:flex;gap:6px;padding:8px 10px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap;align-items:center">
          <label style="font-size:11px;color:var(--dim)">Tasks <input id="g-limit" type="number" min="1" max="400" value="40" onchange="loadGraph()" style="width:56px;background:var(--bg);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11px"></label>
          <label style="font-size:11px;color:var(--dim)">Min hub <input id="g-hub" type="number" min="1" max="20" value="2" onchange="loadGraph()" style="width:48px;background:var(--bg);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11px"></label>
          <label style="font-size:11px;color:var(--dim)"><input id="g-turns" type="checkbox" onchange="loadGraph()"> turns</label>
          <label style="font-size:11px;color:var(--dim)"><input id="g-files" type="checkbox" checked onchange="loadGraph()"> files</label>
          <span id="g-stats" style="font-size:11px;color:var(--dim);margin-left:auto"></span>
        </div>
        <div style="position:relative;flex:1;min-height:420px">
          <canvas id="g-canvas" style="width:100%;height:100%;display:block;cursor:grab"></canvas>
          <div id="g-legend" style="position:absolute;left:10px;bottom:10px;font-size:10px;color:var(--dim);background:rgba(0,0,0,0.35);padding:6px 8px;border-radius:4px;line-height:1.7"></div>
          <div id="g-tip" style="position:absolute;display:none;pointer-events:none;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:6px 8px;font-size:11px;color:var(--muted);max-width:280px"></div>
        </div>
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
let selTaskId=null,taskOffset=0,taskTotal=0,tasksLoaded=false,taskSearchTimer=null;const TASK_PAGE=50;
let graphSim=null;
const AUTH=new URLSearchParams(location.search).get('token')||'';
function api(path){const sep=path.includes('?')?'&':'?';return B+path+(AUTH?sep+'token='+encodeURIComponent(AUTH):'')}

function showTab(n){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('visible'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('panel-'+n).classList.add('visible');
  event.target.classList.add('active');
  // Tasks and Graph load on first reveal, not at boot: both are server-paged
  // queries over the whole store, and the graph canvas cannot size itself
  // while its panel is display:none.
  if(n==='tasks'&&!tasksLoaded){tasksLoaded=true;loadTasks(0)}
  if(n==='graph'){requestAnimationFrame(()=>loadGraph())}
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
    }else{
      // Completed but un-scored: no composite, no LLM/task/turn judge, no
      // deterministic, no manual review. Without this, the panel reads as a
      // bare header and the user can't tell whether evaluation failed, was
      // skipped, or a judge was never configured. Explain it and point at
      // the fix — the same judge-availability thread as the REVIEW guide.
      const scored=compScore!=null||evals.length>0;
      if(!scored){
        const reason=layer1Skipped?('deterministic checks skipped ('+esc(layer1Skipped)+') and no LLM judge ran'):'no evaluation ran for this task';
        h+='<div class="section" style="padding:10px 12px;background:rgba(148,163,184,0.12);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--muted);line-height:1.5">🔍 Not evaluated — '+reason+'.<br>Turn on a judge (Anthropic API, OpenClaw, local MLX 8B+, or Apple Intelligence) in <code>apme.judge</code> to score future tasks. Tasks without a judge still record their trajectory, cost, and outcome — they just carry no quality score.</div>';
      }
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

    // Manual reviews (REVIEW deck button) — distinguished from the automatic
    // pipeline by the layer flag. score = risk weight (1=low, .5=med, 0=high).
    const mEvals=evals.filter(e=>e.layer==='manual_review');
    if(mEvals.length>0){
      h+='<div class="section"><div class="section-head"><span>Manual Reviews <span style="font-size:10px;color:var(--dim);border:1px solid var(--dim);border-radius:8px;padding:1px 6px;margin-left:6px">hand-run</span></span><span style="font-size:11px;color:var(--dim)">'+mEvals.length+'</span></div>';
      for(const e of mEvals){
        const risk=e.score>=1?'low':e.score>=0.5?'medium':'high';
        const rc=risk==='high'?'var(--red)':risk==='medium'?'var(--amber,#d19a3a)':'var(--green)';
        let summary='',findings=0;
        if(e.raw){try{const r=JSON.parse(e.raw);summary=r.summary||'';findings=(r.findings||[]).length;}catch{}}
        h+='<div style="padding:6px 0;border-bottom:1px solid var(--border,rgba(255,255,255,.06))">';
        h+='<span style="color:'+rc+';font-weight:600;font-size:12px">RISK '+risk.toUpperCase()+'</span>';
        h+=' <span style="color:var(--dim);font-size:11px">'+findings+' finding'+(findings===1?'':'s')+' · '+esc(e.judgeModel||'?')+'</span>';
        if(summary)h+='<div style="font-size:12px;color:var(--muted);margin-top:2px">'+esc(summary.slice(0,300))+'</div>';
        h+='</div>';
      }
      h+='</div>';
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

    // Tasks — meaningful per-task units bounded by todo_complete/clear/session_end/manual/idle_gap
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

/* ── Tasks tab ──────────────────────────────────────────────────────────────
   The task unit is what the judge scores, but it used to be reachable only by
   drilling into a run — so there was no way to see everything processed. This
   pages server-side (the store holds thousands of units) and keeps its filters
   in the query rather than filtering a fetched page client-side, which would
   silently hide matches beyond the page. */
async function loadTasks(offset){
  taskOffset=offset||0;
  const body=document.getElementById('tasks-body');
  const p=new URLSearchParams();
  p.set('limit',String(TASK_PAGE));p.set('offset',String(taskOffset));
  const q=document.getElementById('t-q').value.trim();if(q)p.set('q',q);
  const ag=document.getElementById('t-agent').value;if(ag)p.set('agent',ag);
  const pr=document.getElementById('t-project').value;if(pr)p.set('project',pr);
  const ct=document.getElementById('t-cat').value;if(ct)p.set('category',ct);
  const st=document.getElementById('t-state').value;if(st)p.set('state',st);
  try{
    const r=await fetch(api('/apme/tasks?'+p.toString()));const d=await r.json();
    const tasks=d.tasks||[];taskTotal=d.total||0;
    fillTaskFacets(d.facets||{});
    if(!tasks.length){body.innerHTML='<tr><td colspan="9" class="empty">No tasks match</td></tr>';document.getElementById('tasks-pager').textContent='';return}
    let h='';
    for(const t of tasks){
      const label=t.summary||t.firstPrompt||('Task '+t.taskIndex);
      // A unit whose replies were never archived can only be partly judged —
      // say so on the row instead of letting a blank score read as "not run".
      const gap=t.turnCount>t.answeredTurns
        ?' <span title="'+(t.turnCount-t.answeredTurns)+' turn(s) archived without a reply" style="color:var(--yellow)">◍</span>':'';
      h+='<tr'+(selTaskId===t.id?' class="selected"':'')+' onclick="selectTask(\\''+t.id+'\\')">'+
        '<td title="'+esc(label)+'">'+esc(label.slice(0,52))+gap+'</td>'+
        '<td>'+esc(t.agentType||'')+'</td>'+
        '<td>'+esc(t.projectName||'—')+'</td>'+
        '<td>'+(t.taskCategory?'<span class="badge-cat">'+esc(t.taskCategory)+'</span>':'—')+'</td>'+
        '<td>'+t.turnCount+'</td><td>'+t.toolCount+'</td>'+
        '<td>'+fs(t.overallScore)+'</td>'+
        '<td>'+(t.outcome?fo(t.outcome):(t.endedAt?'':'<span class="badge">open</span>'))+'</td>'+
        '<td>'+(t.startedAt?new Date(t.startedAt).toLocaleString():'—')+'</td></tr>';
    }
    body.innerHTML=h;
    const from=taskTotal?taskOffset+1:0,to=Math.min(taskOffset+tasks.length,taskTotal);
    document.getElementById('tasks-pager').innerHTML=
      '<button onclick="loadTasks('+Math.max(0,taskOffset-TASK_PAGE)+')" '+(taskOffset<=0?'disabled':'')+' style="background:var(--surface);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:3px 10px;cursor:pointer">Prev</button>'+
      '<span>'+from+'–'+to+' of '+taskTotal+'</span>'+
      '<button onclick="loadTasks('+(taskOffset+TASK_PAGE)+')" '+(to>=taskTotal?'disabled':'')+' style="background:var(--surface);color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:3px 10px;cursor:pointer">Next</button>';
  }catch(e){body.innerHTML='<tr><td colspan="9" class="empty">Error: '+esc(e.message)+'</td></tr>'}
}
function fillTaskFacets(f){
  // Facets come from the whole store, not the current page, so a filter never
  // offers only what happens to be visible.
  const fill=(id,vals)=>{const s=document.getElementById(id);const cur=s.value;
    while(s.options.length>1)s.remove(1);
    (vals||[]).forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;s.add(o)});
    s.value=cur;};
  fill('t-agent',f.agents);fill('t-project',f.projects);fill('t-cat',f.categories);
}
function taskSearchDebounced(){clearTimeout(taskSearchTimer);taskSearchTimer=setTimeout(()=>loadTasks(0),250)}

async function selectTask(id){
  selTaskId=id;
  const el=document.getElementById('detail-panel');
  el.innerHTML='<div class="detail-empty">Loading...</div>';
  try{
    const r=await fetch(api('/apme/tasks/'+id));const d=await r.json();
    const t=d.task||{},run=d.run||{},turns=d.turns||[],evals=d.evals||[],sample=d.sample;
    let h='';
    h+='<div class="detail-header"><h2>'+esc(t.summary||('Task '+t.taskIndex))+'</h2>';
    h+='<div class="meta-row"><span>'+esc(run.agentType||'')+'</span><span>'+esc(run.modelId||'—')+'</span>'+
       '<span>'+esc(run.projectName||'—')+'</span>'+
       '<span>'+(t.startedAt?new Date(t.startedAt).toLocaleString():'—')+'</span>'+
       '<span>'+(t.endedAt?fd(t.endedAt-t.startedAt):'<span style="color:var(--yellow)">open</span>')+'</span>'+
       '<span>boundary '+esc(t.boundarySignal||'—')+'</span></div></div>';
    h+='<div class="section"><div class="metric-grid">'
       '<div class="metric-card"><div class="lbl">Score</div><div class="val">'+fs(d.overallScore??t.compositeScore)+'</div></div>'+
       '<div class="metric-card"><div class="lbl">Turns</div><div class="val">'+turns.length+'</div></div>'+
       '<div class="metric-card"><div class="lbl">Events</div><div class="val">'+((sample&&sample.events?sample.events.length:0))+'</div></div>'+
       '<div class="metric-card"><div class="lbl">Cost</div><div class="val">'+(t.costUsd!=null?'$'+t.costUsd.toFixed(4):'—')+'</div></div>'+
       '</div></div>';
    if(evals.length){
      h+='<div class="section"><div class="section-head"><span>Evals</span></div><table><tbody>';
      for(const e of evals)h+='<tr><td>'+esc(e.layer)+'</td><td>'+esc(e.metric)+'</td><td>'+fs(e.score)+'</td></tr>';
      h+='</tbody></table></div>';
    }
    // The conversation. This is what the response-capture gap used to make
    // impossible to show: prompts with no replies beside them.
    h+='<div class="section"><div class="section-head"><span>Conversation</span></div>';
    if(!turns.length)h+='<div class="empty">No turns recorded</div>';
    for(const tu of turns){
      const prompt=tu.prompt||'',resp=tu.response;
      h+='<div style="margin-bottom:12px">'+
        '<div style="font-size:11px;color:var(--dim);margin-bottom:3px">turn '+tu.turn_index+'</div>'+
        '<div style="white-space:pre-wrap;font-size:12px;color:var(--muted);border-left:2px solid var(--accent);padding-left:8px">'+esc(prompt.slice(0,1200))+'</div>';
      h+= resp
        ? '<div style="white-space:pre-wrap;font-size:12px;color:var(--dim);border-left:2px solid var(--border);padding-left:8px;margin-top:6px">'+esc(resp.slice(0,2000))+'</div>'
        : '<div style="font-size:11px;color:var(--yellow);padding-left:10px;margin-top:6px">reply not archived</div>';
      h+='</div>';
    }
    h+='</div>';
    el.innerHTML=h;
  }catch(e){el.innerHTML='<div class="detail-empty">Error: '+esc(e.message)+'</div>'}
  loadTasks(taskOffset);
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

/* ── Graph tab ──────────────────────────────────────────────────────────────
   A force-directed view of /apme/graph. Hand-rolled rather than imported: the
   dashboard is served as one self-contained HTML document with no external
   fetches, so a CDN layout library is not an option.

   Colour is by node kind; radius by degree, so the derived hubs (a file many
   tasks touched, a tool used everywhere) are the ones that read as structural. */
const G_COLORS={run:'#6166E0',task:'#22c55e',turn:'#64748b',session:'#eab308',project:'#06b6d4',model:'#a855f7',agent:'#C07058',tool:'#f97316',file:'#94a3b8'};
const G_EDGE={contains:'rgba(148,163,184,0.35)',continues:'rgba(97,102,224,0.75)',produced:'rgba(234,179,8,0.30)',used:'rgba(249,115,22,0.30)',touched:'rgba(148,163,184,0.25)'};

async function loadGraph(){
  const stats=document.getElementById('g-stats');
  const p=new URLSearchParams();
  p.set('limit',document.getElementById('g-limit').value||'40');
  p.set('minHubDegree',document.getElementById('g-hub').value||'2');
  p.set('turns',document.getElementById('g-turns').checked?'1':'0');
  p.set('files',document.getElementById('g-files').checked?'1':'0');
  stats.textContent='Loading...';
  try{
    const r=await fetch(api('/apme/graph?'+p.toString()));const d=await r.json();
    const s=d.stats||{};
    // Say what was left out. A truncated graph that looks complete is worse
    // than no graph — the shape would read as the whole history.
    stats.textContent=s.nodeCount+' nodes · '+s.edgeCount+' edges · '+s.taskCount+' tasks'+
      (s.truncatedTasks?' (+'+s.truncatedTasks+' not shown)':'')+
      (s.fileCoverage?' · file paths on '+s.fileCoverage.withPath+'/'+s.fileCoverage.toolEvents+' tool events':'');
    renderLegend(d.nodes||[]);
    startGraphSim(d.nodes||[],d.edges||[]);
  }catch(e){stats.textContent='Error: '+e.message}
}

function renderLegend(nodes){
  const counts={};for(const n of nodes)counts[n.kind]=(counts[n.kind]||0)+1;
  document.getElementById('g-legend').innerHTML=Object.keys(counts).sort().map(k=>
    '<div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+G_COLORS[k]+';margin-right:6px"></span>'+k+' ('+counts[k]+')</div>').join('');
}

function startGraphSim(nodes,edges){
  const canvas=document.getElementById('g-canvas');
  const dpr=window.devicePixelRatio||1;
  const w=canvas.clientWidth||800,h=canvas.clientHeight||500;
  canvas.width=w*dpr;canvas.height=h*dpr;
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);
  if(graphSim)cancelAnimationFrame(graphSim.raf);

  const byId=new Map();
  nodes.forEach((n,i)=>{
    // Deterministic seeding — a golden-angle spiral, not Math.random(), so a
    // reload of the same slice settles into the same picture and the layout is
    // comparable between refreshes.
    const a=i*2.399963,rad=6*Math.sqrt(i);
    n.x=w/2+rad*Math.cos(a);n.y=h/2+rad*Math.sin(a);n.vx=0;n.vy=0;
    n.r=Math.min(14,3+Math.sqrt(n.degree||1)*1.6);
    byId.set(n.id,n);
  });
  const links=edges.map(e=>({s:byId.get(e.from),t:byId.get(e.to),kind:e.kind,w:e.weight||1}))
                   .filter(l=>l.s&&l.t);

  const view={x:0,y:0,k:1};let drag=null,hover=null;
  canvas.onmousedown=(ev)=>{drag={x:ev.clientX,y:ev.clientY,vx:view.x,vy:view.y};canvas.style.cursor='grabbing'};
  window.addEventListener('mouseup',()=>{drag=null;canvas.style.cursor='grab'});
  canvas.onmousemove=(ev)=>{
    const rect=canvas.getBoundingClientRect();
    if(drag){view.x=drag.vx+(ev.clientX-drag.x);view.y=drag.vy+(ev.clientY-drag.y);return}
    const mx=(ev.clientX-rect.left-view.x)/view.k,my=(ev.clientY-rect.top-view.y)/view.k;
    hover=null;let best=1e9;
    for(const n of nodes){const dx=n.x-mx,dy=n.y-my,d2=dx*dx+dy*dy;if(d2<Math.max(64,n.r*n.r*4)&&d2<best){best=d2;hover=n}}
    const tip=document.getElementById('g-tip');
    if(hover){
      const meta=Object.entries(hover.meta||{}).filter(([,v])=>v!=null&&v!=='').map(([k,v])=>k+': '+v).join(' · ');
      tip.style.display='block';tip.style.left=(ev.clientX-rect.left+12)+'px';tip.style.top=(ev.clientY-rect.top+12)+'px';
      tip.innerHTML='<b style="color:'+G_COLORS[hover.kind]+'">'+esc(hover.kind)+'</b> '+esc(hover.label)+
        '<div style="color:var(--dim);margin-top:3px">degree '+(hover.degree||0)+(meta?' · '+esc(meta):'')+'</div>';
    } else tip.style.display='none';
  };
  canvas.onwheel=(ev)=>{ev.preventDefault();const f=ev.deltaY<0?1.1:0.9;view.k=Math.max(0.2,Math.min(4,view.k*f))};
  canvas.onclick=()=>{if(hover&&hover.kind==='task'){showTabById('tasks');selectTask(hover.id.slice(5))}};

  // Barnes-Hut would be overkill: the slice is capped at a few hundred nodes,
  // so an O(n²) repulsion pass stays well inside a frame budget.
  // Repulsion and rest length scale with node count: constants tuned on a
  // 30-node slice collapse into an unreadable ball at 300, and the whole point
  // of the view is that the hub structure is visible.
  const repel=900+nodes.length*14;
  const linkLen=50+Math.min(60,nodes.length*0.25);
  let alpha=1;
  function step(){
    if(alpha>0.005){
      for(let i=0;i<nodes.length;i++){
        const a=nodes[i];
        for(let j=i+1;j<nodes.length;j++){
          const b=nodes[j];let dx=b.x-a.x,dy=b.y-a.y;let d2=dx*dx+dy*dy;
          if(d2<0.01){dx=(i-j)*0.1;dy=0.1;d2=0.02}
          if(d2>250000)continue;
          const f=repel/d2,d=Math.sqrt(d2);
          const fx=f*dx/d,fy=f*dy/d;
          a.vx-=fx;a.vy-=fy;b.vx+=fx;b.vy+=fy;
        }
      }
      for(const l of links){
        const dx=l.t.x-l.s.x,dy=l.t.y-l.s.y,d=Math.sqrt(dx*dx+dy*dy)||0.01;
        const f=(d-linkLen)*0.02;
        const fx=f*dx/d,fy=f*dy/d;
        l.s.vx+=fx;l.s.vy+=fy;l.t.vx-=fx;l.t.vy-=fy;
      }
      for(const n of nodes){
        n.vx+=(w/2-n.x)*0.002;n.vy+=(h/2-n.y)*0.002;   // gravity keeps it on screen
        n.x+=(n.vx*=0.82)*alpha;n.y+=(n.vy*=0.82)*alpha;
      }
      alpha*=0.985;
    }
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,w,h);
    ctx.save();ctx.translate(view.x,view.y);ctx.scale(view.k,view.k);
    for(const l of links){
      ctx.strokeStyle=G_EDGE[l.kind]||'rgba(148,163,184,0.25)';
      ctx.lineWidth=l.kind==='continues'?2:Math.min(3,0.6+Math.log2(l.w));
      ctx.beginPath();ctx.moveTo(l.s.x,l.s.y);ctx.lineTo(l.t.x,l.t.y);ctx.stroke();
    }
    for(const n of nodes){
      ctx.fillStyle=G_COLORS[n.kind]||'#94a3b8';
      ctx.globalAlpha=hover&&hover!==n?0.55:1;
      ctx.beginPath();ctx.arc(n.x,n.y,n.r,0,6.2832);ctx.fill();
      // Label only what carries the structure, else the canvas is unreadable.
      if(n.r>7||n===hover){
        ctx.globalAlpha=1;ctx.fillStyle='#cbd5e1';ctx.font='10px ui-monospace,monospace';
        ctx.fillText(String(n.label||'').slice(0,26),n.x+n.r+3,n.y+3);
      }
      ctx.globalAlpha=1;
    }
    ctx.restore();
    graphSim.raf=requestAnimationFrame(step);
  }
  graphSim={raf:0};step();
}
/* showTab() reads the clicked element off the global event; switching tabs
   from code needs the button, so find it rather than fake an event. */
function showTabById(n){
  const btn=[...document.querySelectorAll('.tab')].find(b=>b.getAttribute('onclick')==="showTab('"+n+"')");
  if(btn)btn.click();
}

loadRuns();loadRecommend();loadScorecard();loadCategories();
setInterval(loadRuns,15000);setInterval(loadRecommend,30000);setInterval(loadScorecard,30000);setInterval(loadCategories,30000);
// Tasks refresh only while its tab is up — the query is server-paged and there
// is no reason to run it against the store every 15s in the background.
setInterval(()=>{if(document.getElementById('panel-tasks').classList.contains('visible'))loadTasks(taskOffset)},15000);
</script>
</body>
</html>`;
}
