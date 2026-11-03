import type { ServerResponse } from 'node:http';
/** Do not disclose a new credential on an HTTP request admitted under an old
 * generation, including a delayed handler or a long-lived stream. */
export function fenceCredentialResponse(res: ServerResponse, allowed: () => boolean): void {
  const write = res.write;
  const end = res.end;
  res.write = function (this: ServerResponse, ...args: Parameters<typeof write>) {
    if (!allowed()) { this.destroy(); return false; }
    return write.apply(this,args);
  } as typeof write;
  res.end = function (this: ServerResponse, ...args: Parameters<typeof end>) {
    if (!allowed()) { this.destroy(); return this; }
    return end.apply(this,args);
  } as typeof end;
}
