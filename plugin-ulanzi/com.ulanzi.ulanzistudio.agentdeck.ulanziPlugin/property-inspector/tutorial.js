/*
  H5 tutorial page wiring.

  `$UD.connect()` is what loads the translations: the panel passes the language
  through openView's `param`, connect() reads it off the query string, and
  localizeUI() rewrites every [data-localize] element from <language>.json. The
  page is written to be complete in English without any of that.

  A view opened by openView closes itself — the SDK has no "close this window"
  command — so Done calls window.close().
*/
(function () {
  'use strict';

  if (typeof $UD !== 'undefined' && typeof $UD.connect === 'function') {
    try {
      $UD.connect('com.ulanzi.ulanzistudio.agentdeck.key');
    } catch (err) {
      if (typeof Utils !== 'undefined' && Utils.warn) Utils.warn('[AgentDeck] $UD.connect failed: ' + err);
    }
  }

  var done = document.getElementById('done');
  if (done) done.addEventListener('click', function () { window.close(); });

  AgentDeckSetup.init();
})();
