/*
  Property Inspector wiring.

  Two jobs beyond the shared setup logic:
   1. `$UD.connect()` — the SDK handshake every plugin's inspector performs.
     Studio passes the port, the action context and the UI LANGUAGE on the
     query string, and `localizeUI()` runs on the socket opening, translating
     every [data-localize] element from <language>.json.
   2. The "Setup tutorial" button, which opens the full-page H5 tutorial in its
     own window through the SDK's `$UD.openView` — plus an "open in browser"
     link beside it, because openView's window can land behind Studio (or not
     appear at all, Ulanzi QA 1.8.1 on Windows) and a second path that cannot
     be hidden is cheaper than explaining where the first one went.

  Nothing here may be load-bearing for the tutorial itself. The panel's English
  text is in the markup and the probe runs on its own, so a Studio that never
  answers costs the reader the translation and the popup — not the
  instructions. This is deliberate: the review that asked for this panel was
  opened by a configuration section that showed nothing.
*/
(function () {
  'use strict';

  // Relative to the plugin root, per the SDK's openView contract (local html
  // path, base path only — parameters travel in the `param` argument).
  var TUTORIAL_PATH = './property-inspector/tutorial.html';
  var TUTORIAL_W = 900;
  var TUTORIAL_H = 780;

  if (typeof $UD !== 'undefined' && typeof $UD.connect === 'function') {
    try {
      $UD.connect('com.ulanzi.ulanzistudio.agentdeck.key');
    } catch (err) {
      // A failed handshake must not take the tutorial down with it.
      if (typeof Utils !== 'undefined' && Utils.warn) Utils.warn('[AgentDeck] $UD.connect failed: ' + err);
    }
  }

  function tutorialParam() {
    return (typeof $UD !== 'undefined' && $UD.language) ? { language: $UD.language } : null;
  }

  // Same page in the system browser: Studio resolves a `local` openUrl path
  // against the plugin root; window.open (no Studio) resolves against this page.
  var browserLink = document.getElementById('tutorialBrowser');
  if (browserLink) {
    browserLink.addEventListener('click', function (event) {
      event.preventDefault();
      AgentDeckSetup.openExternal(TUTORIAL_PATH, true, tutorialParam(), './tutorial.html');
    });
  }

  var tutorial = document.getElementById('tutorial');
  if (tutorial) {
    if (typeof $UD !== 'undefined' && typeof $UD.openView === 'function') {
      tutorial.addEventListener('click', function () {
        // Pass the language on so the popup opens in the same language as the
        // panel: it performs its own $UD.connect(), and connect() reads
        // `language` from the query string before falling back to the webview
        // locale.
        var param = tutorialParam();
        // Fire-and-forget: openView has no ack, and the window it opens does
        // not reliably come to the front. Where it went is stated statically in
        // the markup rather than announced here — see inspector.html.
        $UD.openView(TUTORIAL_PATH, TUTORIAL_W, TUTORIAL_H, undefined, undefined, param);
      });
    } else {
      // No host to open a window for us (a plain browser, or an older Studio).
      // A button that silently does nothing is worse than no button.
      tutorial.classList.add('hide');
    }
  }

  AgentDeckSetup.init();
})();
