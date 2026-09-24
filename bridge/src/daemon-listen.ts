import type { Server } from 'node:net';

/** A failed listen must remove BOTH listeners before retrying the same server. */
export function listenOnce(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export type PortConflictAction = 'retry' | 'fallback' | 'concede';

/**
 * Recover BEFORE serving clients, using the real listener and its resolved bind
 * address. Never close/restart a healthy fallback listener to chase another port.
 * The peer check is repeated after each failed bind: a daemon appearing during
 * the wait must not turn into a second daemon when the budget expires.
 */
export async function listenWithReclaim(
  server: Server,
  options: {
    port: number;
    host: string;
    budgetMs: number;
    onConflict: () => Promise<PortConflictAction>;
    onWaiting: () => void;
  },
): Promise<'bound' | 'fallback' | 'concede'> {
  const deadline = performance.now() + options.budgetMs;
  let announced = false;
  for (;;) {
    try {
      await listenOnce(server, options.port, options.host);
      return 'bound';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
    const action = await options.onConflict();
    if (action !== 'retry') return action;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return 'fallback';
    if (!announced) {
      options.onWaiting();
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
  }
}
