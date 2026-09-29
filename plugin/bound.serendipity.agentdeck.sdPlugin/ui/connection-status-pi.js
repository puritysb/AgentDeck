/* AgentDeck — connection status widget shared by every action's Property
 * Inspector (issue 307). Plain JS, no build step: this file ships verbatim in the
 * plugin bundle and is loaded by both connection-status-pi.html and
 * launcher-pi.html *after* sdpi-components.js, which is what actually opens
 * the PI <-> plugin WebSocket (via the global `connectElgatoStreamDeckSocket`
 * hook Stream Deck calls) and exposes it as `window.SDPIComponents.streamDeckClient`.
 * This script never redefines that hook — it only rides the already-open
 * connection.
 *
 * Message shapes are the mirror of plugin/src/connection-status-pi.ts:
 *   plugin -> PI:  { event: 'connectionStatus', connected, daemonStatusLabel,
 *                    daemonPath, port, lastProbeAt, lastRetryAt }
 *   PI -> plugin:  { event: 'retryNow' } | { event: 'requestConnectionStatus' }
 *
 * Timestamps ride as raw epoch-ms; relative time ("12s ago") is computed here
 * against this page's own clock so it stays live while the PI sits open,
 * rather than freezing at whatever the plugin's send-time snapshot said.
 */
(function () {
  'use strict';

  function formatAgo(epochMs) {
    if (!epochMs) return 'never';
    var deltaMs = Date.now() - epochMs;
    if (deltaMs < 1500) return 'just now';
    var s = Math.floor(deltaMs / 1000);
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    return h + 'h ago';
  }

  function render(payload) {
    var dot = document.getElementById('adConnDot');
    var line = document.getElementById('adConnLine');
    var pathEl = document.getElementById('adConnPath');
    var meta = document.getElementById('adConnMeta');
    if (!line) return;

    var connLabel = payload.connected ? 'Connected' : 'Offline';
    var portLabel = payload.port ? 'port ' + payload.port : 'no port';
    line.textContent = connLabel + ' · ' + payload.daemonStatusLabel + ' · ' + portLabel;

    if (dot) {
      var state = payload.connected ? 'ok' : (payload.daemonStatusLabel === 'Daemon not found' ? 'error' : 'warn');
      dot.setAttribute('data-state', state);
    }
    if (pathEl) pathEl.textContent = payload.daemonPath;
    if (meta) {
      var probe = 'probed ' + formatAgo(payload.lastProbeAt);
      var retry = payload.lastRetryAt ? ' · retried ' + formatAgo(payload.lastRetryAt) : '';
      meta.textContent = probe + retry;
    }
  }

  function init() {
    var sdpi = window.SDPIComponents;
    var client = sdpi && sdpi.streamDeckClient;
    if (!client) return;

    var retryBtn = document.getElementById('adConnRetry');
    var line = document.getElementById('adConnLine');

    client.sendToPropertyInspector.subscribe(function (msg) {
      var payload = msg && msg.payload;
      if (payload && payload.event === 'connectionStatus') render(payload);
    });

    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        retryBtn.disabled = true;
        if (line) line.textContent = 'Retrying…';
        client.send('sendToPlugin', { event: 'retryNow' });
        // The plugin answers with a fresh 'connectionStatus' push; this is
        // only a floor so the button can't stay stuck disabled if that
        // answer is ever lost (e.g. the PI closed mid-retry).
        setTimeout(function () { retryBtn.disabled = false; }, 1500);
      });
    }

    // Ask immediately rather than only relying on the plugin's own
    // onDidAppear push, in case this script finishes initializing after that
    // event already fired.
    client.send('sendToPlugin', { event: 'requestConnectionStatus' });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
