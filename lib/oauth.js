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

// The token endpoint answers "Disallowed CORS origin" to extension pages, so
// the request is relayed through the service worker, which is not subject to
// the page CORS check. Same reason Chronos does this server-side.
async function postToken(payload) {
  const res = await chrome.runtime.sendMessage({
    type: 'oauth-token',
    url: TOKEN_URL,
    payload
  });

  if (!res) throw new Error('The extension service worker did not respond.');
  if (!res.ok) {
    const detail = String(res.body || '').slice(0, 160);
    throw new Error(res.status
      ? `Authorization failed (${res.status}). ${detail}`
      : `Network error during authorization. ${detail}`);
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error('Unexpected response from the token endpoint.');
  }
  if (!data.access_token) throw new Error('No access token in the response.');
  return data;
}

// Exchanges the pasted code for tokens. The console hands back "code#state".
export async function exchangeCode(pasted) {
  const verifier = await getLocal(STORAGE_KEYS.OAUTH_VERIFIER);
  if (!verifier) throw new Error('Start the authorization first.');

  const [code, state] = String(pasted).trim().split('#');

  const data = await postToken({
    grant_type: 'authorization_code',
    code: code.trim(),
    state: state || verifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_verifier: verifier
  });

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
    const data = await postToken({
      grant_type: 'refresh_token',
      refresh_token: auth.refresh_token,
      client_id: CLIENT_ID
    });
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
