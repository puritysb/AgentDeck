// D200HLayoutModel.swift — hand-maintained Swift port of the shared D200H /
// Ulanzi deck layout engine (`shared/src/d200h-layout.ts`, `buildSessionDeck`
// + its slot/command model, plus the ordering helpers from
// `shared/src/session-utils.ts` it depends on).
//
// WHY THIS EXISTS
// The Ulanzi Studio plugin (plugin-ulanzi) drives the physical D200H Deck Dock
// by calling `buildSessionDeck` from `@agentdeck/shared`. The Apple app's
// Device Preview screen used to hand-draw a schematic that did NOT match what
// the hardware shows. This file reproduces the *layout semantics* of
// `buildSessionDeck` so the preview renders the same slot grid the firmware
// actually produces: the session-centric two-level UX (list ↔ detail), the
// same session ordering + Codex folding, the same fixed utility keys
// (BACK / STOP / ESC / MORE), the same usage-tile reservation, and the OFFLINE
// AgentDeck brand-mark hero.
//
// ─────────────────────────────────────────────────────────────────────────────
// KEEP IN SYNC: this is a hand port. When `buildSessionDeck` (or the
// `sortSessions` / `foldCodexSessionsForDisplay` / `USAGE_PREFERRED_POS` logic
// it relies on) changes in the TS engine, re-port the corresponding code here.
// The visual/layout semantics must stay complete.
//
// The SYNC-HASH lines below pin the exact origin blobs this port was reconciled
// against; `scripts/check-preview-mirror-sync.mjs` verifies they match the
// current `git hash-object` of each file and fails CI when the origin drifts
// ahead of this mirror. Update them whenever you re-port.
// SYNC-HASH shared/src/d200h-layout.ts ac3803d2c1ec2da0360014c74b5ab6e85dba3907
// SYNC-HASH shared/src/session-utils.ts b08adbcca7a9fe3386a44801248b2ec06b572a0e
//
// INTENTIONALLY OMITTED (not needed by a read-only preview):
//   • Actual SVG rasterization. The TS engine emits per-key SVG strings via the
//     `svg-renderers/*` module; here each key carries a semantic `Kind` +
//     derived `label`/`subtitle` and the preview view draws its own SwiftUI
//     representation. Label-derivation rules (truncation lengths, state labels,
//     model aliasing) ARE ported so text matches.
//   • Runtime command dispatch. `DeckAction` mirrors the TS `DeckAction` union
//     so the preview can show what a key *would* do, but nothing is executed.
//   • Observed-session inertness on STOP, ESC and idle-STOP. In TS,
//     `controlMode === 'observed'` (hook-only, no PTY) nulls those actions
//     because the keystrokes have no delivery path; this mirror models the
//     PTY-session semantics for them. Action-only, so the layout is identical
//     either way. The awaiting OPTION cells are NOT in this exemption: they now
//     carry `controlMode` / `liveAnswerable` / `requestId` / `question` and
//     reproduce the three-way branch (pressable answer, Allow/Deny gate,
//     display-only) the hardware shows.
//   • Animation frames (`animFrame`/`animated`) — the preview is a static frame.
//   • resvg text sanitization (ANSI/control-char stripping) — irrelevant to a
//     native SwiftUI text surface.
//   • The focused-session `state_update` merge. In TS, a focused session's live
//     state/options/tool come from the top-level `state_update` (matched by
//     `focusedSessionId`/`sessionId`); a non-focused `SessionInfo` rarely
//     carries options. Here each `D200HSession` descriptor carries its own
//     state/options/tool/model and `D200HDeckInput.navigable` applies when the
//     session is the focused one — a faithful-enough visual reproduction.
//   • The legacy single-page `computeLayout` / `buildLayoutMap` /
//     `buildButtonCommandMap` (direct-HID) grid. That path was superseded by
//     the session-centric deck for the Ulanzi driver, which is what the D200H
//     preview must mirror.

import Foundation

// MARK: - Inputs (lightweight session descriptors)

/// A permission/multi-select option a session is awaiting on. Mirrors the
/// shared `PromptOption` (label + optional shortcut).
public struct D200HOption: Equatable, Sendable {
    public var label: String
    public var shortcut: String?
    /// Server-assigned option index — what a press sends back. Not always the
    /// array position: the PTY parser can drop entries. Mirrors PromptOption.
    public var index: Int?

    public init(label: String, shortcut: String? = nil, index: Int? = nil) {
        self.label = label
        self.shortcut = shortcut
        self.index = index
    }
}

/// Lightweight session descriptor consumed by the layout. Only the fields the
/// layout/label logic reads are modeled.
public struct D200HSession: Equatable, Sendable {
    public var id: String
    /// e.g. "claude-code", "codex-cli", "codex-app", "opencode", "openclaw".
    public var agentType: String
    /// e.g. "idle", "processing", "awaiting_permission", "awaiting_option", "awaiting_diff".
    public var state: String
    public var projectName: String
    public var modelName: String?
    public var currentTool: String?
    /// ISO-8601 start instant — used only as a stable secondary sort key.
    public var startedAt: String?
    /// Explicit deck/tab sort override (`--weight`, default 0); the PRIMARY
    /// sort key and part of the Codex fold key. Mirrors shared SessionInfo.weight.
    public var weight: Int?
    public var options: [D200HOption]
    /// "observed" for hook-only sessions — they have no PTY, so whether their
    /// options are pressable depends on `liveAnswerable`.
    public var controlMode: String?
    /// Will a press on `options` reach the agent? True when the daemon can type
    /// into the session's terminal, or is holding its AskUserQuestion open to
    /// answer with the device's choice. Absent ⇒ display-only.
    public var liveAnswerable: Bool?
    /// Held PreToolUse permission gate — renders device-native Allow/Deny.
    public var requestId: String?
    /// Awaiting prompt question, echoed back on a press.
    public var question: String?
    /// Codex display-fold bookkeeping (mutated by folding; supply nil/1 normally).
    public var groupSize: Int?
    public var foldedSessionIds: [String]?

    public init(
        id: String,
        agentType: String,
        state: String,
        projectName: String,
        modelName: String? = nil,
        currentTool: String? = nil,
        startedAt: String? = nil,
        weight: Int? = nil,
        options: [D200HOption] = [],
        controlMode: String? = nil,
        liveAnswerable: Bool? = nil,
        requestId: String? = nil,
        question: String? = nil,
        groupSize: Int? = nil,
        foldedSessionIds: [String]? = nil
    ) {
        self.id = id
        self.agentType = agentType
        self.state = state
        self.projectName = projectName
        self.modelName = modelName
        self.currentTool = currentTool
        self.startedAt = startedAt
        self.weight = weight
        self.options = options
        self.controlMode = controlMode
        self.liveAnswerable = liveAnswerable
        self.requestId = requestId
        self.question = question
        self.groupSize = groupSize
        self.foldedSessionIds = foldedSessionIds
    }
}

/// Global subscription/usage snapshot, surfaced as the pinned 5H/7D gauge tiles
/// when `D200HDeckView.showUsage` is on. Mirrors the subset of `DashState`
/// `buildUsageTiles` reads. All four windows are hide-if-absent (nil → no tile),
/// matching the TS engine since 208b1afc — an unlinked/partial usage state frees
/// the reserved keys for session tiles instead of leaving "—" ghost gauges.
/// One per-model scoped weekly cap (e.g. "Fable"). Mirrors the subset of the TS
/// `ScopedUsageLimit` that `buildUsageTiles` reads — an inactive cap renders muted.
public struct D200HScopedLimit: Equatable, Sendable {
    public var label: String
    public var percent: Double
    public var active: Bool
    public init(label: String, percent: Double, active: Bool) {
        self.label = label
        self.percent = percent
        self.active = active
    }
}

public struct D200HUsage: Equatable, Sendable {
    /// Claude 5h window used%. nil → tile omitted.
    public var fiveHourPercent: Double?
    /// Claude 7d window used%. nil → tile omitted.
    public var sevenDayPercent: Double?
    /// False → suppress the Claude tiles entirely (usage state not trusted).
    public var known: Bool
    /// Per-model scoped weekly caps, rendered as their own tiles beneath 7D.
    public var scopedLimits: [D200HScopedLimit]
    /// Optional Codex primary window used%. Labelled by `codexPrimaryWindowMinutes`,
    /// NOT by slot — Codex now sometimes reports the weekly (10080-min) window as
    /// `primary` with `secondary` null.
    public var codexPrimaryPercent: Double?
    public var codexPrimaryWindowMinutes: Int?
    public var codexPrimaryStale: Bool
    /// Optional Codex secondary window used%. Labelled by its own length.
    public var codexSecondaryPercent: Double?
    public var codexSecondaryWindowMinutes: Int?
    public var codexSecondaryStale: Bool
    /// ISO-8601 instant the Codex snapshot behind both windows was written
    /// (`CodexRateLimits.capturedAt`). Freshness is derived per build against the
    /// current clock — a still-live window whose snapshot went cold renders dimmed
    /// with a "3h ago" footnote instead of passing for a live reading.
    public var codexCapturedAt: String?

    public init(
        fiveHourPercent: Double? = nil,
        sevenDayPercent: Double? = nil,
        known: Bool = true,
        scopedLimits: [D200HScopedLimit] = [],
        codexPrimaryPercent: Double? = nil,
        codexPrimaryWindowMinutes: Int? = nil,
        codexPrimaryStale: Bool = false,
        codexSecondaryPercent: Double? = nil,
        codexSecondaryWindowMinutes: Int? = nil,
        codexSecondaryStale: Bool = false,
        codexCapturedAt: String? = nil
    ) {
        self.fiveHourPercent = fiveHourPercent
        self.sevenDayPercent = sevenDayPercent
        self.known = known
        self.scopedLimits = scopedLimits
        self.codexPrimaryPercent = codexPrimaryPercent
        self.codexPrimaryWindowMinutes = codexPrimaryWindowMinutes
        self.codexPrimaryStale = codexPrimaryStale
        self.codexSecondaryPercent = codexSecondaryPercent
        self.codexSecondaryWindowMinutes = codexSecondaryWindowMinutes
        self.codexSecondaryStale = codexSecondaryStale
        self.codexCapturedAt = codexCapturedAt
    }
}

/// The layout input bundle. `state` is the top-level daemon state (drives the
/// OFFLINE gate); `sessions` is the raw (unsorted, unfolded) list.
public struct D200HDeckInput: Sendable {
    public var state: String
    public var sessions: [D200HSession]
    public var usage: D200HUsage?
    /// When set and equal to the open session id, that session's options are
    /// treated as navigable (TUI ❯ cursor) → `select_option`; otherwise a
    /// non-navigable inline prompt → `respond`.
    public var focusedSessionId: String?
    /// Question the focused session's live options belong to, echoed on a press.
    public var question: String?
    public var navigable: Bool

    public init(
        state: String,
        sessions: [D200HSession],
        usage: D200HUsage? = nil,
        focusedSessionId: String? = nil,
        question: String? = nil,
        navigable: Bool = false
    ) {
        self.state = state
        self.sessions = sessions
        self.usage = usage
        self.focusedSessionId = focusedSessionId
        self.question = question
        self.navigable = navigable
    }
}

/// Which of the two levels to compute. Mirrors the shared `DeckView`.
public struct D200HDeckView: Sendable {
    public enum Mode: Sendable { case list, detail }
    public var mode: Mode
    public var openSessionId: String?
    public var page: Int
    /// Pin trailing/preferred keys to the global 5H/7D usage gauges.
    public var showUsage: Bool
    /// Host push-to-talk capture state (daemon `voice_state`). Drives the
    /// detail-view VOICE tile. HOLD to talk: the Ulanzi plugin runs the capture
    /// off the key's own keydown/keyUp, so the tile is cosmetic here and a tile
    /// that has not caught up cannot strand a recording.
    public var voiceState: VoiceState

    public enum VoiceState: String, Sendable { case idle, recording, transcribing, error }

    public init(
        mode: Mode = .list, openSessionId: String? = nil, page: Int = 0,
        showUsage: Bool = true, voiceState: VoiceState = .idle
    ) {
        self.mode = mode
        self.openSessionId = openSessionId
        self.page = page
        self.showUsage = showUsage
        self.voiceState = voiceState
    }
}

// MARK: - Outputs (slots + actions)

/// What pressing a key would do. Mirrors the shared `DeckAction` union. Inert
/// here — the preview shows it but never dispatches.
public enum D200HDeckAction: Equatable, Sendable {
    case none
    case open(sessionId: String)
    case back
    case page(delta: Int)
    /// A daemon command like `interrupt` / `escape` / `select_option` /
    /// `respond` / `send_prompt` / `query_usage`. `payload` carries the small
    /// scalar args the TS command object would.
    case command(type: String, payload: [String: String])
    /// Daemon down → open the companion app locally.
    case launch
}

/// Semantic kind of a rendered key. Each mirrors a shared `svg-renderers`
/// function; the preview view maps a `Kind` to its SwiftUI drawing.
public enum D200HSlotKind: Equatable, Sendable {
    /// A session tile (renderSessionSlot). `stateLabel` is RUNNING/PERMIT?/IDLE.
    case session(agentType: String, state: String, stateLabel: String)
    /// Quiet/empty tile (renderEmptySlot).
    case empty
    /// OFFLINE AgentDeck brand-mark hero (renderInfoSlot .. tone "brand").
    case offlineHero
    /// A status/info card (renderInfoSlot / renderStatusCard).
    case info(icon: String, tone: String)
    /// BACK to session list (renderBackButton).
    case back
    /// Focused-session detail header (renderDetailInfo).
    case detailInfo(agentType: String, state: String)
    /// STOP tile (renderStopButton); `active` = an interruptible run.
    case stop(active: Bool)
    /// ESC tile (renderEscButton); `active` = an awaiting prompt to cancel.
    case esc(active: Bool)
    /// A permission/option button (renderOptionButton). `index` is 0-based.
    case option(index: Int)
    /// Idle quick-action preset (actionTile): GO ON / REVIEW / COMMIT / CLEAR.
    case actionPreset
    /// Pagination MORE tile (renderNextPageButton).
    case nextPage
    /// A usage gauge tile (renderUsageGauge). `agent` = "claude"|"codex".
    case usageGauge(agent: String, window: String, percent: Double, known: Bool, stale: Bool, inactive: Bool, footnote: String?)
}

/// One key of the deck, addressed by `col`/`row` (index == row*GRID_COLS+col).
public struct D200HKeySlot: Equatable, Sendable {
    public let position: String        // "col_row"
    public let col: Int
    public let row: Int
    public let kind: D200HSlotKind
    public let label: String
    public let subtitle: String?
    public let action: D200HDeckAction
}

// MARK: - Layout engine

public enum D200HLayoutModel {
    /// 5 columns × 3 rows. Physical key index == row * GRID_COLS + col.
    public static let gridCols = 5
    public static let gridRows = 3

    /// D200H usage placement — the three bottom-row keys immediately left of the
    /// wide bottom-right clock widget, filled from the RIGHT end so a missing
    /// tile frees the leftmost key instead of holing the strip. Its length also
    /// caps usage at three keys (Claude prioritised). Mirrors the shared
    /// `USAGE_PREFERRED_POS`.
    static let usagePreferredPositions = ["0_2", "1_2", "2_2"]

    static let offlineLabel = "OFFLINE"
    static let openAgentDeckLabel = "Open AgentDeck"

    /// The full D200H 5×3 grid positions ("0_0" … "4_2"), row-major.
    public static var d200hPositions: [String] {
        var out: [String] = []
        for row in 0..<gridRows {
            for col in 0..<gridCols {
                out.append("\(col)_\(row)")
            }
        }
        return out
    }

    /// Compute the deck for `input` at `view` over `positions` (default = full
    /// 5×3 D200H grid). Faithful port of `buildSessionDeck`. Returns slots in
    /// row-major position order.
    public static func buildSessionDeck(
        _ input: D200HDeckInput,
        view: D200HDeckView,
        positions: [String]? = nil
    ) -> [D200HKeySlot] {
        let slots = sortPositions(positions ?? d200hPositions)
        if slots.isEmpty { return [] }

        // OFFLINE gate: the daemon reports `disconnected` whenever no managed /
        // focused session is active — but observed sessions still arrive via
        // sessions_list. So OFFLINE is reserved for a genuinely EMPTY list.
        if isDisconnected(input.state) && input.sessions.isEmpty {
            let hero = slots.count / 2
            return slots.enumerated().map { i, pos in
                let (col, row) = parse(pos)
                if i == hero {
                    return D200HKeySlot(
                        position: pos, col: col, row: row,
                        kind: .offlineHero, label: offlineLabel, subtitle: openAgentDeckLabel,
                        action: .launch
                    )
                }
                return D200HKeySlot(position: pos, col: col, row: row, kind: .empty, label: "", subtitle: nil, action: .launch)
            }
        }

        if view.mode == .detail, let sid = view.openSessionId {
            return buildDetail(input, view: view, openSessionId: sid, slots: slots)
        }
        return buildList(input, view: view, slots: slots)
    }

    // MARK: List view

    private static func buildList(_ input: D200HDeckInput, view: D200HDeckView, slots: [String]) -> [D200HKeySlot] {
        let sessions = sortSessions(foldCodexSessionsForDisplay(input.sessions))

        // Reserve keys for the global usage gauges (opt-in) on the bottom-row
        // strip left of the clock widget, filled from its right end; fall back to
        // trailing positions for strip keys the user didn't place. Never reserve
        // more than the strip is wide, nor more than slots.count - 1 so at least
        // one key stays for sessions. Codex tiles drop first (Claude prioritised).
        var usageHere: [String: (D200HSlotKind, String, String)] = [:]
        if view.showUsage, let usage = input.usage {
            let usageTiles = buildUsageTiles(usage)
            let maxReserve = max(0, slots.count - 1)
            let preferred = sortPositions(usagePreferredPositions.filter { slots.contains($0) })
            let reserveCount = min(usageTiles.count, usagePreferredPositions.count, maxReserve)
            let pinned = Array(preferred.suffix(reserveCount))
            let rest = slots.filter { !pinned.contains($0) }
            let fallbackCount = max(0, reserveCount - pinned.count)
            let fallback = Array(rest.suffix(fallbackCount))
            let reserved = Array(sortPositions(pinned + fallback).prefix(reserveCount))
            for (i, pos) in reserved.enumerated() where i < usageTiles.count {
                usageHere[pos] = usageTiles[i]
            }
        }

        let freeSlots = slots.filter { usageHere[$0] == nil }
        var out: [D200HKeySlot] = []

        func appendUsage() {
            for pos in slots where usageHere[pos] != nil {
                let (kind, label, subtitle) = usageHere[pos]!
                let (col, row) = parse(pos)
                out.append(D200HKeySlot(position: pos, col: col, row: row, kind: kind, label: label, subtitle: subtitle, action: .command(type: "query_usage", payload: [:])))
            }
        }

        if sessions.isEmpty {
            for (i, pos) in freeSlots.enumerated() {
                let (col, row) = parse(pos)
                if i == 0 {
                    out.append(D200HKeySlot(position: pos, col: col, row: row, kind: .info(icon: "activity", tone: "info"), label: "NO SESSION", subtitle: "waiting", action: .none))
                } else {
                    out.append(D200HKeySlot(position: pos, col: col, row: row, kind: .empty, label: "", subtitle: nil, action: .none))
                }
            }
            appendUsage()
            return sortSlots(out)
        }

        let overflow = sessions.count > freeSlots.count
        let sessionSlots = overflow ? freeSlots.count - 1 : freeSlots.count
        let pages = max(1, Int(ceil(Double(sessions.count) / Double(max(1, sessionSlots)))))
        let page = ((view.page % pages) + pages) % pages
        let pageStart = page * sessionSlots
        let pageSessions = Array(sessions[min(pageStart, sessions.count)..<min(pageStart + sessionSlots, sessions.count)])

        for (i, pos) in freeSlots.enumerated() {
            let (col, row) = parse(pos)
            if overflow && i == freeSlots.count - 1 {
                out.append(D200HKeySlot(position: pos, col: col, row: row, kind: .nextPage, label: "MORE", subtitle: "\(page + 1)/\(pages)", action: .page(delta: 1)))
                continue
            }
            if i < pageSessions.count {
                let sess = pageSessions[i]
                out.append(D200HKeySlot(
                    position: pos, col: col, row: row,
                    kind: .session(agentType: sess.agentType, state: sess.state, stateLabel: sessionStateLabel(sess.state)),
                    label: truncate(sess.projectName, 13), subtitle: sessionSubtitle(sess),
                    action: .open(sessionId: sess.id)
                ))
            } else {
                out.append(D200HKeySlot(position: pos, col: col, row: row, kind: .empty, label: "", subtitle: nil, action: .none))
            }
        }
        appendUsage()
        return sortSlots(out)
    }

    // MARK: Detail view

    private static func buildDetail(_ input: D200HDeckInput, view: D200HDeckView, openSessionId sid: String, slots: [String]) -> [D200HKeySlot] {
        let sess = input.sessions.first { $0.id == sid }
        let focused = input.focusedSessionId == sid
        let sState = (sess?.state ?? "idle").lowercased()
        let options = sess?.options ?? []
        let tool = sess?.currentTool
        // A selected session with no model is UNKNOWN (empty) — it must NOT borrow
        // a daemon-global model from another agent. TS resolves this as
        //   focused ? (state.modelName || sess?.modelName || '') : (sess?.modelName || '')
        // This mirror deliberately does not model the top-level daemon `state.modelName`
        // (see "focused-session state_update merge" in INTENTIONALLY OMITTED), so
        // `sess?.modelName` alone is the faithful reproduction: it matches the
        // non-focused branch exactly and never fabricates a borrowed model.
        let model = sess?.modelName ?? ""
        let agentType = sess?.agentType ?? "claude-code"

        var out: [D200HKeySlot] = []
        let first = slots[0]
        let last = slots[slots.count - 1]

        // BACK
        let (fc, fr) = parse(first)
        out.append(D200HKeySlot(position: first, col: fc, row: fr, kind: .back, label: "BACK", subtitle: "sessions", action: .back))

        // INFO header (slots[1], or first if only one slot)
        let infoPos = slots.count > 1 ? slots[1] : first
        let (ic, ir) = parse(infoPos)
        out.append(D200HKeySlot(
            position: infoPos, col: ic, row: ir,
            kind: .detailInfo(agentType: agentType, state: sState),
            label: truncate(sess?.projectName ?? "", 10),
            subtitle: detailInfoSubtitle(state: sState, tool: tool, model: model),
            action: .none
        ))

        // STOP / ESC on the last slot
        let (lc, lr) = parse(last)
        if isProcessing(sState) {
            out.append(D200HKeySlot(position: last, col: lc, row: lr, kind: .stop(active: true), label: "STOP", subtitle: "interrupt", action: .command(type: "interrupt", payload: [:])))
        } else if isAwaiting(sState) {
            out.append(D200HKeySlot(position: last, col: lc, row: lr, kind: .esc(active: true), label: "ESC", subtitle: "cancel", action: .command(type: "escape", payload: [:])))
        } else {
            out.append(D200HKeySlot(position: last, col: lc, row: lr, kind: .stop(active: false), label: "STOP", subtitle: "idle", action: .command(type: "interrupt", payload: [:])))
        }

        // Content slots between INFO and STOP.
        let content = slots.count >= 3 ? Array(slots[2..<(slots.count - 1)]) : []

        // Build the content cells (kind + label + subtitle + action).
        var cells: [Cell] = []

        if isAwaiting(sState) {
            let navigable = focused ? input.navigable : false
            let isObserved = sess?.controlMode == "observed"
            // A hook-observed session's options are pressable only when the
            // daemon can deliver the answer — by typing into that session's
            // terminal, or by holding its AskUserQuestion open to resolve with
            // the choice. Without the flag the cells mirror the terminal rather
            // than pretend a press will work.
            let observedAnswerable = isObserved && (sess?.liveAnswerable == true)
            if !options.isEmpty {
                for (i, opt) in options.enumerated() {
                    // The server-assigned index is what a press must send back;
                    // the array position only happens to match when nothing was
                    // dropped. Mirrors `opt.index ?? i` in the TS engine.
                    var payload = ["index": "\(opt.index ?? i)", "sessionId": sid]
                    // Echo whichever question these options belong to — the
                    // focused live state first, then the roster row.
                    let q = (focused ? (input.question ?? sess?.question) : sess?.question) ?? ""
                    if !q.isEmpty { payload["question"] = q }
                    let action: D200HDeckAction = (navigable || observedAnswerable)
                        ? .command(type: "select_option", payload: payload)
                        : .command(type: "respond", payload: ["value": respondValue(opt, index: i)])
                    cells.append(Cell(
                        kind: .option(index: i),
                        label: optionLabel(opt, index: i),
                        subtitle: nil,
                        action: (isObserved && !observedAnswerable) ? .none : action))
                }
            } else if isObserved, let gate = sess?.requestId, !gate.isEmpty {
                // Held PreToolUse gate: device-native semantics (permit/deny
                // THIS tool call), never a mirror of the TUI's option labels.
                cells.append(Cell(
                    kind: .option(index: 0), label: "ALLOW", subtitle: "this tool call",
                    action: .command(type: "permission_decision", payload: ["requestId": gate, "decision": "allow"])))
                cells.append(Cell(
                    kind: .option(index: 1), label: "DENY", subtitle: "this tool call",
                    action: .command(type: "permission_decision", payload: ["requestId": gate, "decision": "deny"])))
            } else {
                // Awaiting but no real options — don't fabricate Allow/Deny.
                cells.append(Cell(kind: .info(icon: "status", tone: "warning"), label: "PERMIT?", subtitle: "answer in terminal", action: .none))
            }
        } else if isProcessing(sState) {
            // PROCESSING is deliberately live-status only (RUNNING) — no queued
            // task tiles. The TS engine removed its COMMIT-at-completion pre-queue
            // tile so users can't mistake a future directive for the agent's
            // current work; this mirror never modeled that tile (nor the inert
            // review badge), so it is already at parity. STOP is added by the
            // shared last-slot logic above.
            cells.append(Cell(kind: .info(icon: "activity", tone: "info"), label: "RUNNING", subtitle: (tool?.isEmpty == false ? tool : "working"), action: .none))
        } else {
            // Idle quick-actions.
            let presets: [(String, String)] = [("GO ON", "continue"), ("REVIEW", "review the changes"), ("COMMIT", "commit the changes"), ("CLEAR", "/clear")]
            for (label, text) in presets {
                cells.append(Cell(kind: .actionPreset, label: label, subtitle: nil, action: .command(type: "send_prompt", payload: ["text": text])))
            }
            cells.append(voiceCell(view: view, sid: sid))
        }

        // Paginate cells into content slots; reserve last content slot for MORE.
        let cap = content.count
        let overflow = cells.count > cap
        let perPage = overflow ? cap - 1 : cap
        let pages = max(1, Int(ceil(Double(cells.count) / Double(max(1, perPage)))))
        let page = ((view.page % pages) + pages) % pages
        let pageStart = page * perPage
        let pageCells = perPage > 0 ? Array(cells[min(pageStart, cells.count)..<min(pageStart + perPage, cells.count)]) : []

        for (i, pos) in content.enumerated() {
            let (col, row) = parse(pos)
            if overflow && i == content.count - 1 {
                out.append(D200HKeySlot(position: pos, col: col, row: row, kind: .nextPage, label: "MORE", subtitle: "\(page + 1)/\(pages)", action: .page(delta: 1)))
                continue
            }
            if i < pageCells.count {
                let c = pageCells[i]
                out.append(D200HKeySlot(position: pos, col: col, row: row, kind: c.kind, label: c.label, subtitle: c.subtitle, action: c.action))
            } else {
                out.append(D200HKeySlot(position: pos, col: col, row: row, kind: .empty, label: "", subtitle: nil, action: .none))
            }
        }
        return sortSlots(out)
    }

    // MARK: Usage tiles (port of buildUsageTiles)

    /// One detail-view content cell before it is paginated into a key slot.
    private struct Cell {
        let kind: D200HSlotKind
        let label: String
        let subtitle: String?
        let action: D200HDeckAction
    }

    /// Host push-to-talk tile — mirrors `voiceTile` in d200h-layout.ts. The
    /// deck contributes only the button: the daemon owns the microphone,
    /// on-device transcription, and delivery through the same ladder the
    /// device-voice path uses. `transcribing` is deliberately inert, so a
    /// second press cannot restart capture mid-transcription.
    private static func voiceCell(view: D200HDeckView, sid: String) -> Cell {
        switch view.voiceState {
        case .recording:
            return Cell(kind: .actionPreset, label: "VOICE", subtitle: "● listening",
                        action: .command(type: "voice", payload: ["action": "stop", "sessionId": sid]))
        case .transcribing:
            return Cell(kind: .actionPreset, label: "VOICE", subtitle: "transcribing…", action: .none)
        case .error:
            return Cell(kind: .actionPreset, label: "VOICE", subtitle: "no speech",
                        action: .command(type: "voice", payload: ["action": "start", "sessionId": sid]))
        case .idle:
            return Cell(kind: .actionPreset, label: "VOICE", subtitle: "hold to talk",
                        action: .command(type: "voice", payload: ["action": "start", "sessionId": sid]))
        }
    }

    /// Every tile is hide-if-absent (TS 208b1afc): Claude 5H/7D appear only
    /// when that window's quota is actually known, so fewer (or zero) tiles are
    /// reserved and the freed slots flow to session tiles.
    private static func buildUsageTiles(_ usage: D200HUsage) -> [(D200HSlotKind, String, String)] {
        var tiles: [(D200HSlotKind, String, String)] = []
        if usage.known, let p = usage.fiveHourPercent {
            tiles.append((.usageGauge(agent: "claude", window: "5h", percent: p, known: true, stale: false, inactive: false, footnote: nil), "5H", "claude"))
        }
        if usage.known, let p = usage.sevenDayPercent {
            tiles.append((.usageGauge(agent: "claude", window: "7d", percent: p, known: true, stale: false, inactive: false, footnote: nil), "7D", "claude"))
        }
        // Per-model scoped weekly caps (e.g. "Fable") beneath 7D. An inactive cap
        // renders muted (informational cyan), never the critical ramp — mirrors the
        // TS buildUsageTiles scoped loop. The 3-slot usage region caps this at the
        // worst cap[0] in practice; extra models overflow to session tiles.
        if usage.known {
            for s in usage.scopedLimits {
                let label = s.label
                    .replacingOccurrences(of: "\n", with: " ")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .uppercased()
                let capped = String(label.prefix(6))
                tiles.append((.usageGauge(agent: "claude", window: "7d", percent: s.percent, known: true, stale: false, inactive: !s.active, footnote: nil), capped.isEmpty ? "MODEL" : capped, "claude"))
            }
        }
        // Label each present Codex window by its own length, never by slot: Codex
        // now sometimes reports the weekly (10080-min) window as `primary` with
        // `secondary` null, so a slot-based "7D = secondary" would drop the gauge.
        if let p = usage.codexPrimaryPercent {
            tiles.append((.usageGauge(agent: "codex", window: usageWindowKind(usage.codexPrimaryWindowMinutes), percent: p, known: true, stale: usage.codexPrimaryStale, inactive: false, footnote: codexFootnote(stale: usage.codexPrimaryStale, capturedAt: usage.codexCapturedAt)), usageWindowLabel(usage.codexPrimaryWindowMinutes), "codex"))
        }
        if let s = usage.codexSecondaryPercent {
            tiles.append((.usageGauge(agent: "codex", window: usageWindowKind(usage.codexSecondaryWindowMinutes), percent: s, known: true, stale: usage.codexSecondaryStale, inactive: false, footnote: codexFootnote(stale: usage.codexSecondaryStale, capturedAt: usage.codexCapturedAt)), usageWindowLabel(usage.codexSecondaryWindowMinutes), "codex"))
        }
        return tiles
    }

    /// Codex freshness footnote for a usage tile. Unlike the weight-range
    /// literals this preview deliberately re-states, freshness is delegated to
    /// the GENERATED `CodexUsageFreshness` — a threshold that differs between
    /// the preview and the device it previews would be a lie, not a port.
    static func codexFootnote(stale: Bool, capturedAt: String?, now: Date = Date()) -> String? {
        CodexUsageFreshness.footnote(stale: stale, capturedAt: capturedAt, now: now)
    }

    /// Compact window label from a length in minutes, mirroring the TS
    /// `usageWindowLabel`: whole days → "ND" (10080 → "7D"), whole hours → "NH"
    /// (300 → "5H"), else "NM". Falls back to "5H" when unknown.
    static func usageWindowLabel(_ minutes: Int?) -> String {
        guard let m = minutes, m > 0 else { return "5H" }
        if m % 1440 == 0 { return "\(m / 1440)D" }
        if m % 60 == 0 { return "\(m / 60)H" }
        return "\(m)M"
    }

    /// Gauge bucket ("5h" short vs "7d" long) from a window length, so the clip
    /// id / styling is right regardless of the primary/secondary slot.
    static func usageWindowKind(_ minutes: Int?) -> String {
        (minutes ?? 0) >= 1440 ? "7d" : "5h"
    }

    // MARK: Label derivation

    /// Session-tile state label (renderSessionSlot): RUNNING / PERMIT? / IDLE.
    static func sessionStateLabel(_ state: String) -> String {
        if isProcessing(state) { return "RUNNING" }
        if isAwaiting(state) { return "PERMIT?" }
        return "IDLE"
    }

    /// Session-tile third line: "Running task" while processing, else the aliased
    /// model string (renderSessionSlot `toolStr`).
    static func sessionSubtitle(_ sess: D200HSession) -> String? {
        if isProcessing(sess.state) { return "Running task" }
        guard let m = sess.modelName, !m.isEmpty else { return nil }
        return formatModel(m, maxLen: 15)
    }

    /// Detail header lower line (renderDetailInfo `toolDisplay`): "▶ <tool>" when
    /// a tool is active, else the human state label.
    static func detailInfoSubtitle(state: String, tool: String?, model: String) -> String? {
        if let t = tool, !t.isEmpty { return "▶ " + truncate(t, 18) }
        return stateLabelHuman(state)
    }

    /// Human state label used by renderDetailInfo / stateLabel().
    static func stateLabelHuman(_ state: String) -> String {
        switch state {
        case "idle": return "IDLE"
        case "processing": return "WORKING"
        case "awaiting_option", "awaiting_permission", "awaiting_diff": return "AWAITING"
        default: return state.uppercased()
        }
    }

    static func optionLabel(_ opt: D200HOption, index: Int) -> String {
        opt.label.isEmpty ? "Option \(index + 1)" : opt.label
    }

    /// Non-navigable inline `respond` value: option shortcut, else first char of
    /// the label lowercased, else the 1-based index (port of buildDetail).
    static func respondValue(_ opt: D200HOption, index: Int) -> String {
        if let s = opt.shortcut, !s.isEmpty { return s }
        if let first = opt.label.first { return String(first).lowercased() }
        return "\(index + 1)"
    }

    /// Compact model string (aliasModelName + truncate): claude-sonnet-4-6 →
    /// "sonnet 4.6"; date suffix dropped; others truncated to maxLen.
    static func formatModel(_ name: String, maxLen: Int) -> String {
        truncate(aliasModelName(name), maxLen)
    }

    static func aliasModelName(_ name: String) -> String {
        // ^claude-([a-z]+)-(\d+)-(\d+)(?:-\d+)?$  → "$1 $2.$3"
        let parts = name.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 3, parts[0].lowercased() == "claude" else { return name }
        let family = parts[1]
        guard family.allSatisfy({ $0.isLetter }) else { return name }
        let major = parts[2]
        guard parts.count >= 4 else { return name }
        let minor = parts[3]
        guard major.allSatisfy(\.isNumber), minor.allSatisfy(\.isNumber) else { return name }
        // A 5th component, if present, must be all digits (the dropped date suffix).
        if parts.count >= 5, !parts[4].allSatisfy(\.isNumber) { return name }
        return "\(family.lowercased()) \(major).\(minor)"
    }

    /// truncate(s, max): keep ≤max chars, else max-1 chars + ellipsis.
    static func truncate(_ s: String, _ max: Int) -> String {
        s.count <= max ? s : String(s.prefix(max - 1)) + "\u{2026}"
    }

    // MARK: Session ordering (port of session-utils.ts)

    /// agentType rank: openclaw=0, claude-code=1, codex-cli=2, codex-app=3,
    /// opencode=4, antigravity=5, others=6.
    static func agentTypeRank(_ agentType: String) -> Int {
        switch agentType {
        case "openclaw": return 0
        case "claude-code": return 1
        case "codex-cli": return 2
        case "codex-app": return 3
        case "opencode": return 4
        case "antigravity": return 5
        default: return 6
        }
    }

    /// state rank: processing=0, awaiting_*=1, idle=2, disconnected=3, else=4.
    static func stateRank(_ state: String?) -> Int {
        switch state {
        case "processing": return 0
        case "awaiting_permission", "awaiting_option", "awaiting_diff": return 1
        case "idle": return 2
        case "disconnected": return 3
        default: return 4
        }
    }

    /// numeric+case-insensitive compare (mirrors naturalLabelCompare's
    /// localeCompare(..., {numeric:true, sensitivity:'base'})).
    static func naturalLabelCompare(_ a: String?, _ b: String?) -> Int {
        let r = (a ?? "").localizedStandardCompare(b ?? "")
        return r == .orderedAscending ? -1 : (r == .orderedDescending ? 1 : 0)
    }

    /// Documented `--weight` bounds — self-contained copy (this file deliberately
    /// imports nothing from the app target). Mirrors shared SESSION_WEIGHT_MIN/
    /// MAX; drift-gated by shared/src/__tests__/session-weight-rules.test.ts.
    static let sessionWeightMin = -9999
    static let sessionWeightMax = 9999

    /// Mirrors shared `sessionWeight`: nil → 0, clamp into the documented range.
    static func sessionWeight(_ weight: Int?) -> Int {
        let w = weight ?? 0
        if w < sessionWeightMin { return sessionWeightMin }
        if w > sessionWeightMax { return sessionWeightMax }
        return w
    }

    static func sortSessions(_ sessions: [D200HSession]) -> [D200HSession] {
        sessions.enumerated().sorted { lhs, rhs in
            let a = lhs.element, b = rhs.element
            // Weight first (three-way compare, never subtraction) — mirrors
            // the shared sortSessions key order.
            let wa = sessionWeight(a.weight), wb = sessionWeight(b.weight)
            if wa != wb { return wa < wb }
            let tr = agentTypeRank(a.agentType) - agentTypeRank(b.agentType)
            if tr != 0 { return tr < 0 }
            let nc = naturalLabelCompare(a.projectName, b.projectName)
            if nc != 0 { return nc < 0 }
            if let sa = parseDate(a.startedAt), let sb = parseDate(b.startedAt), sa != sb {
                return sa < sb
            }
            let ic = naturalLabelCompare(a.id, b.id)
            if ic != 0 { return ic < 0 }
            return lhs.offset < rhs.offset   // stable
        }.map(\.element)
    }

    // MARK: Codex display folding (port of foldCodexSessionsForDisplay)

    static func foldCodexSessionsForDisplay(_ sessions: [D200HSession]) -> [D200HSession] {
        var passthrough: [D200HSession] = []
        var codexByProject: [String: [D200HSession]] = [:]
        var order: [String] = []   // preserve first-seen group order

        for session in sessions {
            let project = session.projectName.trimmingCharacters(in: .whitespaces)
            if !isCodexSession(session) || project.isEmpty {
                passthrough.append(session)
                continue
            }
            // Weight participates in the fold key (mirrors the shared fold):
            // distinct `--weight` pins on the same project must not collapse.
            let key = "\(codexDisplayKind(session)):\(project.lowercased()):\(sessionWeight(session.weight))"
            if codexByProject[key] != nil {
                codexByProject[key]!.append(session)
            } else {
                codexByProject[key] = [session]
                order.append(key)
            }
        }
        for key in order {
            passthrough.append(foldCodexProjectGroup(codexByProject[key]!))
        }
        return passthrough
    }

    static func isCodexSession(_ s: D200HSession) -> Bool {
        s.agentType == "codex-cli" || s.agentType == "codex-app" || s.id.hasPrefix("codex:")
    }

    static func codexDisplayKind(_ s: D200HSession) -> String {
        s.agentType == "codex-app" ? "codex-app" : "codex-cli"
    }

    static func foldCodexProjectGroup(_ group: [D200HSession]) -> D200HSession {
        if group.count <= 1 { return group[0] }
        let ranked = group.enumerated().sorted { lhs, rhs in
            let a = lhs.element, b = rhs.element
            let rd = stateRank(a.state) - stateRank(b.state)
            if rd != 0 { return rd < 0 }
            let aStarted = parseDate(a.startedAt)?.timeIntervalSince1970 ?? -.infinity
            let bStarted = parseDate(b.startedAt)?.timeIntervalSince1970 ?? -.infinity
            if aStarted != bStarted { return aStarted > bStarted }   // newest first
            return a.id < b.id
        }.map(\.element)

        var folded = ranked[0]
        folded.state = ranked[0].state
        folded.foldedSessionIds = group.flatMap { $0.foldedSessionIds ?? [$0.id] }
        folded.groupSize = group.reduce(0) { $0 + ($1.groupSize ?? 1) }
        let currentTool = ranked.first { stateRank($0.state) == 0 && ($0.currentTool?.trimmingCharacters(in: .whitespaces).isEmpty == false) }?.currentTool
        folded.currentTool = currentTool
        return folded
    }

    // MARK: Position helpers

    /// Row-major order ("0_0","1_0",…,"4_2").
    static func sortPositions(_ positions: [String]) -> [String] {
        positions.sorted { a, b in
            let (ac, ar) = parse(a)
            let (bc, br) = parse(b)
            return ar != br ? ar < br : ac < bc
        }
    }

    private static func sortSlots(_ slots: [D200HKeySlot]) -> [D200HKeySlot] {
        slots.sorted { a, b in a.row != b.row ? a.row < b.row : a.col < b.col }
    }

    static func parse(_ pos: String) -> (col: Int, row: Int) {
        let comps = pos.split(separator: "_").map { Int($0) ?? 0 }
        let col = comps.count > 0 ? comps[0] : 0
        let row = comps.count > 1 ? comps[1] : 0
        return (col, row)
    }

    // MARK: State predicates

    static func isDisconnected(_ state: String) -> Bool {
        let s = state.lowercased()
        return s == "disconnected"
    }

    static func isAwaiting(_ state: String) -> Bool {
        state.lowercased().hasPrefix("awaiting")
    }

    static func isProcessing(_ state: String) -> Bool {
        state.lowercased() == "processing"
    }

    // MARK: Date parsing (ISO-8601, for stable sort only)

    // ISO8601DateFormatter is not Sendable; parseDate is called rarely (sort
    // key only), so fresh formatters per call keep this concurrency-safe.
    static func parseDate(_ iso: String?) -> Date? {
        guard let iso, !iso.isEmpty else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: iso) { return d }
        return ISO8601DateFormatter().date(from: iso)
    }
}
