'use strict';

// Endpoints and client id taken from the Claude Code binary (2.1.x); the same calls it makes
// for /usage, for its account profile and for token refresh.
const API_BASE = 'https://api.anthropic.com';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_BETA = 'oauth-2025-04-20';
const USER_AGENT = 'claude-switcher-vscode/0.1.0';

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }

  // The login itself is no longer valid (as opposed to a network hiccup).
  get isAuth() {
    return this.status === 401 || this.status === 403 || (this.status === 400 && this.body && this.body.error === 'invalid_grant');
  }
}

async function http(url, init = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  let text;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal });
    text = await res.text();
  } catch (e) {
    throw new ApiError(`falha de rede (${e.name === 'AbortError' ? 'timeout' : e.message})`, 0);
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const detail = (body && (body.error_description || (body.error && body.error.message) || body.error)) || text.slice(0, 200);
    throw new ApiError(`HTTP ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, res.status, body);
  }
  return body;
}

function authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': OAUTH_BETA,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
}

// Who owns a token, plus an oauthAccount block shaped like the one Claude Code keeps in
// ~/.claude.json.
async function getProfile(accessToken) {
  const p = await http(`${API_BASE}/api/oauth/profile`, { headers: authHeaders(accessToken) });
  const a = (p && p.account) || {};
  const o = (p && p.organization) || {};
  if (!a.uuid) throw new ApiError('perfil sem uuid da conta', 200, p);
  return {
    accountUuid: a.uuid,
    email: a.email,
    oauthAccount: {
      accountUuid: a.uuid,
      emailAddress: a.email,
      organizationUuid: o.uuid,
      hasExtraUsageEnabled: !!o.has_extra_usage_enabled,
      billingType: o.billing_type ?? null,
      accountCreatedAt: a.created_at,
      subscriptionCreatedAt: o.subscription_created_at,
      displayName: a.display_name,
      fullName: a.full_name,
      organizationName: o.name,
      organizationType: o.organization_type,
      organizationRateLimitTier: o.rate_limit_tier,
      seatTier: o.seat_tier ?? null,
    },
  };
}

async function getUsage(accessToken) {
  return http(`${API_BASE}/api/oauth/usage`, { headers: authHeaders(accessToken) });
}

// Same request body Claude Code sends. The response may rotate the refresh token, so the
// caller must persist the result right away.
async function refreshOAuth(oauth) {
  const body = { grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: CLIENT_ID };
  if (Array.isArray(oauth.scopes) && oauth.scopes.length) body.scope = oauth.scopes.join(' ');
  const d = await http(
    TOKEN_URL,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }, body: JSON.stringify(body) },
    30000,
  );
  if (!d || !d.access_token || !d.expires_in) throw new ApiError('resposta de refresh sem access_token', 200, d);
  const now = Date.now();
  const next = {
    ...oauth,
    accessToken: d.access_token,
    refreshToken: d.refresh_token || oauth.refreshToken,
    expiresAt: now + d.expires_in * 1000,
  };
  if (d.refresh_token_expires_in) next.refreshTokenExpiresAt = now + d.refresh_token_expires_in * 1000;
  if (typeof d.scope === 'string' && d.scope) next.scopes = d.scope.split(' ');
  return next;
}

module.exports = { ApiError, getProfile, getUsage, refreshOAuth };
