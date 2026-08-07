import type { DeviceModule, BridgeContext } from './types.js';
import { advertiseUdpBroadcast } from '../broadcast.js';
import type { AgentType } from '../types.js';

/**
 * UDP-broadcast daemon discovery. Runs alongside the mDNS module as a fallback
 * for routers that silently drop multicast — same payload shape, different
 * transport. Always activates unless explicitly disabled in module config.
 */
export class BroadcastModule implements DeviceModule {
  readonly name = 'broadcast';
  private cleanup: (() => void) | null = null;
  private agentType: AgentType;

  constructor(agentType: AgentType) {
    this.agentType = agentType;
  }

  async shouldActivate(_config: 'auto' | boolean): Promise<boolean> {
    // Lightweight UDP beacon — always on unless explicitly disabled.
    return _config !== false;
  }

  async start(ctx: BridgeContext): Promise<void> {
    // Discovery is unauthenticated LAN broadcast. Never pass ctx.authToken:
    // clients must already hold it from explicit pairing/provisioning.
    this.cleanup = advertiseUdpBroadcast(ctx.port, ctx.projectName, this.agentType);
  }

  async stop(): Promise<void> {
    this.cleanup?.();
    this.cleanup = null;
  }
}
