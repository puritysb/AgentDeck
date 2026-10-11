/** Direct MCP hosting budgets; generated Swift mirror is checked against this source. */
export const DOT_LIMITS = {
  bodyBytes: 32768, headerBytes: 8192, callbackResponseBytes: 8192, callbackMs: 10000,
  subscriptionMs: 86400000, rotationMs: 300000, requestMs: 1800000, claimMs: 300000,
  attempts: 5, records: 1000, connections: 16, retentionMs: 604800000, requestsPerMinute: 240,
  interactionEvents: 16, interactionSummaryCharacters: 240,
  reportFreshMs: 180000, completionReactionMs: 8000, feedReports: 3,
  contextCharacters: 8000, reportCharacters: 4000, reportKeys: 128, callbackURLCharacters: 2048, retryMaxMs: 60000,
} as const;
export const DOT_OAUTH_LIMITS = {
  pending: 16, records: 16384, consentMs: 120000, accessMs: 300000, refreshMs: 2592000000,
  // Loopback client registration (RFC 7591) and metadata documents. Registration is not
  // authentication: every grant still needs native consent.
  clients: 64, redirectURIs: 4, registrationBytes: 4096, clientNameCharacters: 64,
  metadataBytes: 8192, metadataMs: 5000, metadataCacheMs: 300000, metadataURLCharacters: 256,
} as const;

/** Local public OAuth client; PKCE and explicit host consent grant access. */
export const DOT_LOCAL_MCP = {
  host: '127.0.0.1', port: 9476, controlPort: 9477, callbackPort: 1455,
  clientId: 'agentdeck-local-plugin', callbackPath: '/callback',
  // A registered or metadata client may append one opaque segment (Codex: /callback/<id>).
  clientCallbackPattern: '^/callback(/[A-Za-z0-9_-]{1,64})?$',
  // Client ID metadata documents are fetched only from these hosts, over HTTPS, without redirects.
  metadataHosts: ['chatgpt.com'],
  // Least privilege for the loopback host: Events subscription is never advertised here.
  advertisedScopes: ['agentdeck:read', 'agentdeck:report'],
} as const;
