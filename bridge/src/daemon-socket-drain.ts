import type { Server } from 'node:http';
import type { Socket } from 'node:net';

/** Track raw sockets too: closeAllConnections excludes upgraded WebSockets.
 * During daemon handover a peer that cannot ACK a FIN must not retain the local
 * port after process exit. Reset live TCP sockets before async module teardown.
 * Already completed HTTP connections may still have their normal TIME_WAIT.
 */
export function trackDaemonSockets(server: Server): () => void {
  const sockets = new Set<Socket>();
  let stopping = false;
  const reset = (socket: Socket) => {
    if (socket.destroyed) return;
    try { socket.resetAndDestroy(); } catch { socket.destroy(); }
  };
  server.on('connection', (socket) => {
    if (stopping) { reset(socket); return; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return () => {
    stopping = true;
    // Stop accepts before resetting existing HTTP, SSE and upgraded sockets.
    server.close();
    for (const socket of sockets) reset(socket);
    sockets.clear();
  };
}
