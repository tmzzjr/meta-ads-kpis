// Claude OAuth (PKCE) — the same flow Chronos uses, and the same one behind
// `claude setup-token`: the user authorizes on claude.ai and pastes back the
// code, which we exchange for an access token used as a Bearer credential.
//
// Falls back to a plain API key when OAuth is not an option.

import { getLocal, setLocal, removeLocal, STORAGE_KEYS } from './storage.js';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';   // public Claude Code client
const AUTH_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REDIRECT = 'https://console.anthropic.com/oauth/code/callback';
const SCOPES = 'org:create_api_key user:profile user:inference';

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Builds the authorize URL and stashes the PKCE verifier for the exchange
export async function beginAuthorization() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = b64url(new Uint8Array(digest));

  await setLocal(STORAGE_KEYS.OAUTH_VERIFIER, verifier);

  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier
  });
  return `${AUTH_URL}?${params}`;
}

// Exchanges the pasted code for tokens. The console hands back "code#state".
export async function exchangeCode(pasted) {
  const verifier = await getLocal(STORAGE_KEYS.OAUTH_VERIFIER);
  if (!verifier) throw new Error('Start the authorization first.');

  const [code, state] = String(pasted).trim().split('#');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: code.trim(),
      state: state || verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_verifier: verifier
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Authorization failed (${res.status}). ${text.slice(0, 140)}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error('No access token in the response.');

  await saveTokens(data);
  await removeLocal(STORAGE_KEYS.OAUTH_VERIFIER);
}

async function saveTokens(data) {
  const previous = (await getLocal(STORAGE_KEYS.ANTHROPIC_AUTH)) || {};
  await setLocal(STORAGE_KEYS.ANTHROPIC_AUTH, {
    mode: 'oauth',
    token: data.access_token,
    refresh_token: data.refresh_token || previous.refresh_token || '',
    expires_at: Date.now() + Number(data.expires_in || 3600) * 1000
  });
}

// Swaps the refresh token for a fresh access token. Returns false if it can't.
export async function refreshToken() {
  const auth = await getLocal(STORAGE_KEYS.ANTHROPIC_AUTH);
  if (!auth?.refresh_token) return false;

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: auth.refresh_token,
        client_id: CLIENT_ID
      })
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (!data.access_token) return false;
    await saveTokens(data);
    return true;
  } catch {
    return false;
  }
}

// Saves a manually pasted API key instead of going through OAuth
export async function saveApiKey(key) {
  await setLocal(STORAGE_KEYS.ANTHROPIC_AUTH, { mode: 'key', token: key });
}

export async function clearAuth() {
  await removeLocal(STORAGE_KEYS.ANTHROPIC_AUTH);
  await removeLocal(STORAGE_KEYS.OAUTH_VERIFIER);
}

// Current credential, refreshed when it is close to expiring.
// Returns null when nothing is connected.
export async function getAuth() {
  let auth = await getLocal(STORAGE_KEYS.ANTHROPIC_AUTH);

  // Carry over a key saved before OAuth existed
  if (!auth) {
    const legacy = await getLocal(STORAGE_KEYS.ANTHROPIC_KEY);
    if (legacy) {
      auth = { mode: 'key', token: legacy };
      await setLocal(STORAGE_KEYS.ANTHROPIC_AUTH, auth);
    }
  }
  if (!auth?.token) return null;

  // Refresh a minute ahead of expiry so a long analysis doesn't die mid-stream
  if (auth.mode === 'oauth' && auth.expires_at && Date.now() > auth.expires_at - 60_000) {
    if (await refreshToken()) auth = await getLocal(STORAGE_KEYS.ANTHROPIC_AUTH);
  }
  return auth;
}

// Request headers for the Messages API, per credential type
export function authHeaders(auth) {
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  if (auth.mode === 'oauth') {
    headers['Authorization'] = `Bearer ${auth.token}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  } else {
    headers['x-api-key'] = auth.token;
  }
  return headers;
}
