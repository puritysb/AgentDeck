/**
 * The keys Ulanzi Studio has placed the AgentDeck action on, and which of them
 * the layout may use.
 *
 * Studio names each placed action by a context (`uuid___key___actionid`), so two
 * contexts can name the SAME key: a key on another page or folder, or the old
 * action during a replace (Studio sends `add` for the new one and `clear` for the
 * old one, in either order). The layout engine addresses cells by key, so every
 * context reporting a key used to be one more entry in the position list — and
 * a duplicated position meant the deck Map was written twice, the later (empty)
 * cell winning. That is the blank row Ulanzi's QA reported after a fifth key went
 * onto a new page (2026-10-19).
 *
 * Three rules keep one context per key:
 *  - only ACTIVE contexts lay out (`setactive` says which page is on screen;
 *    a context is active until Studio says otherwise);
 *  - a context added (or activated, or pressed) on a key takes the key from any
 *    other context on it — the device shows one action per key. The others are
 *    deactivated, not forgotten: if Studio never sends `setactive` when the user
 *    returns to their page, a press there still proves the context is on screen
 *    and brings it back;
 *  - positions are de-duplicated anyway, newest context winning, so a
 *    `setactive` race cannot reintroduce the duplicate.
 *
 * Kept out of app.ts, which opens Studio's socket on import, so the lifecycle can
 * be tested on its own.
 */
export interface KeyInstance {
  context: string;
  /** `col_row` */
  key: string;
  active: boolean;
  /** Last pushed tile signature; undefined forces the next render to push. */
  lastSig?: string;
  /** Monotonic order of the last add/activation — the newest wins a key. */
  seq: number;
}

export class KeyRegistry {
  private readonly byContext = new Map<string, KeyInstance>();
  private nextSeq = 0;

  get size(): number { return this.byContext.size; }
  get(context: string): KeyInstance | undefined { return this.byContext.get(context); }
  has(context: string): boolean { return this.byContext.has(context); }
  values(): IterableIterator<KeyInstance> { return this.byContext.values(); }

  /**
   * Studio placed the action on `key`. Returns the contexts it displaced (other
   * contexts on the same key, now inactive).
   */
  add(context: string, key: string, active = true): string[] {
    const displaced = active ? this.deactivateOthersOn(key, context) : [];
    const existing = this.byContext.get(context);
    this.byContext.set(context, {
      context,
      key,
      active,
      lastSig: undefined,
      seq: ++this.nextSeq,
      ...(existing && existing.key === key && existing.active === active ? { lastSig: existing.lastSig } : {}),
    });
    return displaced;
  }

  /** Studio removed the action from these contexts. Returns true if any was known. */
  clear(contexts: Iterable<string>): boolean {
    let removed = false;
    for (const context of contexts) removed = this.byContext.delete(context) || removed;
    return removed;
  }

  /**
   * Studio's `setactive`: the context's page came on screen (true) or left it
   * (false). An unknown context that turns active is registered — Studio does
   * not promise an `add` before it. A key press is the same proof of being on
   * screen, so the press path calls this with `true` too. Returns the contexts
   * displaced by an activation.
   */
  setActive(context: string, key: string | undefined, active: boolean): string[] {
    const existing = this.byContext.get(context);
    if (!existing) {
      if (!active || !key) return [];
      return this.add(context, key, true);
    }
    if (!active) {
      existing.active = false;
      existing.lastSig = undefined;
      return [];
    }
    if (existing.active && this.activeInstances().some((i) => i.context === context)) return [];
    const displaced = this.deactivateOthersOn(existing.key, context);
    existing.active = true;
    existing.lastSig = undefined;
    existing.seq = ++this.nextSeq;
    return displaced;
  }

  /** Active contexts, one per key (the newest wins a contested key). */
  activeInstances(): KeyInstance[] {
    const byKey = new Map<string, KeyInstance>();
    for (const inst of this.byContext.values()) {
      if (!inst.active) continue;
      const held = byKey.get(inst.key);
      if (!held || inst.seq > held.seq) byKey.set(inst.key, inst);
    }
    return [...byKey.values()];
  }

  /** The layout's position list: one entry per key with an active context. */
  positions(): string[] {
    return this.activeInstances().map((i) => i.key);
  }

  /** Context ids that lay out, as `key=context`, sorted — for the deck signature. */
  layoutContexts(): string[] {
    return this.activeInstances().map((i) => `${i.key}=${i.context}`).sort();
  }

  /** Forget every pushed tile so the next render pushes all keys again. */
  invalidate(): void {
    for (const inst of this.byContext.values()) inst.lastSig = undefined;
  }

  private deactivateOthersOn(key: string, keep: string): string[] {
    const displaced: string[] = [];
    for (const [context, inst] of this.byContext) {
      if (context === keep || inst.key !== key || !inst.active) continue;
      inst.active = false;
      inst.lastSig = undefined;
      displaced.push(context);
    }
    return displaced;
  }
}
