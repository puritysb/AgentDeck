/**
 * SessionSlotManager — central state machine for v4 dynamic session-per-button layout.
 *
 * Two views:
 * - List View: each button shows one session (OC first, then CC by startedAt)
 * - Detail View: button 1=BACK, button 2=session info, buttons 3-7=options, button 8=ESC/STOP
 */
import type { SessionInfo, StatusCardTone, StatusIconKind, CodexRateLimits } from '@agentdeck/shared';
import { State, sortSessions, assignDisplayNames, foldCodexSessionsForDisplay, aliasModelName, Brand, usageWindowKind, usageWindowLabel, UI } from '@agentdeck/shared';
import type { PromptOption } from '@agentdeck/shared';
import { dlog } from './log.js';

export type SlotView = 'list' | 'detail';

/** Per-agent water-tank usage gauge spec for the pinned bottom-row tiles. */
export interface UsageGauge {
  agent: 'claude' | 'codex';
  window: '5h' | '7d';
  label: string;
  percent: number;
  resetsAt?: string;
  known: boolean;
  color: string;
}

/** Max bottom-row keys usage may claim: Claude 5h/7d + Codex 5h/7d. */
const MAX_USAGE_RESERVE = 4;

const CLAUDE_USAGE_COLOR = Brand.claudeCode;
const CODEX_USAGE_COLOR = Brand.codex;

export interface PresetAction {
  label: string;
  iconSvg: string;        // SVG elements for the icon area (centered at 72,44 in 144x144 canvas)
  color: string;
  textColor: string;
  subtitle?: string;       // secondary text below label (e.g. model name)
  prompt?: string;         // send_prompt text
  localAction?: string;    // local action: 'open_gateway', 'switch_model'
  loading?: boolean;       // show loading indicator
}

export interface SessionSlotConfig {
  type: 'session' | 'back' | 'info' | 'status' | 'option' | 'esc' | 'stop' | 'next-page' | 'preset' | 'usage' | 'usage-page' | 'empty';
  session?: SessionInfo;
  option?: PromptOption;
  optionIndex?: number;
  label?: string;
  subtitle?: string;
  detail?: string;
  icon?: StatusIconKind;
  tone?: StatusCardTone;
  preset?: PresetAction;
  /** For list view: is this the currently "active" (connected) session? */
  /** For type 'usage': 5H/7D quota gauge tile (water-tank). */
  usageLabel?: string;
  usagePercent?: number;
  usageColor?: string;
  usageKnown?: boolean;
  usageAgent?: 'claude' | 'codex';
  usageWindow?: '5h' | '7d';
  usageResetsAt?: string;
}

export interface DeckLayout {
  columns: number;
  rows: number;
  keyCount: number;
  family?: string;
}

// ---- OpenClaw preset SVG icons (144x144 button canvas) ----

const SUMMARIZE_ICON_SVG = [
  `<rect x="40" y="14" width="64" height="56" rx="5" fill="none" stroke="#93c5fd" stroke-width="2"/>`,
  `<line x1="50" y1="28" x2="94" y2="28" stroke="#93c5fd" stroke-width="2" opacity="0.6"/>`,
  `<line x1="50" y1="40" x2="88" y2="40" stroke="#93c5fd" stroke-width="2" opacity="0.6"/>`,
  `<line x1="50" y1="52" x2="78" y2="52" stroke="#93c5fd" stroke-width="2" opacity="0.6"/>`,
  `<polyline points="82,50 87,56 96,44" fill="none" stroke="#93c5fd" stroke-width="2.5" stroke-linecap="round"/>`,
].join('');

// MODEL icon: model name large + swap indicator. loading=true shows spinner animation.
function buildModelIcon(_modelName?: string, loading?: boolean): string {
  if (loading) {
    return [
      `<path d="M92 40a20 20 0 1 0 2 24" fill="none" stroke="#e9d5ff" stroke-width="4" stroke-linecap="round"/>`,
      `<path d="M92 25v15H77" fill="none" stroke="#e9d5ff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
      `<path d="M72 38l22 13v26L72 90 50 77V51z" fill="#a78bfa" opacity="0.16" stroke="#e9d5ff" stroke-width="2"/>`,
    ].join('');
  }
  return [
    `<path d="M72 22l30 17v34L72 90 42 73V39z" fill="#a78bfa" opacity="0.16" stroke="#e9d5ff" stroke-width="2.5"/>`,
    `<path d="M42 39l30 17 30-17M72 56v34" fill="none" stroke="#e9d5ff" stroke-width="2" opacity="0.7"/>`,
    `<path d="M52 23h-8v8M100 23h-8v8M52 95h-8v-8M100 95h-8v-8" fill="none" stroke="#e9d5ff" stroke-width="2.4" stroke-linecap="round" opacity="0.55"/>`,
  ].join('');
}

function truncateStr(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '\u2026';
}

import { OPENCLAW_LOGO_PATHS } from './renderers/agent-logos.js';

const GATEWAY_ICON_SVG = [
  `<rect x="30" y="16" width="84" height="64" rx="6" fill="none" stroke="#94a3b8" stroke-width="2"/>`,
  `<line x1="30" y1="30" x2="114" y2="30" stroke="#94a3b8" stroke-width="1.5"/>`,
  `<circle cx="40" cy="23" r="2.5" fill="#ef4444"/>`,
  `<circle cx="48" cy="23" r="2.5" fill="#fbbf24"/>`,
  `<circle cx="56" cy="23" r="2.5" fill="#4ade80"/>`,
  `<g transform="translate(52,34) scale(1.65)" fill="#ff4d4d" fill-rule="evenodd" clip-rule="evenodd">`,
  `<defs><linearGradient id="oc-btn-g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs>`,
  ...OPENCLAW_LOGO_PATHS.map((path) => `<path d="${path}" fill="url(#oc-btn-g)"/>`),
  `</g>`,
].join('');

// OpenClaw preset definitions (iconSvg + action)
// MODEL iconSvg is built dynamically with current model name
const OC_PRESET_DEFS: Array<Omit<PresetAction, 'iconSvg'> & { iconSvg?: string; dynamicIcon?: 'model' }> = [
  { label: 'STATUS', iconSvg: SUMMARIZE_ICON_SVG, color: '#1a1a3e', textColor: '#93c5fd', prompt: 'status' },
  { label: 'MODEL', dynamicIcon: 'model', color: '#2d1f3d', textColor: '#e9d5ff', localAction: 'switch_model' },
  { label: 'GATEWAY', iconSvg: GATEWAY_ICON_SVG, color: '#1a0f2e', textColor: '#c084fc', localAction: 'open_gateway' },
];

// Claude Code quick actions (IDLE detail view)
const GO_ON_ICON_SVG = `<polygon points="60,20 100,44 60,68" fill="#22c55e" opacity="0.8"/>`;
const REVIEW_ICON_SVG = `<rect x="42" y="18" width="60" height="48" rx="4" fill="none" stroke="#93c5fd" stroke-width="2"/><path d="M52,34 h40 M52,46 h32 M52,58 h24" stroke="#93c5fd" stroke-width="1.5" opacity="0.6"/>`;
const COMMIT_ICON_SVG = `<circle cx="72" cy="40" r="20" fill="none" stroke="#22c55e" stroke-width="2"/><polyline points="62,40 70,48 84,32" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round"/>`;
const CLEAR_ICON_SVG = `<line x1="52" y1="24" x2="92" y2="64" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round"/><line x1="92" y1="24" x2="52" y2="64" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round"/>`;

// Suggested-prompt quick-send (relocated from the SD+ E2 idle encoder rotate/press
// to a keypad button). A spark/lightbulb glyph; amber to read as a hint, not a
// command. The full suggestion rides `prompt`; the subtitle previews it.
const SUGGEST_ICON_SVG = [
  `<path d="M72 18a24 24 0 0 0-14 43c3 2 4 5 4 8v3h20v-3c0-3 1-6 4-8a24 24 0 0 0-14-43z" fill="#f59e0b" opacity="0.18" stroke="#fbbf24" stroke-width="2.5"/>`,
  `<line x1="63" y1="78" x2="81" y2="78" stroke="#fbbf24" stroke-width="2.5" stroke-linecap="round"/>`,
  `<line x1="66" y1="86" x2="78" y2="86" stroke="#fbbf24" stroke-width="2.5" stroke-linecap="round"/>`,
].join('');

/** Build the suggested-prompt quick-send keypad preset (SD+ idle detail view). */
function buildSuggestPreset(prompt: string): PresetAction {
  return {
    label: 'SUGGESTED',
    iconSvg: SUGGEST_ICON_SVG,
    color: '#3a2a0f',
    textColor: '#fbbf24',
    subtitle: truncateStr(prompt, 18),
    prompt,
  };
}

// REVIEW routes to the independent on-demand eval (review_run — daemon-side
// judge, no agent control), so it is uniform across every session type.
const CC_PRESET_DEFS: Array<Omit<PresetAction, 'iconSvg'> & { iconSvg?: string; dynamicIcon?: 'model' }> = [
  { label: 'GO ON', iconSvg: GO_ON_ICON_SVG, color: '#1e3a2f', textColor: '#22c55e', prompt: 'go on' },
  { label: 'REVIEW', iconSvg: REVIEW_ICON_SVG, color: '#1e293b', textColor: '#93c5fd', localAction: 'review_run' },
  { label: 'COMMIT', iconSvg: COMMIT_ICON_SVG, color: '#1e293b', textColor: '#22c55e', prompt: '/commit' },
  { label: 'CLEAR', iconSvg: CLEAR_ICON_SVG, color: '#1e293b', textColor: '#94a3b8', prompt: '/clear' },
];

// Host push-to-talk. The deck contributes the button; the daemon records on
// the host mic, transcribes on-device and routes the text to this session —
// same pipeline as the ESP32 boards' PTT keys, minus the board.
export type SlotVoiceState = 'idle' | 'recording' | 'transcribing' | 'error';

function voiceMicIcon(stroke: string, filled: boolean): string {
  return [
    `<rect x="62" y="16" width="20" height="34" rx="10" fill="${filled ? stroke : 'none'}" ${filled ? 'opacity="0.9" ' : ''}stroke="${stroke}" stroke-width="2.5"/>`,
    `<path d="M52 42a20 20 0 0 0 40 0" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round"/>`,
    `<line x1="72" y1="62" x2="72" y2="72" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round"/>`,
    `<line x1="60" y1="72" x2="84" y2="72" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round"/>`,
  ].join('');
}

/** Build the VOICE hold-to-talk preset styled for the current capture state. */
function buildVoicePreset(state: SlotVoiceState): PresetAction {
  switch (state) {
    case 'recording':
      return {
        label: 'VOICE', iconSvg: voiceMicIcon(UI.error, true),
        color: UI.popupBgDark, textColor: UI.error, subtitle: '● listening',
        localAction: 'voice_ptt',
      };
    case 'transcribing':
      return {
        label: 'VOICE', iconSvg: voiceMicIcon(UI.cyan, false),
        color: UI.popupBgDark, textColor: UI.cyan, subtitle: 'transcribing…',
        localAction: 'voice_ptt',
      };
    case 'error':
      return {
        label: 'VOICE', iconSvg: voiceMicIcon(UI.error, false),
        color: UI.popupBgDark, textColor: UI.error, subtitle: 'no speech',
        localAction: 'voice_ptt',
      };
    default:
      return {
        label: 'VOICE', iconSvg: voiceMicIcon(UI.cyan, false),
        color: UI.popupBgDark, textColor: UI.cyan, subtitle: 'hold to talk',
        localAction: 'voice_ptt',
      };
  }
}

// OpenCode observed idle: the observer plugin injects immediately via the
// in-process SDK — same semantics as managed idle presets.
const OC_OBSERVED_INJECT_PRESETS: Array<Omit<PresetAction, 'iconSvg'> & { iconSvg?: string }> = [
  { label: 'GO ON', iconSvg: GO_ON_ICON_SVG, color: '#1e3a2f', textColor: '#22c55e', prompt: 'continue', subtitle: 'inject now' },
  { label: 'COMMIT', iconSvg: COMMIT_ICON_SVG, color: '#1e293b', textColor: '#22c55e', prompt: 'commit the changes', subtitle: 'inject now' },
];

const DEFAULT_LAYOUT: DeckLayout = { columns: 4, rows: 2, keyCount: 8, family: 'streamdeckplus' };
// 36 covers the Stream Deck + XL's full 9×4 keypad (usage rides its dials, so no
// key is reserved). Smaller decks paginate below this cap unchanged.
const MAX_SESSIONS = 36;

/**
 * Encoder-LCD ("Plus") family test. Both the Stream Deck+ (4 dials) and the
 * Stream Deck + XL (6 dials) carry usage on their dials and host the
 * suggested-prompt quick-send, so the keypad-usage / suggest gates key off this
 * rather than a bare `=== 'streamdeckplus'`. The plain XL has no encoders and is
 * deliberately excluded (usage stays on its last keypad keys).
 */
export function isPlusFamily(family: string | undefined): boolean {
  return family === 'streamdeckplus' || family === 'streamdeckplusxl';
}

function normalizeLayout(layout?: Partial<DeckLayout>): DeckLayout {
  const columns = Math.max(1, Math.floor(layout?.columns ?? DEFAULT_LAYOUT.columns));
  const rows = Math.max(1, Math.floor(layout?.rows ?? DEFAULT_LAYOUT.rows));
  const keyCount = Math.max(1, Math.floor(layout?.keyCount ?? columns * rows));
  return { columns, rows, keyCount, family: layout?.family ?? DEFAULT_LAYOUT.family };
}

export class SessionSlotManager {
  private static readonly MODEL_SWITCH_TIMEOUT_MS = 12000;

  private _view: SlotView = 'list';
  private _currentPage = 0;
  private _detailPage = 0;
  private _sessions: SessionInfo[] = [];
  private _displayNames = new Map<string, string>();
  private _focusedSessionId: string | null = null;

  // Global subscription quota (rides usage_update), pinned to the list view's
  // last keys on decks without an encoder LCD. Defaults read as "unknown" so an
  // absent agent reserves no keys (hide-if-absent). Claude rides the top-level
  // 5h/7d fields; Codex rides codexRateLimits (primary≈5h, secondary≈7d).
  private _fiveHourPercent = 0;
  private _sevenDayPercent = 0;
  private _fiveHourResetsAt: string | undefined;
  private _sevenDayResetsAt: string | undefined;
  private _fiveHourKnown = false;
  private _sevenDayKnown = false;
  private _codexPrimary: { percent: number; resetsAt?: string; windowMinutes: number } | null = null;
  private _codexSecondary: { percent: number; resetsAt?: string; windowMinutes: number } | null = null;
  // Page cursor for the (Phase-1-dormant) gauge paging when present gauges
  // exceed MAX_USAGE_RESERVE. Never advances with ≤4 gauges.
  private _usagePage = 0;

  // Detail view state (from the focused session's bridge)
  private _detailState = State.DISCONNECTED;
  private _detailOptions: PromptOption[] = [];
  private _detailTool: string | undefined;
  private _detailToolInput: string | undefined;
  private _detailQuestion: string | undefined;
  private _detailModelName: string | undefined;
  private _detailEffortLevel: string | undefined;
  private _detailMode: string | undefined;
  private _detailSuggestedPrompt: string | undefined;
  /** Host push-to-talk capture state, mirrored from daemon voice_state events. */
  private _voiceState: SlotVoiceState = 'idle';
  private _modelSwitching = false;
  private _prevModelName: string | undefined;
  private _modelSwitchStartedAt = 0;

  get view(): SlotView { return this._view; }
  get currentPage(): number { return this._currentPage; }
  get focusedSessionId(): string | null { return this._focusedSessionId; }
  get sessions(): SessionInfo[] { return this._sessions; }

  /** Get display name for a session (with #N suffix if needed). Never mutates the original. */
  displayNameFor(session: SessionInfo): string {
    return this._displayNames.get(session.id) ?? session.projectName;
  }
  get detailState(): State { return this._detailState; }
  get detailOptions(): PromptOption[] { return this._detailOptions; }
  get detailModelName(): string | undefined { return this._detailModelName; }
  get detailEffortLevel(): string | undefined { return this._detailEffortLevel; }
  get modelSwitching(): boolean { return this._modelSwitching; }

  startModelSwitch(): void {
    this._prevModelName = this._detailModelName;
    this._modelSwitching = true;
    this._modelSwitchStartedAt = Date.now();
  }

  /** Called when model name changes after switch — auto-detects completion */
  private checkModelSwitchDone(): void {
    if (!this._modelSwitching) return;
    const timedOut = Date.now() - this._modelSwitchStartedAt >= SessionSlotManager.MODEL_SWITCH_TIMEOUT_MS;
    const enteredInteractiveModelPicker =
      this._detailState === State.AWAITING_OPTION
      || this._detailState === State.AWAITING_PERMISSION
      || this._detailState === State.AWAITING_DIFF;
    const leftIdle = this._detailState !== State.IDLE;

    if (timedOut || enteredInteractiveModelPicker || leftIdle) {
      this._modelSwitching = false;
      this._prevModelName = undefined;
      this._modelSwitchStartedAt = 0;
      return;
    }
    if (this._modelSwitching && this._detailModelName && this._detailModelName !== this._prevModelName) {
      this._modelSwitching = false;
      this._prevModelName = undefined;
      this._modelSwitchStartedAt = 0;
    }
  }

  // ---- Session list updates ----

  updateSessions(sessions: SessionInfo[]): void {
    // Build ordered list: sorted by agentType (openclaw→claude→codex→opencode) then name→startedAt
    const alive = foldCodexSessionsForDisplay(
      sessions.filter(s => (s.agentType as string) !== 'daemon' && s.alive),
    );

    // OpenClaw virtual sessions are injected by the daemon only after
    // Gateway authentication succeeds. Reachability alone stays a topology
    // signal so the plugin does not create an actionable OpenClaw slot for an
    // unapproved or token-mismatched Gateway.

    // Canonical stable sort: agentType rank → projectName → startedAt → id
    this._sessions = sortSessions(alive).slice(0, MAX_SESSIONS);

    // Reconcile focus / active ids against the folded session set. When Codex
    // folds an old thread into a newer representative, the previously focused
    // id disappears from the top-level list — re-point at the successor row
    // (so detail view stays on the project), or exit detail if the project is
    // gone entirely.
    this.reconcileFoldedIds();

    // Assign #N display names for duplicate (projectName, agentType) pairs — no mutation
    this._displayNames = new Map();
    const displayed = assignDisplayNames(this._sessions);
    for (const d of displayed) {
      this._displayNames.set(d.session.id, d.displayName);
    }

    // Clamp page
    const totalPages = this.totalPages();
    if (this._currentPage >= totalPages) {
      this._currentPage = Math.max(0, totalPages - 1);
    }

    dlog('SlotMgr', `updateSessions: ${this._sessions.length} sessions, page=${this._currentPage}, view=${this._view}`);
  }



  /** Feed the latest Claude 5H/7D + Codex quota for the pinned list-view tiles. */
  updateUsage(usage: {
    fiveHourPercent?: number;
    fiveHourResetsAt?: string;
    sevenDayPercent?: number;
    sevenDayResetsAt?: string;
    usageStale?: boolean;
    codexRateLimits?: CodexRateLimits;
  }): void {
    const stale = usage.usageStale === true;
    this._fiveHourPercent = usage.fiveHourPercent ?? 0;
    this._sevenDayPercent = usage.sevenDayPercent ?? 0;
    this._fiveHourResetsAt = usage.fiveHourResetsAt;
    this._sevenDayResetsAt = usage.sevenDayResetsAt;
    // Distinguish "0% used" from "no data" so we hide-if-absent (reserve no key)
    // instead of pinning a confident empty gauge when the hub has no OAuth
    // source or went stale.
    this._fiveHourKnown = !stale && usage.fiveHourPercent != null;
    this._sevenDayKnown = !stale && usage.sevenDayPercent != null;

    const cx = usage.codexRateLimits;
    this._codexPrimary = cx?.primary
      ? { percent: cx.primary.usedPercent, resetsAt: cx.primary.resetsAt, windowMinutes: cx.primary.windowMinutes }
      : null;
    this._codexSecondary = cx?.secondary
      ? { percent: cx.secondary.usedPercent, resetsAt: cx.secondary.resetsAt, windowMinutes: cx.secondary.windowMinutes }
      : null;
  }

  /**
   * Present water-tank gauges in left-to-right (then bottom-row) display order:
   * Claude 5h, Claude 7d, Codex 5h, Codex 7d. Hide-if-absent — an agent with no
   * live quota contributes nothing, so it claims no keys.
   */
  private usageGauges(): UsageGauge[] {
    const gauges: UsageGauge[] = [];
    if (this._fiveHourKnown || this._sevenDayKnown) {
      gauges.push({
        agent: 'claude', window: '5h', label: '5H',
        percent: this._fiveHourPercent, resetsAt: this._fiveHourResetsAt,
        known: this._fiveHourKnown, color: CLAUDE_USAGE_COLOR,
      });
      gauges.push({
        agent: 'claude', window: '7d', label: '7D',
        percent: this._sevenDayPercent, resetsAt: this._sevenDayResetsAt,
        known: this._sevenDayKnown, color: CLAUDE_USAGE_COLOR,
      });
    }
    // Codex windows carry the same short "5H"/"7D" labels as Claude — the agent
    // is conveyed by the gauge's brand dot, not a "CX " prefix. Label each
    // present window by its own length (windowMinutes), never by slot: Codex now
    // sometimes reports the weekly (10080-min) window as `primary` with
    // `secondary` null, so a slot-based "7D = secondary" would drop the gauge.
    for (const w of [this._codexPrimary, this._codexSecondary]) {
      if (w == null) continue;
      gauges.push({
        agent: 'codex', window: usageWindowKind(w.windowMinutes), label: usageWindowLabel(w.windowMinutes) || '5H',
        percent: w.percent, resetsAt: w.resetsAt,
        known: true, color: CODEX_USAGE_COLOR,
      });
    }
    return gauges;
  }

  /**
   * How many bottom keys the list view pins to usage gauges. Classic Stream
   * Deck (15 keys) and XL (32) carry usage here (no encoder LCD); the Plus
   * family (Stream Deck+ 4-dial and Stream Deck + XL 6-dial, see isPlusFamily)
   * shows usage on its dials instead, and the Mini (<6 keys) is too small to
   * spare any. Capped at MAX_USAGE_RESERVE.
   */
  private usageReserve(layout: DeckLayout): number {
    if (isPlusFamily(layout.family) || layout.keyCount < 6) return 0;
    return Math.min(this.usageGauges().length, MAX_USAGE_RESERVE);
  }

  /** Cycle the gauge page (only meaningful when gauges overflow MAX_USAGE_RESERVE). */
  cycleUsagePage(): void {
    const gauges = this.usageGauges();
    if (gauges.length <= MAX_USAGE_RESERVE) { this._usagePage = 0; return; }
    const perPage = MAX_USAGE_RESERVE - 1;
    const pages = Math.max(1, Math.ceil(gauges.length / perPage));
    this._usagePage = (this._usagePage + 1) % pages;
  }

  // ---- Detail view state updates ----

  /** Mirror the daemon's host push-to-talk state. Returns true when it changed
   *  (caller decides whether a repaint is due). */
  updateVoiceState(state: SlotVoiceState): boolean {
    if (this._voiceState === state) return false;
    this._voiceState = state;
    return true;
  }

  updateDetailState(state: State, options: PromptOption[], tool?: string, toolInput?: string, question?: string, modelName?: string, mode?: string, effortLevel?: string, suggestedPrompt?: string): void {
    this._detailState = state;
    this._detailOptions = options;
    this._detailTool = tool;
    this._detailToolInput = toolInput;
    this._detailQuestion = question;
    this._detailModelName = modelName;
    this._detailEffortLevel = effortLevel;
    this._detailMode = mode;
    // Suggested prompt only applies in IDLE; clear it otherwise so a stale
    // suggestion can't leak a quick-send button into a busy/awaiting view.
    this._detailSuggestedPrompt = state === State.IDLE ? (suggestedPrompt || undefined) : undefined;
    if (!this.isAwaitingDetailState()) {
      this._detailPage = 0;
    } else {
      this._detailPage = Math.min(this._detailPage, Math.max(0, this.detailOptionPages() - 1));
    }
    this.checkModelSwitchDone();
  }

  // ---- View transitions ----

  enterDetailView(sessionId: string): void {
    this._focusedSessionId = sessionId;
    this._view = 'detail';
    this._detailPage = 0;
    dlog('SlotMgr', `enterDetailView: ${sessionId}`);
  }

  exitDetailView(): void {
    this._focusedSessionId = null;
    this._view = 'list';
    this._detailPage = 0;
    this._modelSwitching = false;
    this._prevModelName = undefined;
    this._modelSwitchStartedAt = 0;
    dlog('SlotMgr', `exitDetailView → list`);
  }

  nextPage(layout?: DeckLayout): void {
    const deck = normalizeLayout(layout);
    if (this._view === 'detail') {
      const total = this.detailOptionPages(deck);
      if (total <= 1) return;
      this._detailPage = (this._detailPage + 1) % total;
      dlog('SlotMgr', `nextDetailPage: ${this._detailPage + 1}/${total}`);
      return;
    }
    const total = this.totalPages(deck);
    if (total <= 1) return;
    this._currentPage = (this._currentPage + 1) % total;
    dlog('SlotMgr', `nextPage: ${this._currentPage}/${total}`);
  }

  // ---- Slot configuration ----

  getSlotConfig(slot: number, layout?: DeckLayout): SessionSlotConfig {
    const deck = normalizeLayout(layout);
    if (slot < 0 || slot >= deck.keyCount) return { type: 'empty' };

    if (this._view === 'detail') {
      return this.getDetailSlotConfig(slot, deck);
    }
    return this.getListSlotConfig(slot, deck);
  }

  /** Handle button press. Returns action to take. */
  handleSlotPress(slot: number, layout?: DeckLayout): {
    action: 'enter-detail' | 'exit-detail' | 'select-option' | 'stop' | 'esc' | 'next-page' | 'send-prompt' | 'open-gateway' | 'switch-model' | 'review-run' | 'refresh-usage' | 'cycle-usage-page' | 'voice-ptt-begin' | 'voice-ptt-end' | 'voice-ptt-cancel' | 'none';
    sessionId?: string;
    sessionPort?: number;
    optionIndex?: number;
    optionValue?: string;
    promptText?: string;
  } {
    const deck = normalizeLayout(layout);
    const config = this.getSlotConfig(slot, deck);

    switch (config.type) {
      case 'session':
        if (config.session) {
          return {
            action: 'enter-detail',
            sessionId: config.session.id,
            sessionPort: config.session.port,
          };
        }
        return { action: 'none' };

      case 'back':
        return { action: 'exit-detail' };

      case 'option':
        if (config.option && config.optionIndex != null) {
          return {
            action: 'select-option',
            optionIndex: config.optionIndex,
            optionValue: config.option.label,
          };
        }
        return { action: 'none' };

      case 'preset':
        if (config.preset?.localAction === 'open_gateway') {
          return { action: 'open-gateway' };
        }
        if (config.preset?.localAction === 'switch_model') {
          return { action: 'switch-model' };
        }
        if (config.preset?.localAction === 'review_run') {
          return { action: 'review-run' };
        }
        // Hold-to-talk: the key-down begins capture; the action class pairs it
        // with a key-up that ends (or cancels) it.
        if (config.preset?.localAction === 'voice_ptt') {
          return { action: 'voice-ptt-begin', sessionId: this._focusedSessionId ?? undefined };
        }
        if (config.preset?.prompt) {
          return { action: 'send-prompt', promptText: config.preset.prompt };
        }
        return { action: 'none' };

      case 'esc':
        return { action: 'esc' };

      case 'stop':
        return { action: 'stop' };

      case 'next-page':
        return { action: 'next-page' };

      case 'usage':
        return { action: 'refresh-usage' };

      case 'usage-page':
        return { action: 'cycle-usage-page' };

      default:
        return { action: 'none' };
    }
  }

  getFocusedSession(): SessionInfo | undefined {
    if (!this._focusedSessionId) return undefined;
    return this._sessions.find(s => s.id === this._focusedSessionId);
  }

  /** Re-point focused / active ids when the previously held id has been folded
   *  into a representative row. If no successor exists and we were in detail
   *  view, drop back to list so we don't render against `undefined`.
   */
  private reconcileFoldedIds(): void {
    const findSuccessor = (id: string): string | null => {
      if (this._sessions.find(s => s.id === id)) return id;
      const successor = this._sessions.find(s => s.foldedSessionIds?.includes(id));
      return successor ? successor.id : null;
    };

    if (this._focusedSessionId) {
      const next = findSuccessor(this._focusedSessionId);
      if (next === null) {
        if (this._view === 'detail') this.exitDetailView();
        else this._focusedSessionId = null;
      } else if (next !== this._focusedSessionId) {
        this._focusedSessionId = next;
      }
    }
  }

  // ---- Internal helpers ----

  /** Session-fillable keys per page = grid minus pinned usage tiles, minus NEXT→ when paginating. */
  private listSessionsPerPage(layout: DeckLayout, totalSessions: number): number {
    const cap = Math.max(1, layout.keyCount - this.usageReserve(layout));
    return totalSessions > cap ? Math.max(1, cap - 1) : cap;
  }

  private totalPages(layout: DeckLayout = DEFAULT_LAYOUT): number {
    const count = this._sessions.length;
    const cap = Math.max(1, layout.keyCount - this.usageReserve(layout));
    if (count <= cap) return 1;
    return Math.ceil(count / this.listSessionsPerPage(layout, count));
  }

  private needsPagination(layout: DeckLayout): boolean {
    return this._sessions.length > Math.max(1, layout.keyCount - this.usageReserve(layout));
  }

  private isAwaitingDetailState(): boolean {
    return this._detailState === State.AWAITING_OPTION
      || this._detailState === State.AWAITING_PERMISSION
      || this._detailState === State.AWAITING_DIFF;
  }

  private detailOptionPages(layout: DeckLayout = DEFAULT_LAYOUT): number {
    if (!this.isAwaitingDetailState()) return 1;
    const capacity = Math.max(1, this.detailContentSlots(layout, true).length);
    return Math.max(1, Math.ceil(this._detailOptions.length / capacity));
  }

  private getListSlotConfig(slot: number, layout: DeckLayout): SessionSlotConfig {
    const usageReserve = this.usageReserve(layout);

    // Pin water-tank quota gauges to the last keys (every page; usage is global).
    // The reserved block is contiguous at the bottom-right; present gauges fill
    // it left→right in display order (Claude 5h/7d, then Codex 5h/7d).
    if (usageReserve > 0) {
      const blockStart = layout.keyCount - usageReserve;
      if (slot >= blockStart) {
        const gauges = this.usageGauges();
        const idx = slot - blockStart;
        const overflow = gauges.length > usageReserve;
        // Dormant in Phase 1 (≤4 gauges never overflow 4 reserved keys): when a
        // future 5th gauge appears, the last reserved key becomes a page toggle.
        if (overflow && idx === usageReserve - 1) {
          const perPage = usageReserve - 1;
          const pages = Math.max(1, Math.ceil(gauges.length / perPage));
          return { type: 'usage-page', label: `${(this._usagePage % pages) + 1}/${pages}` };
        }
        const perPage = overflow ? usageReserve - 1 : usageReserve;
        const g = gauges[this._usagePage * perPage + idx];
        if (g) {
          return {
            type: 'usage',
            usageLabel: g.label,
            usagePercent: g.percent,
            usageColor: g.color,
            usageKnown: g.known,
            usageAgent: g.agent,
            usageWindow: g.window,
            usageResetsAt: g.resetsAt,
          };
        }
        return { type: 'empty' };
      }
    }

    if (this._sessions.length === 0) {
      if (slot === 0) {
        return {
          type: 'status',
          label: 'HUB READY',
          subtitle: 'CONNECTED',
          icon: 'hub',
          tone: 'ready',
        };
      }
      if (slot === 1) {
        return {
          type: 'status',
          label: 'NO SESSION',
          subtitle: 'WAITING',
          icon: 'no-session',
          tone: 'idle',
        };
      }
      if (slot === 2) {
        return {
          type: 'status',
          label: 'AgentDeck',
          subtitle: 'IDLE',
          icon: 'agentdeck',
          tone: 'agent',
        };
      }
      return { type: 'empty' };
    }

    const needsPage = this.needsPagination(layout);
    const sessionsOnPage = this.listSessionsPerPage(layout, this._sessions.length);

    // NEXT→ sits just before the pinned usage tiles (or the last key when no
    // usage is reserved). Sessions fill slots 0..sessionsOnPage-1.
    const nextSlot = layout.keyCount - 1 - usageReserve;
    if (needsPage && slot === nextSlot) {
      return { type: 'next-page', label: `${this._currentPage + 1}/${this.totalPages(layout)}` };
    }

    const startIdx = this._currentPage * sessionsOnPage;
    const sessionIdx = startIdx + slot;

    if (slot < sessionsOnPage && sessionIdx < this._sessions.length) {
      const session = this._sessions[sessionIdx];
      return {
        type: 'session',
        session,
      };
    }

    return { type: 'empty' };
  }

  private modelStatusCard(session: SessionInfo | undefined): SessionSlotConfig | null {
    const rawModel = this._detailModelName ?? session?.modelName;
    if (!rawModel) return null;
    const modelText = aliasModelName(rawModel);
    return {
      type: 'status',
      label: 'MODEL',
      subtitle: this._detailEffortLevel && this._detailEffortLevel !== 'default'
        ? `${modelText} · ${this._detailEffortLevel}`
        : modelText,
      icon: 'model',
      tone: 'info',
    };
  }

  private modeStatusCard(): SessionSlotConfig | null {
    if (!this._detailMode || this._detailMode === 'default') return null;
    return {
      type: 'status',
      label: 'MODE',
      subtitle: this._detailMode.toUpperCase(),
      icon: 'mode',
      tone: 'purple',
    };
  }

  private idleStatusCard(session: SessionInfo | undefined, idx: number, includeModel = true, includeIdle = true): SessionSlotConfig {
    const cards = [
      includeModel ? this.modelStatusCard(session) : null,
      this.modeStatusCard(),
      includeIdle
        ? {
            type: 'status',
            label: session?.agentType === 'openclaw' ? 'STANDBY' : 'READY',
            subtitle: 'idle',
            icon: 'ready',
            tone: 'ready',
          } satisfies SessionSlotConfig
        : null,
    ].filter((card): card is SessionSlotConfig => card != null);
    return cards[idx] ?? { type: 'empty' };
  }

  private awaitingStatusCard(
    session: SessionInfo | undefined,
    idx: number,
    includeModel = true,
  ): SessionSlotConfig {
    const question = this._detailQuestion ? truncateStr(this._detailQuestion, 18) : 'choose option';
    const cards = [
      {
        type: 'status',
        label: 'AWAITING',
        subtitle: question,
        icon: 'option',
        tone: 'warning',
      } satisfies SessionSlotConfig,
      includeModel ? this.modelStatusCard(session) : null,
    ].filter((card): card is SessionSlotConfig => card != null);
    return cards[idx] ?? { type: 'empty' };
  }

  /**
   * Optimistic REVIEWING flip: sessionId → expiry. Set on the local REVIEW
   * press so the tile acknowledges instantly; superseded once the daemon's
   * own reviewStatus lands on the row, cleared on review_status error
   * (refusal) or the TTL (daemon dead / message lost).
   */
  private _pendingReviewUntil = new Map<string, number>();
  private static readonly PENDING_REVIEW_TTL_MS = 20_000;

  /** Local press-ack for REVIEW — show REVIEWING before the daemon round trip. */
  markReviewPending(sessionId: string): void {
    this._pendingReviewUntil.set(sessionId, Date.now() + SessionSlotManager.PENDING_REVIEW_TTL_MS);
  }

  /** Drop the optimistic flip (daemon refused / errored the review). */
  clearReviewPending(sessionId: string): void {
    this._pendingReviewUntil.delete(sessionId);
  }

  private isReviewRunning(session: SessionInfo | undefined): boolean {
    if (!session) return false;
    if (session.reviewStatus === 'running') return true;
    if (session.reviewStatus != null) {
      // Daemon has a verdict/error for this session — its row wins.
      this._pendingReviewUntil.delete(session.id);
      return false;
    }
    const until = this._pendingReviewUntil.get(session.id);
    if (until == null) return false;
    if (Date.now() > until) {
      this._pendingReviewUntil.delete(session.id);
      return false;
    }
    return true;
  }

  /**
   * REVIEW tile = independent on-demand eval (review_run) — daemon-side
   * judge, no agent control, valid for every session type once the turn has
   * completed. Badge shows the last verdict; REVIEWING while the judge runs
   * (not pressable).
   */
  private reviewSlotConfig(session: SessionInfo | undefined): SessionSlotConfig {
    if (this.isReviewRunning(session)) {
      return { type: 'status', label: 'REVIEWING', subtitle: 'judge running', icon: 'tool', tone: 'info' };
    }
    const risk = session?.reviewRisk;
    return {
      type: 'preset',
      preset: {
        label: 'REVIEW',
        iconSvg: REVIEW_ICON_SVG,
        color: '#1e293b',
        textColor: risk === 'high' ? '#f87171' : risk === 'medium' ? '#fbbf24' : '#93c5fd',
        subtitle: risk
          ? `risk ${risk}${session?.reviewFindings != null ? ` · ${session.reviewFindings}` : ''}`
          : undefined,
        localAction: 'review_run',
      },
    };
  }

  /**
   * Non-pressable review status for PROCESSING: REVIEWING while the judge
   * runs, or the last verdict as an inert badge; null when there is nothing
   * to show. Mid-turn the tile must not fire review_run — the work isn't
   * complete yet (the Swift daemon judges the session trajectory, which
   * mid-turn has no assistant response and reads as "incomplete/unverified";
   * the Node daemon would judge a half-written diff).
   */
  private reviewBadgeSlotConfig(session: SessionInfo | undefined): SessionSlotConfig | null {
    if (this.isReviewRunning(session)) {
      return { type: 'status', label: 'REVIEWING', subtitle: 'judge running', icon: 'tool', tone: 'info' };
    }
    const risk = session?.reviewRisk;
    if (!risk) return null;
    return {
      type: 'status',
      label: 'REVIEW',
      subtitle: `risk ${risk}${session?.reviewFindings != null ? ` · ${session.reviewFindings}` : ''}`,
      icon: 'ready',
      tone: risk === 'high' ? 'danger' : risk === 'medium' ? 'warning' : 'info',
    };
  }

  /**
   * Content cells for an observed (hook-only) session's detail view. Every
   * actionable cell maps to something actually deliverable:
   *   - held gate (Claude PreToolUse / OpenCode permission.asked) → Allow/Deny
   *   - processing → live readouts + STOP only
   *   - OpenCode idle → immediate injection presets
   *   - REVIEW (independent eval) → everywhere, including control-less Codex
   */
  private observedContentSlot(
    session: SessionInfo | undefined, idx: number,
    isAwaiting: boolean, isProcessing: boolean,
  ): SessionSlotConfig {
    // Delivery paths: Claude = hook RPC (gate / soft stop / turn-end queue),
    // OpenCode = observer-plugin queue (immediate). Codex = notify-only.
    const isOpenCodeObserved = session?.agentType === 'opencode';
    if (isAwaiting) {
      if (session?.requestId) {
        // Device-native gate semantics (permit/deny THIS tool call) — the
        // daemon only surfaces requestIds for genuine prompts (held
        // PreToolUse gate / OpenCode permission.asked), so these two answers
        // cannot mismatch the terminal prompt.
        if (idx === 0) return { type: 'option', option: { label: 'Allow', shortcut: 'y', index: 0 }, optionIndex: 0 };
        if (idx === 1) return { type: 'option', option: { label: 'Deny', shortcut: 'n', index: 1 }, optionIndex: 1 };
        return this.awaitingStatusCard(session, idx - 2, false);
      }
      // AskUserQuestion. A hook-observed session has no response channel of its
      // own, but the CLI daemon can type the selection into the session's own
      // terminal (observed-inject.ts) — `liveAnswerable` says it found a host to
      // aim at. Pressable only then: without it the deck must mirror the
      // terminal rather than pretend taps will work (the App Store Swift daemon
      // cannot inject at all, so it never sets the flag).
      const displayOption = session?.options?.[idx];
      if (displayOption) {
        if (session?.liveAnswerable) {
          return {
            type: 'option',
            option: { label: displayOption.label, shortcut: displayOption.shortcut, index: idx },
            optionIndex: idx,
          };
        }
        return {
          type: 'status',
          label: truncateStr(displayOption.label, 16),
          subtitle: idx === 0 ? 'answer in terminal' : undefined,
          icon: 'option',
          tone: 'warning',
        };
      }
      // Generic display-only permission Notification.
      if (idx === 0 && !session?.options?.length) {
        return {
          type: 'status', label: 'PERMIT?',
          subtitle: session?.question ? truncateStr(session.question, 18) : 'answer in terminal',
          icon: 'option', tone: 'warning',
        };
      }
      return { type: 'empty' };
    }
    if (isProcessing) {
      if (idx === 0) {
        const queued = session?.queuedDirectives ?? 0;
        return {
          type: 'status',
          label: session?.currentTool ?? 'WORKING',
          subtitle: queued > 0 ? `${queued} queued` : 'running',
          icon: 'tool', tone: 'warning',
        };
      }
      if (session?.stopRequested) {
        return idx === 1
          ? { type: 'status', label: 'STOPPING', subtitle: 'at next tool', icon: 'tool', tone: 'warning' }
          : { type: 'empty' };
      }
      // No queued task or model-looking buttons mid-turn. PROCESSING stays
      // glanceable and only STOP is actionable; review remains an inert
      // status badge.
      const cells: SessionSlotConfig[] = [];
      const reviewBadge = this.reviewBadgeSlotConfig(session);
      if (reviewBadge) cells.push(reviewBadge);
      const cellIdx = idx - 1;
      return cells[cellIdx] ?? { type: 'empty' };
    }
    // Idle observed.
    if (isOpenCodeObserved) {
      if (idx < OC_OBSERVED_INJECT_PRESETS.length) {
        const def = OC_OBSERVED_INJECT_PRESETS[idx];
        return { type: 'preset', preset: { ...def, iconSvg: def.iconSvg ?? '' } };
      }
      if (idx === OC_OBSERVED_INJECT_PRESETS.length) return this.reviewSlotConfig(session);
      return this.idleStatusCard(session, idx - OC_OBSERVED_INJECT_PRESETS.length - 1, false, false);
    }
    // Claude/Codex observed idle: no deck-native prompt presets, but the
    // independent review stays live — and so does voice, because the daemon
    // delivers a dictated prompt by typing into the owning terminal
    // (injectObservedText), the same ladder a board's PTT rides.
    if (idx === 0) return this.reviewSlotConfig(session);
    if (idx === 1) {
      return { type: 'preset', preset: buildVoicePreset(this._voiceState) };
    }
    if (idx === 2) {
      return { type: 'status', label: 'OBSERVED', subtitle: 'control in terminal', icon: 'ready', tone: 'info' };
    }
    return this.idleStatusCard(session, idx - 3, false, false);
  }

  private getDetailSlotConfig(slot: number, layout: DeckLayout): SessionSlotConfig {
    const session = this.getFocusedSession();
    // Observed (hook-only) sessions have no state_update relay — the
    // sessions_list row IS the live state source, so derive awaiting/
    // processing from it instead of the (never-primed) detail relay state.
    const isObserved = session?.controlMode === 'observed';
    const observedState = (session?.state ?? '').toLowerCase();
    const isAwaiting = isObserved
      ? observedState.startsWith('awaiting')
      : this.isAwaitingDetailState();
    const isProcessing = isObserved
      ? observedState === 'processing'
      : this._detailState === State.PROCESSING;
    const isOpenClaw = session?.agentType === 'openclaw';
    const detailOptionPages = this.detailOptionPages(layout);
    const reserveMore = isAwaiting && !isObserved && detailOptionPages > 1;
    const contentSlots = this.detailContentSlots(layout, reserveMore);
    const detailOptionStart = this._detailPage * Math.max(1, contentSlots.length);
    const controls = this.detailControlSlots(layout);

    if (slot === controls.back) {
      return { type: 'back', label: 'BACK' };
    }

    if (slot === controls.stop) {
      if (isObserved) {
        // Only steerable observed agents get an armed STOP: Claude = soft
        // stop (deny at next tool call), OpenCode = immediate abort via the
        // observer plugin. Codex is notify-only — inert. No button that
        // silently drops its command.
        const steerable = session?.agentType === 'claude-code' || session?.agentType === 'opencode';
        if (isProcessing && steerable) {
          return session?.stopRequested
            ? { type: 'status', label: 'STOPPING', subtitle: 'at next tool', icon: 'tool', tone: 'warning' }
            : { type: 'stop', label: 'active' };
        }
        return { type: 'empty' };
      }
      if (isAwaiting) return { type: 'esc', label: 'active' };
      if (isProcessing) return { type: 'stop', label: 'active' };
      return { type: 'esc', label: 'dim' };
    }

    if (slot === controls.info) {
      return { type: 'info', session, label: session ? this.displayNameFor(session) : 'Session' };
    }

    if (slot === controls.more && reserveMore) {
      return { type: 'next-page', label: `${this._detailPage + 1}/${detailOptionPages}` };
    }

    let contentIdx = contentSlots.indexOf(slot);
    if (contentIdx < 0) return { type: 'empty' };

    // Observed sessions get their own capability-aware content: gate
    // Allow/Deny while a held PreToolUse is pending, queueable directives
    // while processing, and an honest "control in terminal" tile when idle.
    if (isObserved) {
      return this.observedContentSlot(session, contentIdx, isAwaiting, isProcessing);
    }

    // Plus family only: the suggested-prompt quick-send leads the IDLE content
    // slots (relocated from the retired E2 encoder rotate/press). Gated on the
    // Plus family (SD+ / + XL) so classic-deck detail layouts are unchanged.
    const suggestEnabled = isPlusFamily(layout.family)
      && this._detailState === State.IDLE
      && !!this._detailSuggestedPrompt;
    if (suggestEnabled) {
      if (contentIdx === 0) {
        return { type: 'preset', preset: buildSuggestPreset(this._detailSuggestedPrompt!) };
      }
      // Shift the remaining IDLE content down by one so the existing layout
      // (presets → status cards) follows the suggested button.
      contentIdx -= 1;
    }

    const optionIndex = detailOptionStart + contentIdx;
    if (isAwaiting) {
      if (optionIndex < this._detailOptions.length) {
        return {
          type: 'option',
          option: this._detailOptions[optionIndex],
          optionIndex,
        };
      }
      return this.awaitingStatusCard(session, optionIndex - this._detailOptions.length);
    }

    // PROCESSING: first content slot shows current tool/status before any presets.
    if (isProcessing && contentIdx === 0) {
      return {
        type: 'status',
        label: this._detailTool ?? (isOpenClaw ? 'ROUTING' : 'WORKING'),
        subtitle: this._detailToolInput ? truncateStr(this._detailToolInput, 22) : 'running',
        icon: 'tool',
        tone: 'warning',
      };
    }

    if (isProcessing && !isOpenClaw && contentIdx === 1) {
      return this.modelStatusCard(session) ?? { type: 'empty' };
    }

    // No actionable REVIEW mid-turn — the work isn't complete yet; show the
    // REVIEWING spinner / last-verdict badge as inert status only.
    if (isProcessing && !isOpenClaw && contentIdx === 2) {
      return this.reviewBadgeSlotConfig(session) ?? { type: 'empty' };
    }

    // OpenClaw presets (IDLE, or PROCESSING after the tool status tile)
    if (isOpenClaw && !isAwaiting) {
      const presetIdx = isProcessing ? contentIdx - 1 : contentIdx;
      if (presetIdx >= 0 && presetIdx < OC_PRESET_DEFS.length) {
        const def = OC_PRESET_DEFS[presetIdx];
        const iconSvg = def.dynamicIcon === 'model'
          ? buildModelIcon(this._detailModelName, this._modelSwitching)
          : (def.iconSvg ?? '');
        const preset: PresetAction = {
          label: def.label,
          iconSvg,
          color: def.color,
          textColor: def.textColor,
          subtitle: def.dynamicIcon === 'model' ? truncateStr(aliasModelName(this._detailModelName ?? session?.modelName ?? 'model'), 14) : undefined,
          prompt: def.prompt,
          localAction: def.localAction,
          loading: def.dynamicIcon === 'model' ? this._modelSwitching : undefined,
        };
        return { type: 'preset', preset };
      }
    }

    // Claude Code IDLE: show quick action presets (GO ON, REVIEW, COMMIT, CLEAR)
    if (!isOpenClaw && this._detailState === State.IDLE && contentIdx < CC_PRESET_DEFS.length) {
      const def = CC_PRESET_DEFS[contentIdx];
      const preset: PresetAction = {
        label: def.label,
        iconSvg: def.iconSvg ?? '',
        color: def.color,
        textColor: def.textColor,
        prompt: def.prompt,
        // Without this, localAction presets (REVIEW → review_run) press as
        // dead keys: handleSlotPress dispatches on preset.localAction.
        localAction: def.localAction,
      };
      return { type: 'preset', preset };
    }

    // VOICE hold-to-talk follows the preset row — host mic + host speakers,
    // routed by the daemon through the same pipeline as a board's PTT key.
    if (!isOpenClaw && this._detailState === State.IDLE && contentIdx === CC_PRESET_DEFS.length) {
      return { type: 'preset', preset: buildVoicePreset(this._voiceState) };
    }

    if (!isOpenClaw && this._detailState === State.IDLE) {
      return this.idleStatusCard(session, contentIdx - CC_PRESET_DEFS.length - 1);
    }

    // OpenClaw already surfaces MODEL as an actionable preset, and PROCESSING
    // (both agents) already renders the model status tile at content slot 1, so
    // exclude the model card here to avoid showing MODEL twice.
    if (isOpenClaw && this._detailState === State.IDLE) {
      return this.idleStatusCard(session, contentIdx - OC_PRESET_DEFS.length, false);
    }

    // PROCESSING already shows the live tool/status tile at content slot 0, so
    // the reused idleStatusCard helper must not emit its hardcoded READY/idle
    // card here — otherwise a busy session shows a contradictory "idle" tile.
    if (isProcessing && isOpenClaw) {
      return this.idleStatusCard(session, contentIdx - 1 - OC_PRESET_DEFS.length, false, false);
    }

    if (isProcessing && !isOpenClaw) {
      return this.idleStatusCard(session, contentIdx - 2, false, false);
    }

    return { type: 'empty' };
  }

  private detailControlSlots(layout: DeckLayout): { back: number; info: number; more: number; stop: number } {
    const stop = layout.keyCount - 1;
    const back = 0;
    const info = layout.keyCount > 1 ? 1 : 0;
    const more = layout.keyCount > 4 ? layout.keyCount - 2 : Math.max(0, stop - 1);
    return { back, info, more, stop };
  }

  private detailContentSlots(layout: DeckLayout, reserveMore: boolean): number[] {
    const controls = this.detailControlSlots(layout);
    const reserved = new Set([controls.back, controls.info, controls.stop]);
    if (reserveMore) reserved.add(controls.more);

    const slots: number[] = [];
    for (let slot = 0; slot < layout.keyCount; slot++) {
      if (!reserved.has(slot)) slots.push(slot);
    }
    return slots;
  }
}
