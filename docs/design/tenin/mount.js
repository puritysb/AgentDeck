// AgentDeck 10" — mount + variant layouts + demo loop. window.AgentDeck.mount(cfg)
window.AgentDeck = (function () {
  const { AGENTS, STATE, RATE, SERVICES, weight, tier } = window.TEN;
  const { Terrarium } = window.TENT;
  const { renderCell, createDetail } = window.TENL;

  const el = (cls, tag) => { const e = document.createElement(tag || 'div'); if (cls) e.className = cls; return e; };

  // ── squarified treemap → {id:{x,y,w,h}} ──
  function treemap(items, rect) {
    const out = {};
    const total = items.reduce((s, i) => s + i.weight, 0) || 1;
    const nodes = items.map((i) => ({ id: i.id, area: i.weight / total * rect.w * rect.h }))
      .sort((a, b) => b.area - a.area);
    let { x, y, w, h } = rect;
    const worst = (row, side) => {
      let s = 0, mn = Infinity, mx = 0;
      for (const r of row) { s += r.area; if (r.area < mn) mn = r.area; if (r.area > mx) mx = r.area; }
      const s2 = s * s, sd2 = side * side;
      return Math.max(sd2 * mx / s2, s2 / (sd2 * mn));
    };
    const layoutRow = (row) => {
      const s = row.reduce((a, r) => a + r.area, 0);
      if (w >= h) { const cw = s / h; let cy = y; for (const r of row) { const ch = r.area / cw; out[r.id] = { x, y: cy, w: cw, h: ch }; cy += ch; } x += cw; w -= cw; }
      else { const ch = s / w; let cx = x; for (const r of row) { const cw = r.area / ch; out[r.id] = { x: cx, y, w: cw, h: ch }; cx += cw; } y += ch; h -= ch; }
    };
    let row = [], i = 0;
    while (i < nodes.length) {
      const n = nodes[i], side = Math.min(w, h);
      if (row.length && worst(row, side) < worst(row.concat(n), side)) { layoutRow(row); row = []; }
      else { row.push(n); i++; }
    }
    if (row.length) layoutRow(row);
    return out;
  }
  function tierFor(w, h) {
    if (w < 124 || h < 62) return 'xs';
    if (w < 200 || h < 86) return 'sm';
    if (h < 150) return 'md';
    if (h < 250 || w < 300) return 'lg';
    return 'xl';
  }

  // ── top bar ──
  function topbar(root, H, app) {
    const tb = el('topbar'); tb.style.height = H + 'px';
    const r5 = RATE.fiveHour;
    tb.innerHTML =
      '<div class="brand"><img class="mk" src="../../design/brand/agentdeck-icon.png" alt="AgentDeck" />' +
        '<div class="nm">Agent<b>Deck</b></div></div>' +
      '<div class="seg"><span style="width:7px;height:7px;border-radius:9px;background:var(--ok);display:inline-block"></span> daemon :9120 · 4 agents</div>' +
      '<div class="spacer"></div>' +
      '<div class="gauge"><span class="lab">5h</span><div class="bar"><i style="width:' + r5.pct + '%"></i></div><span class="pct">' + r5.pct + '%</span></div>' +
      '<div class="gauge"><span class="lab">7d</span><div class="bar"><i style="width:' + RATE.sevenDay.pct + '%"></i></div><span class="pct">' + RATE.sevenDay.pct + '%</span></div>' +
      '<div class="clock" data-clock>14:32</div>';
    root.appendChild(tb);
    const ck = tb.querySelector('[data-clock]');
    const tick = () => { const d = new Date(); ck.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
    tick(); app.timers.push(setInterval(tick, 10000));
  }

  function legend(container) {
    const lg = el('legend');
    lg.innerHTML = Object.keys(STATE).map((k) =>
      '<span><i style="background:' + STATE[k].color + '"></i>' + STATE[k].label + '</span>').join('');
    container.appendChild(lg);
  }
  function terrChrome(c, label) {
    const cap = el('caption'); cap.textContent = label; c.appendChild(cap);
    const sf = el('surface'), fl = el('floor'); c.appendChild(sf); c.appendChild(fl);
    legend(c);
  }

  // ════════ BENTO (D1) ════════
  function buildBento(stage, app, orient) {
    stage.style.flexDirection = orient === 'portrait' ? 'column' : 'row';
    const terr = el('terr');
    const work = el('work');
    if (orient === 'portrait') { terr.style.cssText = 'flex:0 0 30%'; work.style.cssText = 'flex:1'; }
    else { terr.style.cssText = 'flex:0 0 37%; border-right:1px solid var(--line)'; work.style.cssText = 'flex:1'; }
    stage.appendChild(terr); stage.appendChild(work);
    terrChrome(terr, 'terrarium · 10 live sessions');
    const T = Terrarium(terr, app.sessions, { size: 44, onHover: app.setActive, onClick: (s) => app.detail.open(s) });

    const layer = el(''); layer.style.cssText = 'position:absolute;inset:0';
    work.appendChild(layer);
    const nodes = {};
    const meta = {}; // id -> {state,tier}
    const GAP = 10, PAD = 14;

    function relayout(animate) {
      const W = work.clientWidth, Hh = work.clientHeight;
      const rects = treemap(app.sessions.map((s) => ({ id: s.id, weight: weight(s) })),
        { x: PAD, y: PAD, w: W - PAD * 2, h: Hh - PAD * 2 });
      app.sessions.forEach((s) => {
        const r = rects[s.id]; if (!r) return;
        const cw = Math.max(40, r.w - GAP), ch = Math.max(40, r.h - GAP);
        const t = tierFor(cw, ch);
        let n = nodes[s.id];
        if (!n) { n = renderCell(s, t); n.style.cssText = 'position:absolute;transition:left .55s var(--ease-snap,cubic-bezier(.2,.6,.2,1)),top .55s var(--ease-snap),width .55s var(--ease-snap),height .55s var(--ease-snap),box-shadow .2s,border-color .2s'; layer.appendChild(n); nodes[s.id] = n; meta[s.id] = {}; }
        if (meta[s.id].state !== s.state || meta[s.id].tier !== t) {
          const fresh = renderCell(s, t); n.className = fresh.className; n.innerHTML = fresh.innerHTML;
          meta[s.id] = { state: s.state, tier: t };
        }
        n.style.left = r.x + 'px'; n.style.top = r.y + 'px';
        n.style.width = cw + 'px'; n.style.height = ch + 'px';
      });
    }
    relayout(false);
    new ResizeObserver(() => relayout(false)).observe(work);
    return { terr: T, relayout, container: work };
  }

  // ════════ LANES (D2) ════════
  function buildLanes(stage, app, orient) {
    const port = orient === 'portrait';
    stage.style.flexDirection = 'column';
    const lanesWrap = el(''); lanesWrap.style.cssText = 'flex:1;min-height:0;display:flex;gap:10px;padding:12px;' + (port ? 'flex-direction:column' : 'flex-direction:row');
    const terr = el('terr');
    terr.style.cssText = port ? 'flex:0 0 150px;order:-1;border-bottom:1px solid var(--line)' : 'flex:0 0 156px;border-top:1px solid var(--line)';
    if (port) { stage.appendChild(terr); stage.appendChild(lanesWrap); }
    else { stage.appendChild(lanesWrap); stage.appendChild(terr); }
    terrChrome(terr, 'reef floor · sessions by project');
    const T = Terrarium(terr, app.sessions, { size: 34, bubbles: 5, onHover: app.setActive, onClick: (s) => app.detail.open(s) });

    const projects = [];
    app.sessions.forEach((s) => { if (!projects.includes(s.project)) projects.push(s.project); });
    const lanes = {};
    projects.forEach((p) => {
      const lane = el('lane'); lane.dataset.project = p;
      lane.style.cssText = port ? 'flex-direction:row;align-items:stretch' : 'min-width:172px';
      const h = el('', 'h4'); h.innerHTML = '<span>' + p + '</span><span class="ct">0</span>';
      if (port) h.style.cssText = 'flex:0 0 132px;writing-mode:vertical-rl;transform:rotate(180deg);border-bottom:0;border-right:1px solid var(--line);justify-content:flex-start';
      const body = el('lbody'); if (port) body.style.cssText = 'flex-direction:row';
      lane.appendChild(h); lane.appendChild(body);
      lanesWrap.appendChild(lane); lanes[p] = { lane, body, head: h };
    });

    const nodes = {}, meta = {};
    function relayout() {
      const byP = {}; projects.forEach((p) => byP[p] = []);
      app.sessions.forEach((s) => byP[s.project].push(s));
      projects.forEach((p) => {
        const list = byP[p].sort((a, b) => weight(b) - weight(a));
        const lw = list.reduce((a, s) => a + weight(s), 0);
        const L = lanes[p];
        L.lane.style.flex = (1 + lw / 110).toFixed(2) + ' 1 0';
        L.lane.classList.toggle('hot', list.some((s) => s.state === 'awaiting' || s.state === 'error'));
        L.head.querySelector('.ct').textContent = list.length;
        list.forEach((s, i) => {
          const urgent = s.state === 'awaiting' || s.state === 'error';
          const t = urgent ? 'lg' : 'sm';
          let n = nodes[s.id];
          if (!n) { n = renderCell(s, t); nodes[s.id] = n; meta[s.id] = {}; }
          if (meta[s.id].state !== s.state) { const f = renderCell(s, t); n.className = f.className; n.innerHTML = f.innerHTML; meta[s.id] = { state: s.state }; }
          n.style.flex = port ? '0 0 230px' : '0 0 auto';
          if (port) n.style.height = '100%'; else n.style.height = urgent ? '' : '58px';
          if (n.parentElement !== L.body || [...L.body.children][i] !== n) L.body.appendChild(n);
        });
      });
    }
    relayout();
    return { terr: T, relayout, container: lanesWrap };
  }

  // ════════ FOCUS + SCHOOL (D3) ════════
  function buildFocus(stage, app, orient) {
    const port = orient === 'portrait';
    stage.style.flexDirection = port ? 'column' : 'row';
    stage.style.padding = '14px'; stage.style.gap = '14px';
    const hero = el('focus-hero');
    const rail = el('rail');
    if (port) { hero.style.cssText = 'flex:1;min-height:0'; rail.style.cssText = 'flex:0 0 40%'; }
    else { hero.style.cssText = 'flex:1;min-width:0'; rail.style.cssText = 'flex:0 0 320px'; }
    stage.appendChild(hero); stage.appendChild(rail);
    const railBg = el('rail-bg'); rail.appendChild(railBg);
    railBg.classList.add('terr');
    railBg.appendChild(el('surface')); railBg.appendChild(el('floor'));
    const T = Terrarium(railBg, app.sessions, { size: 30, bubbles: 5, tags: false, onHover: app.setActive, onClick: (s) => { app.focusId = s.id; app.view.relayout(); } });
    const railList = el('rail-list'); rail.appendChild(railList);

    function renderHero() {
      const s = app.sessions.find((x) => x.id === app.focusId) || app.sessions[0];
      const ag = AGENTS[s.agent], st = STATE[s.state];
      hero.style.setProperty('--accent', st.color);
      hero.style.borderColor = st.color;
      let action = '';
      if (s.state === 'awaiting') action =
        '<div style="margin-top:auto"><div class="dsec-l" style="font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:8px">Awaiting your decision</div>' +
        '<div style="font-size:19px;line-height:1.4;margin-bottom:16px">' + s.prompt + '</div>' +
        '<div style="display:flex;gap:10px"><button class="btn yes" data-act="approve" data-sid="' + s.id + '">Approve</button><button class="btn no" data-act="deny" data-sid="' + s.id + '">Deny</button></div></div>';
      else if (s.state === 'error') action =
        '<div style="margin-top:auto"><div class="tool mono" style="color:#ffb3b3;border-color:rgba(255,107,107,.4);margin-bottom:14px">✕ ' + s.err + '</div>' +
        '<div style="display:flex;gap:10px"><button class="btn danger" data-act="retry" data-sid="' + s.id + '">Retry</button><button class="btn no" data-act="dismiss" data-sid="' + s.id + '">Dismiss</button></div></div>';
      else action =
        '<div style="margin-top:auto;display:flex;gap:10px"><button class="btn no" data-act="interrupt" data-sid="' + s.id + '" style="flex:0 0 auto;padding:0 24px">' + (s.state === 'processing' ? 'Interrupt' : 'Resume') + '</button>' +
        '<div class="tgauge" style="margin-left:auto;align-self:center"><span class="mono" style="font-size:11px;color:var(--faint)">load</span><div class="b" style="width:90px"><i style="width:' + Math.min(96, 30 + s.heat * 3) + '%"></i></div></div></div>';
      const logLines = (s.log || []).map((l, i) => '<div class="line"><span class="t">' + String(i + 1).padStart(2, '0') + '</span>' + l + '</div>').join('');
      hero.innerHTML =
        '<div style="display:flex;align-items:center;gap:14px;padding:22px 24px 0">' +
          '<span class="ava" style="color:' + ag.color + ';width:40px;height:40px">' + window.TENC.svg(ag.creature, 40, ag.color) + '</span>' +
          '<div style="flex:1;min-width:0"><div style="font-size:23px;font-weight:600;letter-spacing:-.02em">' + ag.label + '</div>' +
          '<div class="mono" style="font-size:12.5px;color:var(--dim)">' + s.project + ' · ' + s.model + ' · ' + s.elapsed + '</div></div>' +
          '<span class="pill" style="font-size:11px;padding:5px 12px"><i></i>' + st.label + '</span></div>' +
        '<div style="padding:18px 24px 0;display:flex;flex-direction:column;gap:14px;flex:1;min-height:0;overflow:hidden">' +
          (s.tool ? '<div class="tool mono" style="font-size:13px">▸ ' + s.tool + '</div>' : '') +
          (s.think ? '<div style="font-size:15px;line-height:1.55;color:var(--text)">' + s.think + '</div>' : '') +
          '<div><div style="font-family:var(--font-mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:7px">Activity</div>' +
          '<div class="log mono" style="max-height:120px">' + (logLines || '—') + '</div></div>' +
          action +
        '</div>';
      hero.style.paddingBottom = '22px';
    }
    function renderRail() {
      const others = app.sessions.filter((x) => x.id !== app.focusId)
        .sort((a, b) => weight(b) - weight(a));
      railList.innerHTML = '';
      const ttl = el(''); ttl.className = 'mono'; ttl.style.cssText = 'font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding:2px 4px 4px;text-shadow:0 1px 4px #000';
      ttl.textContent = others.length + ' more sessions';
      railList.appendChild(ttl);
      others.forEach((s) => {
        const ag = AGENTS[s.agent], st = STATE[s.state];
        const t = el('minitile'); t.dataset.sid = s.id; t.style.setProperty('--accent', st.color);
        t.innerHTML = '<span class="ava" style="color:' + ag.color + ';width:18px;height:18px">' + window.TENC.svg(ag.creature, 18, ag.color) + '</span>' +
          '<div class="mt-nm">' + ag.short + ' · ' + s.project + '</div><div class="mt-st">' + st.label + '</div>';
        t.addEventListener('click', () => { app.focusId = s.id; relayout(); });
        railList.appendChild(t);
      });
    }
    function relayout() { renderHero(); renderRail(); app.highlight(app.active); }
    if (!app.focusId) app.focusId = app.sessions.slice().sort((a, b) => weight(b) - weight(a))[0].id;
    relayout();
    return { terr: T, relayout, container: rail, isFocus: true };
  }

  // ════════ CONTROL ROOM (D4) ════════
  function buildControl(stage, app, orient) {
    const port = orient === 'portrait';
    stage.style.flexDirection = port ? 'column' : 'row';
    const main = el(''); main.style.cssText = 'flex:1;min-width:0;position:relative;overflow:hidden';
    const sidebar = el('sidebar');
    sidebar.style.cssText = port ? 'flex:0 0 auto;border-left:0;border-top:1px solid var(--line);flex-direction:row;flex-wrap:wrap' : 'flex:0 0 280px';
    stage.appendChild(main); stage.appendChild(sidebar);

    const gridWrap = el(''); gridWrap.style.cssText = 'position:absolute;inset:0;padding:14px;display:grid;gap:10px;grid-template-columns:repeat(' + (port ? 3 : 4) + ',1fr);grid-auto-rows:minmax(116px,1fr);grid-auto-flow:dense';
    main.appendChild(gridWrap);

    // porthole spanning 2x2
    const ph = el('porthole'); ph.style.gridColumn = 'span 2'; ph.style.gridRow = 'span 2';
    gridWrap.appendChild(ph);
    terrChrome(ph, 'porthole');
    const active = app.sessions.filter((s) => s.state !== 'idle').slice(0, 6);
    const T = Terrarium(ph, active, { size: 30, bubbles: 4, onHover: app.setActive, onClick: (s) => app.detail.open(s) });

    const nodes = {}, meta = {};
    function relayout() {
      const ordered = app.sessions.slice().sort((a, b) => STATE[a.state].rank - STATE[b.state].rank || weight(b) - weight(a));
      ordered.forEach((s) => {
        const urgent = s.state === 'awaiting' || s.state === 'error';
        const t = urgent ? 'lg' : 'md';
        let n = nodes[s.id];
        if (!n) { n = renderCell(s, t); nodes[s.id] = n; meta[s.id] = {}; gridWrap.appendChild(n); }
        if (meta[s.id].state !== s.state) { const f = renderCell(s, t); n.className = f.className; n.innerHTML = f.innerHTML; meta[s.id] = { state: s.state }; }
        n.style.gridRow = urgent ? 'span 2' : '';
        gridWrap.appendChild(n); // reorder to end in sorted order
      });
      gridWrap.insertBefore(ph, gridWrap.firstChild);
      renderSidebar();
    }
    function renderSidebar() {
      const counts = { awaiting: 0, error: 0, processing: 0, idle: 0 };
      app.sessions.forEach((s) => counts[s.state]++);
      sidebar.innerHTML =
        '<div class="panel" style="' + (port ? 'flex:1' : '') + '"><h5>5-hour window</h5>' +
          '<div class="bigpct" style="color:var(--cyan)">' + RATE.fiveHour.pct + '<span style="font-size:16px;color:var(--faint)">%</span></div>' +
          '<div class="gauge" style="margin-top:8px"><div class="bar" style="width:100%"><i style="width:' + RATE.fiveHour.pct + '%"></i></div></div>' +
          '<div class="mono" style="font-size:10.5px;color:var(--faint);margin-top:7px">resets in ' + RATE.fiveHour.resetIn + '</div></div>' +
        '<div class="panel" style="' + (port ? 'flex:1' : '') + '"><h5>session mix</h5>' +
          Object.keys(counts).map((k) => '<div class="svc"><i style="background:' + STATE[k].color + '"></i>' + STATE[k].label + '<span class="d">' + counts[k] + '</span></div>').join('') +
        '</div>' +
        '<div class="panel" style="' + (port ? 'flex:1' : '') + '"><h5>services</h5>' +
          SERVICES.map((s) => '<div class="svc"><i style="background:' + (s.ok ? 'var(--ok)' : 'var(--error)') + '"></i>' + s.label + '<span class="d">' + s.detail + '</span></div>').join('') +
        '</div>';
    }
    relayout();
    return { terr: T, relayout, container: main, partialTerr: true };
  }

  const builders = { bento: buildBento, lanes: buildLanes, focus: buildFocus, control: buildControl };

  // ── mount ──
  function mount(cfg) {
    if (!Object.hasOwn(builders, cfg.variant)) throw new Error('Unknown layout variant');
    const root = typeof cfg.root === 'string' ? document.querySelector(cfg.root) : (cfg.root || document.body);
    const orient = cfg.orient || 'landscape';
    root.className = 'screen';
    root.dataset.variant = cfg.variant; root.dataset.orient = orient;

    const app = {
      sessions: JSON.parse(JSON.stringify(window.TEN.SESSIONS)),
      timers: [], active: null, focusId: null, view: null, detail: null,
    };
    const TBH = orient === 'portrait' ? 52 : 56;
    topbar(root, TBH, app);
    const stage = el('stage'); stage.style.top = TBH + 'px'; root.appendChild(stage);

    app.detail = createDetail(root, { onAct: (s, act) => handleAct(s, act) });

    app.highlight = (id) => {
      root.querySelectorAll('.cell,.minitile').forEach((n) => n.classList.toggle('linked', !!id && n.dataset.sid === id));
    };
    app.setActive = (id) => { app.active = id; if (app.view && app.view.terr) app.view.terr.setActive(id); app.highlight(id); };

    app.view = builders[cfg.variant](stage, app, orient);

    function handleAct(s, act) {
      const ns = act === 'approve' ? 'processing' : act === 'deny' ? 'idle'
        : act === 'retry' ? 'processing' : act === 'dismiss' ? 'idle'
        : act === 'interrupt' ? 'idle' : null;
      if (!ns) return;
      s.state = ns;
      if (ns === 'processing') { s.heat = 16; s.tool = s.tool || 'Bash · resuming'; s.prompt = null; s.err = null;
        s.think = s.think || 'Picking the task back up.'; }
      if (ns === 'idle') { s.tool = null; s.think = null; s.prompt = null; s.err = null; }
      if (app.view.terr) app.view.terr.updateState(s.id, ns);
      app.view.relayout();
      app.highlight(app.active);
    }

    // delegated hover + click on cells / minitiles
    root.addEventListener('pointerover', (e) => { const c = e.target.closest('.cell,.minitile'); if (c && c.dataset.sid) app.setActive(c.dataset.sid); });
    root.addEventListener('pointerout', (e) => { const c = e.target.closest('.cell,.minitile'); if (c && !c.contains(e.relatedTarget)) app.setActive(null); });
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) { const sid = btn.dataset.sid || btn.closest('[data-sid]')?.dataset.sid; const s = app.sessions.find((x) => x.id === sid); if (s) handleAct(s, btn.dataset.act); return; }
      const c = e.target.closest('.cell'); if (c && c.dataset.sid) { const s = app.sessions.find((x) => x.id === c.dataset.sid); if (s) app.detail.open(s); }
    });

    // ── demo loop: gentle, shows the grid breathe (skip on control) ──
    if (cfg.variant !== 'control' && cfg.live !== false) {
      let step = 0;
      const proc = () => app.sessions.filter((s) => s.state === 'processing');
      const idle = () => app.sessions.filter((s) => s.state === 'idle');
      app.timers.push(setInterval(() => {
        step++;
        if (step % 3 === 1) { const p = proc(); const i = idle();
          if (p.length > 2 && i.length) { const a = p[Math.floor(Math.random() * p.length)]; a.state = 'idle'; a.tool = null; a.think = null;
            const b = i[Math.floor(Math.random() * i.length)]; b.state = 'processing'; b.heat = 8 + Math.floor(Math.random() * 12);
            b.tool = 'Read · ' + b.project + '/src'; b.think = 'Resumed — scanning the working set.';
            if (app.view.terr) { app.view.terr.updateState(a.id, 'idle'); app.view.terr.updateState(b.id, 'processing'); } }
        } else { const p = proc(); if (p.length) { const a = p[Math.floor(Math.random() * p.length)]; a.heat = Math.max(2, Math.min(24, a.heat + (Math.random() < 0.5 ? -4 : 5))); } }
        app.view.relayout(); app.highlight(app.active);
      }, 4200));
    }
    // expose a demo hook for the host viewer ("Inject prompt")
    window.__d1inject = function () {
      const cands = app.sessions.filter((s) => s.state === 'processing');
      const s = cands[Math.floor(Math.random() * cands.length)] || app.sessions.find((x) => x.state === 'idle');
      if (!s) return;
      s.state = 'awaiting';
      s.prompt = 'Apply staged changes to ' + s.project + '?';
      s.tool = s.tool || 'Write file';
      s.think = 'Change is staged and ready — needs your call before it lands.';
      if (app.view.terr) app.view.terr.updateState(s.id, 'awaiting');
      app.view.relayout(); app.highlight(app.active);
    };
    return app;
  }

  return { mount };
})();
