// Wrapper da Meta Marketing API v19.0
// Documentação: https://developers.facebook.com/docs/marketing-apis/

import { getLocal, setLocal, getPreferences, STORAGE_KEYS } from './storage.js';
import { extractAction, sumField } from './utils.js';

const API_VERSION = 'v19.0';
const API_BASE = `https://graph.facebook.com/${API_VERSION}`;

// Erro tipado para facilitar tratamento na UI
export class MetaApiError extends Error {
  constructor(message, { status, code, subcode, type, fbtraceId } = {}) {
    super(message);
    this.name = 'MetaApiError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.type = type;
    this.fbtraceId = fbtraceId;
  }
}

// Faz uma requisição autenticada ao Graph; junta access_token ao querystring
async function request(path, params = {}, { token } = {}) {
  const accessToken = token || (await getLocal(STORAGE_KEYS.ACCESS_TOKEN));
  if (!accessToken) throw new MetaApiError('Missing access token. Sign in again.');

  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  url.searchParams.set('access_token', accessToken);

  let res;
  try {
    res = await fetch(url.toString(), { method: 'GET' });
  } catch (e) {
    throw new MetaApiError('Network error while calling the Meta API.', { status: 0 });
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const err = body.error || {};
    throw new MetaApiError(err.message || `HTTP ${res.status}`, {
      status: res.status,
      code: err.code,
      subcode: err.error_subcode,
      type: err.type,
      fbtraceId: err.fbtrace_id
    });
  }
  return body;
}

// Itera por todas as páginas seguindo o cursor "paging.next"
async function paginate(path, params = {}, { maxPages = 10 } = {}) {
  const all = [];
  let next = null;
  let pages = 0;

  let body = await request(path, params);
  while (true) {
    if (Array.isArray(body.data)) all.push(...body.data);
    next = body.paging?.next || null;
    pages++;
    if (!next || pages >= maxPages) break;

    // Para páginas seguintes, fetch direto na URL completa que já contém token e cursor
    const res = await fetch(next).catch(() => null);
    if (!res || !res.ok) break;
    body = await res.json();
    if (body.error) break;
  }
  return all;
}

// Lista todas as ad accounts disponíveis para o token autenticado
export async function listAdAccounts(token) {
  const data = await paginate('/me/adaccounts', {
    fields: 'id,account_id,name,currency,account_status,timezone_name',
    limit: 100
  }, { maxPages: 5 });
  // Filtra apenas contas ativas (status 1) opcionalmente; mantemos todas para visibilidade
  return data.map(a => ({
    id: a.id,                      // ex.: "act_123456"
    account_id: a.account_id,      // ex.: "123456"
    name: a.name,                  // nome amigável
    currency: a.currency,          // ex.: "BRL"
    status: a.account_status,
    timezone: a.timezone_name
  }));
}

// Valida um token chamando /me; lança MetaApiError em caso de problema
export async function validateToken(token) {
  return request('/me', { fields: 'id,name' }, { token });
}

// Campos solicitados ao endpoint de insights para construir todos os KPIs
const INSIGHTS_FIELDS = [
  'spend',
  'impressions',
  'clicks',
  'ctr',
  'cpc',
  'cpm',
  'reach',
  'frequency',
  'actions',
  'action_values'
].join(',');

// Busca insights agregados de uma conta para um período {since, until}
export async function getAccountInsights(accountId, { since, until }) {
  const rows = await paginate(`/${accountId}/insights`, {
    fields: INSIGHTS_FIELDS,
    time_range: { since, until },
    level: 'account',
    limit: 100
  });
  const prefs = await getPreferences();
  await rememberActionTypes(rows);
  return aggregateInsights(rows, prefs.bookingActionType);
}

// Records every action_type the account actually reports, so the settings page
// can offer the real list instead of guessing which event means "booking".
async function rememberActionTypes(rows) {
  const seen = new Set(rows.flatMap(r => (r.actions || []).map(a => a.action_type)));
  if (!seen.size) return;
  const previous = (await getLocal(STORAGE_KEYS.AVAILABLE_ACTIONS)) || [];
  const merged = Array.from(new Set([...previous, ...seen])).sort();
  await setLocal(STORAGE_KEYS.AVAILABLE_ACTIONS, merged);
}

// Busca insights por campanha para o período
export async function getCampaignInsights(accountId, { since, until }) {
  const rows = await paginate(`/${accountId}/insights`, {
    fields: `campaign_id,campaign_name,${INSIGHTS_FIELDS}`,
    time_range: { since, until },
    level: 'campaign',
    limit: 100
  });
  const prefs = await getPreferences();
  return rows.map(r => ({
    id: r.campaign_id,
    name: r.campaign_name,
    ...aggregateInsights([r], prefs.bookingActionType)
  }));
}

// Reduz um array de insights (pode ter mais de uma linha em casos raros) em um único objeto
function aggregateInsights(rows, bookingType = 'schedule') {
  if (!rows.length) {
    return emptyInsights();
  }
  const spend       = sumField(rows, 'spend');
  const impressions = sumField(rows, 'impressions');
  const clicks      = sumField(rows, 'clicks');
  const reach       = sumField(rows, 'reach');

  // Métricas derivadas (calculadas a partir dos totais quando há agregação)
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const cpc = clicks > 0 ? spend / clicks : 0;
  const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
  const frequency = reach > 0 ? impressions / reach : 0;

  // Conversões = soma de "purchase" se existir, senão usa total de "actions"
  const allActions = rows.flatMap(r => r.actions || []);
  const allActionValues = rows.flatMap(r => r.action_values || []);
  const purchases = extractAction(allActions, 'purchase');
  const purchaseValue = extractAction(allActionValues, 'purchase');
  const conversions = purchases > 0
    ? purchases
    : sumActionTypes(allActions, ['offsite_conversion', 'lead', 'complete_registration']);

  const bookings = countBookings(allActions, bookingType);
  const cost_per_booking = bookings > 0 ? spend / bookings : 0;
  const roas = spend > 0 && purchaseValue > 0 ? purchaseValue / spend : 0;

  return {
    spend, impressions, clicks, reach,
    ctr, cpc, cpm, frequency,
    conversions, bookings, cost_per_booking, roas,
    purchase_value: purchaseValue
  };
}

// Counts the configured booking event. Meta reports the same conversion under
// several action_type spellings (a bare "schedule" plus prefixed variants like
// "offsite_conversion.fb_pixel_custom.schedule"), so summing every match would
// double count. Prefer the exact match; only fall back to the prefixed ones.
function countBookings(actions, bookingType) {
  if (!bookingType) return 0;
  const exact = actions.filter(a => a.action_type === bookingType);
  if (exact.length) {
    return exact.reduce((acc, a) => acc + (Number(a.value) || 0), 0);
  }
  const suffix = '.' + bookingType;
  return actions
    .filter(a => typeof a.action_type === 'string' && a.action_type.endsWith(suffix))
    .reduce((acc, a) => acc + (Number(a.value) || 0), 0);
}

// Soma valores de várias action_types
function sumActionTypes(actions, types) {
  return actions
    .filter(a => types.includes(a.action_type))
    .reduce((acc, a) => acc + (Number(a.value) || 0), 0);
}

// Objeto vazio para quando não há dados (evita NaN na UI)
function emptyInsights() {
  return {
    spend: 0, impressions: 0, clicks: 0, reach: 0,
    ctr: 0, cpc: 0, cpm: 0, frequency: 0,
    conversions: 0, bookings: 0, cost_per_booking: 0, roas: 0, purchase_value: 0
  };
}
