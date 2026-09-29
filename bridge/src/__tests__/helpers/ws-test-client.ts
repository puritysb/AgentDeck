/**
 * Test helper: WebSocket client that collects BridgeEvent messages.
 * Provides typed event collection and async waitFor() for integration tests.
 */
import WebSocket from 'ws';
import type { BridgeEvent } from '../../types.js';

export class WsTestClient {
  private ws: WebSocket | null = null;
  private messages: BridgeEvent[] = [];
  private waiters: Array<{
    predicate: (evt: BridgeEvent) => boolean;
    resolve: (evt: BridgeEvent) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  async connect(url: string, headers?: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        try {
          const evt = JSON.parse(data.toString()) as BridgeEvent;
          this.messages.push(evt);
          // Check waiters
          for (let i = this.waiters.length - 1; i >= 0; i--) {
            if (this.waiters[i].predicate(evt)) {
              clearTimeout(this.waiters[i].timer);
              this.waiters[i].resolve(evt);
              this.waiters.splice(i, 1);
            }
          }
        } catch { /* skip non-JSON */ }
      });
    });
  }

  /** Wait for a message matching the predicate (timeout default 3s) */
  waitFor(predicate: (evt: BridgeEvent) => boolean, timeoutMs = 3000): Promise<BridgeEvent> {
    // Check already-received messages first
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`waitFor timed out after ${timeoutMs}ms. Received ${this.messages.length} messages: ${this.messages.map(m => m.type).join(', ')}`));
      }, timeoutMs);

      this.waiters.push({ predicate, resolve, timer });
    });
  }

  /** Wait for a message of a specific type */
  waitForType(type: string, timeoutMs = 3000): Promise<BridgeEvent> {
    return this.waitFor((evt) => evt.type === type, timeoutMs);
  }

  /** Send a JSON command to the server */
  send(cmd: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    }
  }

  /** Get all received messages */
  getMessages(): BridgeEvent[] {
    return [...this.messages];
  }

  /** Get messages of a specific type */
  getMessagesOfType<T extends BridgeEvent>(type: string): T[] {
    return this.messages.filter((m) => m.type === type) as T[];
  }

  /** Clear collected messages */
  clear(): void {
    this.messages = [];
  }

  async close(): Promise<void> {
    // Cancel all pending waiters
    for (const w of this.waiters) {
      clearTimeout(w.timer);
    }
    this.waiters = [];

    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.on('close', () => resolve());
      this.ws.close();
      // Fallback timeout
      setTimeout(resolve, 500);
    });
  }
}
