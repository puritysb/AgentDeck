/**
 * Keeps an encoder view independent for each Stream Deck action context.
 *
 * Stream Deck assigns a distinct action id to every placed action. Persisted
 * settings are loaded per id, while the available view list may change as
 * usage windows or scoped limits appear and disappear.
 */
export class PerActionViewState {
  private readonly selectedByAction = new Map<string, string>();

  constructor(private readonly fallback: string) {}

  load(actionId: string, selected: unknown): void {
    this.selectedByAction.set(actionId, typeof selected === 'string' ? selected : this.fallback);
  }

  resolve(actionId: string, available: readonly string[]): string {
    const selected = this.selectedByAction.get(actionId) ?? this.fallback;
    return available.includes(selected) ? selected : this.fallback;
  }

  rotate(actionId: string, available: readonly string[], ticks: number): string {
    if (available.length === 0) return this.fallback;
    const current = this.resolve(actionId, available);
    const currentIndex = Math.max(0, available.indexOf(current));
    const direction = ticks >= 0 ? 1 : -1;
    const next = available[(currentIndex + direction + available.length) % available.length];
    this.selectedByAction.set(actionId, next);
    return next;
  }

  remove(actionId: string): void {
    this.selectedByAction.delete(actionId);
  }
}
