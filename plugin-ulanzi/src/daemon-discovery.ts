import { readFileSync } from 'node:fs';
import { get } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_WS_PORT } from '@agentdeck/shared';

/** Registry PIDs can belong to WSL2, not Studio's Windows process namespace.
 * The bounded loopback health check is the liveness/role authority. */
export function probeDaemon(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (healthy: boolean) => {
      clearTimeout(deadline);
      resolve(healthy);
      req.destroy();
    };
    const req = get({ hostname: '127.0.0.1', port, path: '/health' }, (res) => {
      if (res.statusCode !== 200) { finish(false); return; }
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 16_384) finish(false);
      });
      res.on('error', () => finish(false));
      res.on('end', () => {
        try {
          const health = JSON.parse(body);
          finish(health?.status === 'ok' && health?.mode === 'daemon'
            && health?.authRequired !== true);
        } catch { finish(false); }
      });
    });
    // A wall-clock deadline also bounds a peer that keeps trickling bytes.
    const deadline = setTimeout(() => finish(false), timeoutMs);
    req.on('error', () => finish(false));
  });
}

export async function discoverDaemonPort(
  probe: (port: number) => Promise<boolean> = probeDaemon,
): Promise<number | null> {
  const override = process.env.AGENTDECK_DATA_DIR;
  const home = homedir();
  const files = override ? [join(override, 'daemon.json')] : [
    join(home, '.agentdeck', 'daemon.json'),
    join(home, 'Library', 'Containers', 'bound.serendipity.agent.deck',
      'Data', 'Library', 'Application Support', 'AgentDeck', 'daemon.json'),
    join(home, 'Library', 'Group Containers', 'group.bound.serendipity.agent.deck', 'daemon.json'),
  ];
  const ports = new Set<number>();
  for (const file of files) {
    try {
      const { port } = JSON.parse(readFileSync(file, 'utf8'));
      if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
    } catch { /* Missing/unreadable registry is not proof the daemon is down. */ }
  }
  // An explicit data directory isolates development/test instances. Otherwise
  // use the canonical hub when WSL2's registry is outside the Windows home.
  if (!override) ports.add(BRIDGE_WS_PORT);
  for (const port of ports) {
    if (await probe(port)) return port;
  }
  return null;
}
