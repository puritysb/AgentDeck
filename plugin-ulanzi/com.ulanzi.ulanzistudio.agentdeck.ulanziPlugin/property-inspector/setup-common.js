/*
  Shared behaviour for the two setup surfaces (inspector.html panel and
  tutorial.html H5 page): the live daemon probe, the step marking it drives,
  the platform tabs, the copy buttons and the links that leave the panel.

  Exposed as one global, `AgentDeckSetup`, because a Property Inspector is
  plain <script> tags — the SDK libs are globals too ($UD, Utils), so a module
  graph would be the odd one out here.
*/
window.AgentDeckSetup = (function () {
  'use strict';

  // One line for every platform. `-y` answers npx's own "install this
  // package?" prompt; `--yes` is setup's, and it is what installs and STARTS the
  // daemon autostart (LaunchAgent / per-user Scheduled Task / systemd --user)
  // and refreshes the agents' hooks. Without it setup only offers to.
  var CMD = 'npx -y @agentdeck/setup --yes';
  // The user-facing guide. Opened through Studio ($UD.openUrl → the system
  // browser): a target=_blank link inside Studio's webview did nothing visible
  // on Windows (Ulanzi QA, 1.8.1).
  var GUIDE_URL = 'https://github.com/puritysb/AgentDeck/blob/master/marketplace/ulanzi/GETTING-STARTED.md';
  // 9120 is the daemon's port; it moves to the next free one only when 9120 is
  // taken (a stale listener, a second daemon), so probe a short range rather
  // than assuming.
  var PORTS = [9120, 9121, 9122, 9123];

  // ── strings ─────────────────────────────────────────────────────────
  // Static text is localized by the SDK ($UD.localizeUI over [data-localize]).
  // These are the ones the script writes at runtime, so they need the same
  // lookup plus an English default — $UD.t returns the KEY when no localization
  // is loaded, which would print "detailNoSession" at the user.
  var EN = {
    checking: 'Looking for the AgentDeck daemon…',
    foundApp: 'AgentDeck app is running (port {port}).',
    foundCli: 'AgentDeck daemon is running (port {port}).',
    foundOpaque: 'Something is answering on port {port} — that is the daemon.',
    notFound: 'No AgentDeck daemon answered on this computer.',
    detailNoSession: 'No agent session yet. Do step 2 and the keys fill in.',
    detailHooksMissing: 'No agent session yet, and Claude Code has no AgentDeck hooks. Install Claude Code if you have not, then run the setup command again.',
    detailSession: 'A session is live. Your keys should be showing it now.',
    detailOpaque: 'This panel cannot read the details from here, so step 2 is unchecked. The keys themselves are the real indicator.',
    detailNotFound: 'Start with step 1. If it is running and this still finds nothing, the check may be blocked here — trust the keys.',
    copy: 'Copy',
    copied: 'Copied',
  };

  function t(key) {
    var translated = (typeof $UD !== 'undefined' && typeof $UD.t === 'function') ? $UD.t(key) : key;
    // $UD.t echoes the key when the language file has no entry for it.
    return (translated && translated !== key) ? translated : (EN[key] != null ? EN[key] : key);
  }

  // ── platform tabs ───────────────────────────────────────────────────
  function detectPlatform() {
    var s = String(navigator.userAgent || navigator.platform || '');
    return /Win/i.test(s) ? 'win' : 'mac';
  }

  function bindTabs() {
    var mac = document.getElementById('tabMac');
    var win = document.getElementById('tabWin');
    if (!mac || !win) return; // the H5 page shows both platforms at once
    function select(which) {
      var isMac = which === 'mac';
      mac.setAttribute('aria-selected', String(isMac));
      win.setAttribute('aria-selected', String(!isMac));
      document.getElementById('paneMac').className = isMac ? '' : 'hide';
      document.getElementById('paneWin').className = isMac ? 'hide' : '';
    }
    mac.addEventListener('click', function () { select('mac'); });
    win.addEventListener('click', function () { select('win'); });
    select(detectPlatform());
  }

  // ── clipboard ───────────────────────────────────────────────────────
  // Each platform pane carries its own command row, so a copy button copies the
  // command shown beside it (its `.ad-cmd` row's <code>), falling back to CMD.
  function commandFor(button) {
    var row = button.parentNode;
    var code = row && row.querySelector ? row.querySelector('code') : null;
    var text = code ? String(code.textContent || '').trim() : '';
    return text || CMD;
  }

  function bindCopy() {
    var buttons = document.querySelectorAll('.ad-copy');
    for (var i = 0; i < buttons.length; i++) bindCopyButton(buttons[i]);
  }

  function bindCopyButton(button) {
    button.addEventListener('click', function () {
      var command = commandFor(button);
      var done = function () {
        button.textContent = t('copied');
        setTimeout(function () { button.textContent = t('copy'); }, 1500);
      };
      // Older webviews expose no async clipboard; a throwaway textarea plus
      // execCommand still works there, and a failure must not leave the button
      // claiming success.
      var fallback = function () {
        var area = document.createElement('textarea');
        area.value = command;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(area);
        if (ok) done();
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(command).then(done, fallback);
      } else {
        fallback();
      }
    });
  }

  // ── links that leave the panel ──────────────────────────────────────
  // Studio's webview does not hand a target=_blank link to the system browser,
  // so the click looked dead. The SDK's openUrl asks Studio to open it; with no
  // Studio socket (a plain browser) window.open is the honest fallback.
  function studioConnected() {
    return typeof $UD !== 'undefined' && typeof $UD.openUrl === 'function'
      && !!$UD.websocket && $UD.websocket.readyState === 1;
  }

  // `local` paths are relative to the plugin root (`./property-inspector/…`);
  // `pageRelative` is the same file seen from this page, for window.open.
  function openExternal(url, local, param, pageRelative) {
    if (studioConnected()) {
      $UD.openUrl(url, !!local, param || null);
      return true;
    }
    var opened = null;
    try { opened = window.open(local ? (pageRelative || url) : url, '_blank', 'noopener'); } catch (e) { opened = null; }
    return !!opened;
  }

  function bindGuide() {
    var guide = document.getElementById('guide');
    if (!guide) return;
    guide.addEventListener('click', function (event) {
      event.preventDefault();
      openExternal(GUIDE_URL, false);
    });
  }

  // ── live daemon probe ───────────────────────────────────────────────
  // Two-rung ladder, because reachability and readability are different
  // questions here.
  //
  // Readable rung: /setup-status is the daemon's secret-free status route and
  // the only one that answers with Access-Control-Allow-Origin — these pages
  // are webviews on a foreign origin, and /health could not be opened up
  // because it carries the pairing token. /health is still tried alongside it
  // for a daemon older than that route (the macOS app has always sent ACAO).
  //
  // Opaque rung: when nothing is readable, `no-cors` still distinguishes
  // "something accepted the request" from "connection refused". That proves
  // step 1 without proving step 2 — which the page then says outright rather
  // than guessing.
  function withTimeout(ms) {
    var ctrl = new AbortController();
    setTimeout(function () { ctrl.abort(); }, ms);
    return ctrl.signal;
  }

  function get(port, path) {
    return fetch('http://127.0.0.1:' + port + path, { signal: withTimeout(1200) })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))); })
      .then(function (health) { return { port: port, health: health }; });
  }

  function readable(port) {
    return Promise.any([get(port, '/setup-status'), get(port, '/health')]);
  }

  function opaque(port) {
    return fetch('http://127.0.0.1:' + port + '/setup-status', { mode: 'no-cors', signal: withTimeout(1200) })
      .then(function () { return { port: port, health: null }; });
  }

  function paint(found, message, detail) {
    var dot = document.getElementById('dot');
    var status = document.getElementById('status');
    var detailEl = document.getElementById('detail');
    if (dot) dot.className = 'ad-dot' + (found ? ' on' : '');
    if (status) status.textContent = message;
    if (detailEl) detailEl.textContent = detail || '';
  }

  function markSteps(daemonUp, sessionUp) {
    // The current step is the first one not yet satisfied — that is the whole
    // point of a live stepper over a picture of three steps.
    var states = [
      daemonUp ? 'is-done' : 'is-now',
      sessionUp ? 'is-done' : (daemonUp ? 'is-now' : 'is-todo'),
      sessionUp ? 'is-now' : 'is-todo',
    ];
    for (var i = 0; i < 3; i++) {
      var el = document.getElementById('step' + (i + 1));
      if (el) el.className = 'ad-step ' + states[i];
    }
  }

  // Step 2's verdict from a readable status payload: whether a session is
  // live, and which detail string to show.
  function sessionLive(health) {
    // `sessions` is the count the deck shows (daemons from 2026-10-19 on). The
    // state word cannot stand in for it: the daemon says `disconnected` whenever
    // no MANAGED session is focused, which is the normal case for observed
    // claude/codex sessions — so the panel said "No agent session yet" over a
    // full deck (Ulanzi QA, 1.8.1). An older daemon sends no count; only then
    // does the state word decide. `null` means the daemon could not count in
    // time, which is no information, not zero. (Never read pairingToken from
    // this payload — it must not appear in a webview, logged or rendered.)
    var count = (typeof health.sessions === 'number' && isFinite(health.sessions)) ? health.sessions : null;
    var live = count != null
      ? count > 0
      : (typeof health.state === 'string' && health.state !== 'disconnected');
    // `missing` is a definite answer (the daemon read ~/.claude/settings.json);
    // `unknown` or an absent field says nothing, so it adds no hint.
    var detail = live
      ? 'detailSession'
      : (health.claudeHooks === 'missing' ? 'detailHooksMissing' : 'detailNoSession');
    return { live: live, detail: detail };
  }

  function report(hit) {
    var health = hit.health;
    if (!health) {
      // Reachable but unreadable: step 1 is proven, step 2 is unknown — say
      // that rather than guessing either way.
      paint(true, t('foundOpaque').replace('{port}', String(hit.port)), t('detailOpaque'));
      markSteps(true, false);
      return;
    }
    var verdict = sessionLive(health);
    paint(true,
      (health.isSwift ? t('foundApp') : t('foundCli')).replace('{port}', String(hit.port)),
      t(verdict.detail));
    markSteps(true, verdict.live);
  }

  function check() {
    paint(false, t('checking'), '');
    // Promise.any resolves on the first success and rejects only when all
    // reject, which is exactly "any daemon answered".
    Promise.any(PORTS.map(readable))
      .catch(function () { return Promise.any(PORTS.map(opaque)); })
      .then(report)
      .catch(function () {
        paint(false, t('notFound'), t('detailNotFound'));
        markSteps(false, false);
      });
  }

  function init() {
    bindTabs();
    bindCopy();
    bindGuide();
    var recheck = document.getElementById('recheck');
    if (recheck) recheck.addEventListener('click', check);
    check();
  }

  return { init: init, check: check, t: t, command: CMD, guideUrl: GUIDE_URL, openExternal: openExternal, sessionLive: sessionLive };
})();
