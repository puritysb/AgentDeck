import fs from 'fs';
import os from 'os';
import path from 'path';

export interface CodexAuthStatus {
  authMode?: string;
  webAuthConnected?: boolean;
  planType?: string;
  accountId?: string;
  subscriptionActiveUntil?: string;
  lastRefreshAt?: string;
}

function decodeJwtPayload(token?: string): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    const json = Buffer.from(base64, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringField(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Prefer the reported future subscription end verbatim. An expired auth snapshot
 * is not a current billing date, and its start/end span is not a billing cadence
 * (it can include multiple months or a promotion). With only that old end date,
 * estimate the next boundary on a monthly calendar, anchored to its UTC day/time.
 * Clamp short months without losing the original day in subsequent months.
 * Missing or malformed dates remain unknown; never manufacture an anchor.
 * Swift's existing mirror is pinned by shared/codex-renewal-vectors.json.
 */
export function resolveChatGptRenewalDate(
  activeUntil: string | undefined,
  now: Date,
): string | undefined {
  if (!activeUntil) return activeUntil;
  const until = new Date(activeUntil);
  if (!Number.isFinite(until.getTime()) || !Number.isFinite(now.getTime())) return activeUntil;
  if (until > now) return activeUntil;

  const monthlyBoundary = (months: number): Date => {
    const candidate = new Date(until);
    candidate.setUTCDate(1);
    candidate.setUTCMonth(until.getUTCMonth() + months);
    const monthEnd = new Date(candidate);
    monthEnd.setUTCMonth(candidate.getUTCMonth() + 1, 0);
    candidate.setUTCDate(Math.min(until.getUTCDate(), monthEnd.getUTCDate()));
    return candidate;
  };
  const months = Math.max(1,
    (now.getUTCFullYear() - until.getUTCFullYear()) * 12 + now.getUTCMonth() - until.getUTCMonth());
  const candidate = monthlyBoundary(months);
  return (candidate > now ? candidate : monthlyBoundary(months + 1)).toISOString();
}

function authNamespace(payload?: Record<string, unknown> | null): Record<string, unknown> | undefined {
  const candidate = payload?.['https://api.openai.com/auth'];
  return candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : undefined;
}

export function readCodexAuthStatus(): CodexAuthStatus | null {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    if (!fs.existsSync(authPath)) return null;

    const raw = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, any>;
    const authMode = stringField(raw.auth_mode);
    const tokens = raw.tokens && typeof raw.tokens === 'object' ? raw.tokens as Record<string, unknown> : {};
    const accessPayload = decodeJwtPayload(stringField(tokens.access_token));
    const idPayload = decodeJwtPayload(stringField(tokens.id_token));
    const accessAuth = authNamespace(accessPayload);
    const idAuth = authNamespace(idPayload);

    const planType = stringField(
      raw.chatgpt_plan_type,
      accessAuth?.chatgpt_plan_type,
      idAuth?.chatgpt_plan_type,
      accessPayload?.chatgpt_plan_type,
      idPayload?.chatgpt_plan_type,
      accessPayload?.plan_type,
      idPayload?.plan_type,
    );
    const accountId = stringField(
      raw.chatgpt_account_id,
      accessAuth?.chatgpt_account_id,
      idAuth?.chatgpt_account_id,
      accessPayload?.chatgpt_account_id,
      idPayload?.chatgpt_account_id,
      accessAuth?.account_id,
      idAuth?.account_id,
      accessPayload?.account_id,
      idPayload?.account_id,
      raw.account_id,
    );
    const subscriptionActiveUntilRaw = stringField(
      raw.chatgpt_subscription_active_until,
      accessAuth?.chatgpt_subscription_active_until,
      idAuth?.chatgpt_subscription_active_until,
      accessPayload?.chatgpt_subscription_active_until,
      idPayload?.chatgpt_subscription_active_until,
      accessPayload?.subscription_active_until,
      idPayload?.subscription_active_until,
    );
    // Future reported dates win; expired snapshots get a monthly estimate.
    const subscriptionActiveUntil = resolveChatGptRenewalDate(
      subscriptionActiveUntilRaw,
      new Date(),
    );

    return {
      authMode,
      webAuthConnected: authMode === 'chatgpt' && typeof tokens.access_token === 'string' && tokens.access_token.length > 0,
      planType,
      accountId,
      subscriptionActiveUntil,
      lastRefreshAt: stringField(raw.last_refresh),
    };
  } catch {
    return null;
  }
}
