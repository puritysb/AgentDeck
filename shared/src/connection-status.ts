/**
 * Connection-state lexicon — canonical user-facing copy for every surface's
 * daemon-link status. SSOT for the words; per-platform mirrors must match.
 *
 * Two device classes, two vocabularies:
 *
 * 1. Self-connecting clients (Apple app, Android app, ESP32 WiFi panels —
 *    including TRMNL 7.5" — and TUI)
 *    own their link to the daemon: they discover via mDNS, connect, and
 *    auto-reconnect. They surface the *phase* they are actually in:
 *      - SEARCHING     "Searching for AgentDeck..."  (mDNS discovery, no target yet)
 *      - CONNECTING    "Connecting..."               (attempt to a known address)
 *      - RECONNECTING  "Reconnecting..."             (established link lost, auto-retry)
 *      - NO_NETWORK    "No WiFi"                     (ESP32 only — no link layer at all)
 *    Retry affordance (button): "Search Again". Empty-discovery hint:
 *    "No AgentDeck found on this network".
 *
 * 2. Daemon-rendered passive displays (Stream Deck keys/encoders, D200H,
 *    Pixoo, Timebox, iDotMatrix) are painted BY the daemon/plugin and
 *    cannot search on their own. When the link is down they show a single
 *    terminal state: "OFFLINE" (optionally with the "Open AgentDeck"
 *    call-to-action subtitle). They never claim Connecting/Reconnecting.
 *
 * Across both classes the VISUAL grammar stays stable: near-black field on
 * emissive/color displays (paper white on e-ink), muted cyan AgentDeck
 * identity/accent where color exists, one large status line, and at most one quiet
 * explanatory line. Tiny pixel displays may replace the words with the same
 * static offline badge, but must keep the field dark and non-animated. A live
 * daemon with an empty roster is a different state ("No active sessions") and
 * must not be inferred from the aggregate `state:'disconnected'` value alone.
 *
 * Mirrors (update together — grep the literal when changing copy):
 *  - Swift:  apple/AgentDeck/UI/Monitor/ConnectionOverlay.swift (ConnectionLexicon)
 *  - Kotlin: android/.../ui/common/ConnectionComponents.kt (ConnectionLexicon)
 *  - C++:    esp32/src/ui/screens/aquarium.cpp + splash.cpp + main.cpp
 */

/** Daemon-link phase of a self-connecting client surface. */
export type DaemonLinkPhase =
  | 'searching'
  | 'connecting'
  | 'reconnecting'
  | 'no_network'
  | 'connected';

/** Canonical labels for self-connecting clients (device class 1). */
export const DAEMON_LINK_LABELS: Record<DaemonLinkPhase, string> = {
  searching: 'Searching for AgentDeck...',
  connecting: 'Connecting...',
  reconnecting: 'Reconnecting...',
  no_network: 'No WiFi',
  connected: 'Connected',
};

/** Compact variants for small panels (ESP32 overlays, tiny widgets). */
export const DAEMON_LINK_LABELS_COMPACT: Record<DaemonLinkPhase, string> = {
  searching: 'Searching...',
  connecting: 'Connecting...',
  reconnecting: 'Reconnecting...',
  no_network: 'No WiFi',
  connected: 'Connected',
};

/** Retry affordance (button label) after discovery/connect failure. */
export const SEARCH_AGAIN_LABEL = 'Search Again';

/** Hint when mDNS discovery has run for a while with zero results. */
export const NOTHING_DISCOVERED_HINT = 'No AgentDeck found on this network';

/** Terminal label for daemon-rendered passive displays (device class 2). */
export const PASSIVE_OFFLINE_LABEL = 'OFFLINE';

/** Call-to-action subtitle paired with the passive OFFLINE card. */
export const OPEN_AGENTDECK_LABEL = 'Open AgentDeck';
