/**
 * The Ulanzi Studio endpoint this service was launched against, retained for
 * every reconnect (#730).
 *
 * Studio starts the service as `node app.js <address> <port> <language>`. The
 * vendored SDK's `connect()` reads those with `process.argv.splice(2)`, which
 * CONSUMES them: the first connect sees Studio's endpoint, and every later one
 * falls back to the SDK's defaults (`127.0.0.1:3906`). The reconnect supervisor
 * calls `connect()` again after a drop or a wake, so on any Studio build whose
 * port is not 3906 the plugin reconnected to a port nobody listens on and its
 * keys stayed stale until Studio restarted the service.
 *
 * The vendored SDK is left unmodified; instead the launch arguments are read
 * once here (without consuming them) and passed explicitly on every call. The
 * first call still sees the same values through argv, and later calls receive
 * them as the explicit `port`/`address` the SDK falls back to.
 */
import type { UlanziApi } from './ulanzi.js';

/** SDK defaults, used only when Studio passed nothing. */
export const STUDIO_DEFAULT_ADDRESS = '127.0.0.1';
export const STUDIO_DEFAULT_PORT = 3906;

export interface StudioEndpoint {
  address: string;
  port: number;
}

/** Read Studio's launch endpoint from argv without mutating it. */
export function readStudioEndpoint(argv: readonly string[]): StudioEndpoint {
  const [address, portArg] = argv.slice(2);
  const port = Number(portArg);
  return {
    address: address ? address : STUDIO_DEFAULT_ADDRESS,
    port: Number.isInteger(port) && port > 0 && port <= 65_535 ? port : STUDIO_DEFAULT_PORT,
  };
}

/** A `connect` for the reconnect supervisor that targets the same endpoint every time. */
export function studioConnector(
  api: Pick<UlanziApi, 'connect'>,
  uuid: string,
  endpoint: StudioEndpoint,
): () => void {
  return () => api.connect(uuid, endpoint.port, endpoint.address);
}
