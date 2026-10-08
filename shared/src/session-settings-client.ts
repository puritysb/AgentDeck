import type { QuerySessionSettingsCommand, SetSessionSettingCommand, SessionSettingsEvent, SessionSetting } from './protocol.js';
import { isSessionSettingKey, isSessionSettingValue, isSessionSettingsTargetKey, SESSION_SETTINGS_RULES } from './session-settings.js';

export interface SessionSettingsSnapshot {
  settings: SessionSetting[];
  targetSessionKey?: string;
  error?: string;
  pending?: 'query' | 'set';
}

/** One active picker request per client. Responses must echo both its nonce and
 * target session; late replies cannot update a closed or newly opened picker. */
export class SessionSettingsRequestTracker {
  private readonly snapshots = new Map<string, SessionSettingsSnapshot>();
  private pending?: { sessionId: string; requestId: string; operation: 'query' | 'set'; timer: ReturnType<typeof setTimeout> };
  onChanged?: (sessionId: string) => void;

  snapshot(sessionId: string): SessionSettingsSnapshot | undefined { return this.snapshots.get(sessionId); }

  query(sessionId: string): QuerySessionSettingsCommand {
    const requestId = this.begin(sessionId, 'query');
    return { type: 'query_session_settings', sessionId, requestId };
  }

  set(sessionId: string, key: SessionSetting['key'], value: string | null): SetSessionSettingCommand | undefined {
    const snapshot = this.snapshots.get(sessionId);
    if (!isSessionSettingKey(key) || !isSessionSettingValue(value)) return undefined;
    if (snapshot?.pending) return undefined;
    if (!isSessionSettingsTargetKey(snapshot?.targetSessionKey)) {
      this.snapshots.set(sessionId, { settings: snapshot?.settings ?? [], error: 'Settings target unavailable' });
      this.onChanged?.(sessionId);
      return undefined;
    }
    const targetSessionKey = snapshot.targetSessionKey;
    const requestId = this.begin(sessionId, 'set');
    return { type: 'set_session_setting', sessionId, requestId, targetSessionKey, key, value };
  }

  private begin(sessionId: string, operation: 'query' | 'set'): string {
    this.cancel();
    const requestId = globalThis.crypto.randomUUID();
    const old = this.snapshots.get(sessionId);
    this.snapshots.set(sessionId, operation === 'query'
      ? { settings: [], pending: operation }
      : { ...old, settings: old?.settings ?? [], error: undefined, pending: operation });
    const timer = setTimeout(() => {
      if (this.pending?.requestId !== requestId) return;
      this.pending = undefined;
      const current = this.snapshots.get(sessionId);
      this.snapshots.set(sessionId, { ...current, settings: current?.settings ?? [], pending: undefined, error: 'No response from daemon' });
      this.onChanged?.(sessionId);
    }, SESSION_SETTINGS_RULES.requestTimeoutMs);
    timer.unref?.();
    this.pending = { sessionId, requestId, operation, timer };
    return requestId;
  }

  accept(event: SessionSettingsEvent): 'query' | 'set' | undefined {
    const pending = this.pending;
    if (!pending || event.requestId !== pending.requestId || event.sessionId !== pending.sessionId) return undefined;
    if (pending.operation === 'set' && event.targetSessionKey !== this.snapshots.get(event.sessionId)?.targetSessionKey) return undefined;
    clearTimeout(pending.timer);
    this.pending = undefined;
    this.snapshots.set(event.sessionId, {
      settings: Array.isArray(event.settings) ? event.settings : [],
      targetSessionKey: event.targetSessionKey,
      ...(event.error ? { error: event.error } : {}),
    });
    return pending.operation;
  }

  cancel(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const { sessionId } = this.pending;
    const current = this.snapshots.get(sessionId);
    if (current) this.snapshots.set(sessionId, { ...current, pending: undefined });
    this.pending = undefined;
  }

  disconnect(): void { this.cancel(); this.snapshots.clear(); }
}
