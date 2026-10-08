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
} as const;
