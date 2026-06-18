/**
 * SessionSlotManager — central state machine for v4 dynamic session-per-button layout.
 *
 * Two views:
 * - List View: each button shows one session (OC first, then CC by startedAt)
 * - Detail View: button 1=BACK, button 2=session info, buttons 3-7=options, button 8=ESC/STOP
 */
import type { SessionInfo, StatusCardTone, StatusIconKind } from '@agentdeck/shared';
import { State, sortSessions, assignDisplayNames, foldCodexSessionsForDisplay, aliasModelName } from '@agentdeck/shared';
import type { PromptOption } from '@agentdeck/shared';
import { dlog } from './log.js';

export type SlotView = 'list' | 'detail';

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
  type: 'session' | 'back' | 'info' | 'status' | 'option' | 'esc' | 'stop' | 'next-page' | 'preset' | 'empty';
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
  isActive?: boolean;
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

const CC_PRESET_DEFS: Array<Omit<PresetAction, 'iconSvg'> & { iconSvg?: string; dynamicIcon?: 'model' }> = [
  { label: 'GO ON', iconSvg: GO_ON_ICON_SVG, color: '#1e3a2f', textColor: '#22c55e', prompt: 'go on' },
  { label: 'REVIEW', iconSvg: REVIEW_ICON_SVG, color: '#1e293b', textColor: '#93c5fd', prompt: '/review' },
  { label: 'COMMIT', iconSvg: COMMIT_ICON_SVG, color: '#1e293b', textColor: '#22c55e', prompt: '/commit' },
  { label: 'CLEAR', iconSvg: CLEAR_ICON_SVG, color: '#1e293b', textColor: '#94a3b8', prompt: '/clear' },
];

const DEFAULT_LAYOUT: DeckLayout = { columns: 4, rows: 2, keyCount: 8, family: 'streamdeckplus' };
const MAX_SESSIONS = 32;

function normalizeLayout(layout?: Partial<DeckLayout>): DeckLayout {
  const columns = Math.max(1, Math.floor(layout?.columns ?? DEFAULT_LAYOUT.columns));
  const rows = Math.max(1, Math.floor(layout?.rows ?? DEFAULT_LAYOUT.rows));
  const keyCount = Math.max(1, Math.floor(layout?.keyCount ?? columns * rows));
  return { columns, rows, keyCount, family: layout?.family ?? DEFAULT_LAYOUT.family };
}

function listSessionsPerPage(layout: DeckLayout, totalSessions: number): number {
  return totalSessions > layout.keyCount ? Math.max(1, layout.keyCount - 1) : layout.keyCount;
}

export class SessionSlotManager {
  private static readonly MODEL_SWITCH_TIMEOUT_MS = 12000;

  private _view: SlotView = 'list';
  private _currentPage = 0;
  private _detailPage = 0;
  private _sessions: SessionInfo[] = [];
  private _displayNames = new Map<string, string>();
  private _focusedSessionId: string | null = null;
  private _activeSessionId: string | null = null;
  private _activeSessionPort: number | null = null;
  private _gatewayAvailable = false;

  // Detail view state (from the focused session's bridge)
  private _detailState = State.DISCONNECTED;
  private _detailOptions: PromptOption[] = [];
  private _detailTool: string | undefined;
  private _detailToolInput: string | undefined;
  private _detailQuestion: string | undefined;
  private _detailModelName: string | undefined;
  private _detailEffortLevel: string | undefined;
  private _detailMode: string | undefined;
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

  updateSessions(sessions: SessionInfo[], gatewayAvailable: boolean): void {
    this._gatewayAvailable = gatewayAvailable;
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

  setActiveSession(sessionId: string | null, port: number | null): void {
    this._activeSessionId = sessionId;
    this._activeSessionPort = port;
  }

  setGatewayAvailable(available: boolean): void {
    this._gatewayAvailable = available;
  }

  // ---- Detail view state updates ----

  updateDetailState(state: State, options: PromptOption[], tool?: string, toolInput?: string, question?: string, modelName?: string, mode?: string, effortLevel?: string): void {
    this._detailState = state;
    this._detailOptions = options;
    this._detailTool = tool;
    this._detailToolInput = toolInput;
    this._detailQuestion = question;
    this._detailModelName = modelName;
    this._detailEffortLevel = effortLevel;
    this._detailMode = mode;
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
    action: 'enter-detail' | 'exit-detail' | 'select-option' | 'stop' | 'esc' | 'next-page' | 'send-prompt' | 'open-gateway' | 'switch-model' | 'none';
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

    if (this._activeSessionId) {
      const next = findSuccessor(this._activeSessionId);
      if (next === null) this._activeSessionId = null;
      else if (next !== this._activeSessionId) this._activeSessionId = next;
    }
  }

  // ---- Internal helpers ----

  private totalPages(layout: DeckLayout = DEFAULT_LAYOUT): number {
    const count = this._sessions.length;
    if (count <= layout.keyCount) return 1;
    return Math.ceil(count / listSessionsPerPage(layout, count));
  }

  private needsPagination(layout: DeckLayout): boolean {
    return this._sessions.length > layout.keyCount;
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
    const sessionsOnPage = listSessionsPerPage(layout, this._sessions.length);

    // Last slot on page = NEXT→ when paginating
    if (needsPage && slot === layout.keyCount - 1) {
      return { type: 'next-page', label: `${this._currentPage + 1}/${this.totalPages(layout)}` };
    }

    const startIdx = this._currentPage * sessionsOnPage;
    const sessionIdx = startIdx + slot;

    if (sessionIdx < this._sessions.length) {
      const session = this._sessions[sessionIdx];
      return {
        type: 'session',
        session,
        isActive: session.id === this._activeSessionId || session.port === this._activeSessionPort,
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

  private idleStatusCard(session: SessionInfo | undefined, idx: number, includeModel = true): SessionSlotConfig {
    const cards = [
      includeModel ? this.modelStatusCard(session) : null,
      this.modeStatusCard(),
      {
        type: 'status',
        label: session?.agentType === 'openclaw' ? 'STANDBY' : 'READY',
        subtitle: 'idle',
        icon: 'ready',
        tone: 'ready',
      } satisfies SessionSlotConfig,
    ].filter((card): card is SessionSlotConfig => card != null);
    return cards[idx] ?? { type: 'empty' };
  }

  private awaitingStatusCard(session: SessionInfo | undefined, idx: number): SessionSlotConfig {
    const question = this._detailQuestion ? truncateStr(this._detailQuestion, 18) : 'choose option';
    const cards = [
      {
        type: 'status',
        label: 'AWAITING',
        subtitle: question,
        icon: 'option',
        tone: 'warning',
      } satisfies SessionSlotConfig,
      this.modelStatusCard(session),
    ].filter((card): card is SessionSlotConfig => card != null);
    return cards[idx] ?? { type: 'empty' };
  }

  private getDetailSlotConfig(slot: number, layout: DeckLayout): SessionSlotConfig {
    const session = this.getFocusedSession();
    const isAwaiting = this.isAwaitingDetailState();
    const isProcessing = this._detailState === State.PROCESSING;
    const isOpenClaw = session?.agentType === 'openclaw';
    const detailOptionPages = this.detailOptionPages(layout);
    const reserveMore = isAwaiting && detailOptionPages > 1;
    const contentSlots = this.detailContentSlots(layout, reserveMore);
    const detailOptionStart = this._detailPage * Math.max(1, contentSlots.length);
    const controls = this.detailControlSlots(layout);

    if (slot === controls.back) {
      return { type: 'back', label: 'BACK' };
    }

    if (slot === controls.stop) {
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

    const contentIdx = contentSlots.indexOf(slot);
    if (contentIdx < 0) return { type: 'empty' };

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
      };
      return { type: 'preset', preset };
    }

    if (!isOpenClaw && this._detailState === State.IDLE) {
      return this.idleStatusCard(session, contentIdx - CC_PRESET_DEFS.length);
    }

    // OpenClaw already surfaces MODEL as an actionable preset, and PROCESSING
    // (both agents) already renders the model status tile at content slot 1, so
    // exclude the model card here to avoid showing MODEL twice.
    if (isOpenClaw && this._detailState === State.IDLE) {
      return this.idleStatusCard(session, contentIdx - OC_PRESET_DEFS.length, false);
    }

    if (isProcessing && isOpenClaw) {
      return this.idleStatusCard(session, contentIdx - 1 - OC_PRESET_DEFS.length, false);
    }

    if (isProcessing && !isOpenClaw) {
      return this.idleStatusCard(session, contentIdx - 2, false);
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
