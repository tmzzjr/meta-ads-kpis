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

/* ---------- Campaign / ad set / ad hierarchy ---------- */

// Metadata fields. Budgets come back in the currency's minor units (cents).
const NODE_FIELDS = 'id,name,status,effective_status,daily_budget,lifetime_budget';

// Fetches insights for one level and merges them into the metadata nodes.
// The two calls are separate because /insights never returns status or budget.
async function withInsights(nodes, parentPath, level, { since, until }) {
  let rows = [];
  try {
    rows = await paginate(`${parentPath}/insights`, {
      fields: `${level}_id,${INSIGHTS_FIELDS}`,
      time_range: { since, until },
      level,
      limit: 200
    });
  } catch (e) {
    // Metadata is still useful even when insights fail (for example, no delivery)
    rows = [];
  }
  const prefs = await getPreferences();
  const byId = new Map(
    rows.map(r => [r[`${level}_id`], aggregateInsights([r], prefs.bookingActionType)])
  );
  return nodes.map(n => ({ ...n, ...(byId.get(n.id) || emptyInsights()) }));
}

export async function getCampaigns(accountId, range) {
  // Active only: paused, archived and draft campaigns are never fetched
  const nodes = await paginate(`/${accountId}/campaigns`, {
    fields: `${NODE_FIELDS},objective`,
    effective_status: ['ACTIVE'],
    limit: 200
  });
  return withInsights(nodes, `/${accountId}`, 'campaign', range);
}

// Account-level totals collapse every campaign into one action set, so a single
// detected event misses campaigns optimizing for something else. Resolve the
// result per campaign — the way Ads Manager does — and add them up.
// Includes campaigns that are no longer active but did deliver in the period.
export async function getResultsTotal(accountId, { since, until }) {
  const rows = await paginate(`/${accountId}/insights`, {
    fields: 'campaign_id,actions',
    time_range: { since, until },
    level: 'campaign',
    limit: 500
  });

  const prefs = await getPreferences();
  let total = 0;
  for (const row of rows) {
    const actions = row.actions || [];
    const configured = countBookings(actions, prefs.bookingActionType);
    total += configured || detectResultAction(actions).count;
  }
  return total;
}

export async function getAdSets(campaignId, range) {
  const nodes = await paginate(`/${campaignId}/adsets`, {
    fields: `${NODE_FIELDS},optimization_goal`,
    limit: 200
  });
  return withInsights(nodes, `/${campaignId}`, 'adset', range);
}

export async function getAds(adsetId, range) {
  const nodes = await paginate(`/${adsetId}/ads`, {
    fields: 'id,name,status,effective_status',
    limit: 200
  });
  return withInsights(nodes, `/${adsetId}`, 'ad', range);
}

/* ---------- Write operations (require ads_management) ---------- */

// POST to the Graph API. Kept separate from request() because writes send the
// parameters as a form body rather than in the query string.
async function post(path, params = {}) {
  const accessToken = await getLocal(STORAGE_KEYS.ACCESS_TOKEN);
  if (!accessToken) throw new MetaApiError('Missing access token. Sign in again.');

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));
  body.set('access_token', accessToken);

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: 'POST', body });
  } catch (e) {
    throw new MetaApiError('Network error while calling the Meta API.', { status: 0 });
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const err = json.error || {};
    throw new MetaApiError(err.message || `HTTP ${res.status}`, {
      status: res.status,
      code: err.code,
      subcode: err.error_subcode,
      type: err.type,
      fbtraceId: err.fbtrace_id
    });
  }
  return json;
}

// Pause or resume a campaign, ad set or ad (same endpoint shape for all three)
export function setEntityStatus(id, status) {
  return post(`/${id}`, { status });
}

// Budget must be sent in minor units (cents), as an integer
export function setEntityBudget(id, field, minorUnits) {
  return post(`/${id}`, { [field]: Math.round(minorUnits) });
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

  // Prefer the configured event; if it matches nothing, fall back to detecting
  // the campaign's actual result the way Ads Manager reports it
  let bookings = countBookings(allActions, bookingType);
  let bookings_source = bookings > 0 ? bookingType : '';
  if (!bookings) {
    const detected = detectResultAction(allActions);
    bookings = detected.count;
    bookings_source = detected.type;
  }
  const cost_per_booking = bookings > 0 ? spend / bookings : 0;
  const roas = spend > 0 && purchaseValue > 0 ? purchaseValue / spend : 0;

  return {
    spend, impressions, clicks, reach,
    ctr, cpc, cpm, frequency,
    conversions, bookings, cost_per_booking, roas,
    bookings_source,
    purchase_value: purchaseValue
  };
}

// Delivery and engagement actions are never "the result" of a conversion
// campaign, so they are excluded from auto-detection
const NON_RESULT_ACTIONS = new Set([
  'link_click', 'landing_page_view', 'post_engagement', 'page_engagement',
  'video_view', 'post_reaction', 'comment', 'like', 'photo_view', 'post',
  'onsite_conversion.post_save', 'onsite_conversion.messaging_conversation_started_7d'
]);

// Picks the action that represents the campaign's result. Conversion actions
// win over engagement, and among those the highest count is the one Ads
// Manager surfaces as "Results" for a conversion objective. This is what makes
// custom conversions (offsite_conversion.custom.<id>) work without any setup.
function detectResultAction(actions) {
  const candidates = actions.filter(a => {
    const type = String(a.action_type || '').toLowerCase();
    if (!type || NON_RESULT_ACTIONS.has(type)) return false;
    return type.startsWith('offsite_conversion')
      || type.startsWith('onsite_conversion')
      || type.includes('lead')
      || type.includes('purchase')
      || type.includes('schedule')
      || type.includes('complete_registration')
      || type.includes('submit_application')
      || type.includes('contact')
      || type.includes('subscribe')
      || type.includes('start_trial');
  });

  if (!candidates.length) return { count: 0, type: '' };

  // Prefer the most specific namespaced entry over a bare aggregate of the
  // same thing, then the largest count
  const best = candidates.sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0))[0];
  return { count: Number(best.value) || 0, type: String(best.action_type) };
}

// Counts the configured booking event. Meta reports the same conversion under
// several action_type spellings (a bare "schedule" plus prefixed variants like
// "offsite_conversion.fb_pixel_custom.schedule"), so summing every match would
// double count. Prefer the exact match; only fall back to the prefixed ones.
function countBookings(actions, bookingType) {
  if (!bookingType) return 0;
  const want = String(bookingType).toLowerCase();
  const total = (list) => list.reduce((acc, a) => acc + (Number(a.value) || 0), 0);

  // Exact match wins, and stops here so the aggregate is not double counted
  const exact = actions.filter(a => String(a.action_type).toLowerCase() === want);
  if (exact.length) return total(exact);

  // Otherwise match the trailing segment. Meta namespaces pixel conversions as
  // offsite_conversion.fb_pixel_schedule and onsite ones as
  // onsite_conversion.schedule, so compare the last dotted segment and allow
  // the underscore-prefixed form ("fb_pixel_schedule" ends with "_schedule").
  const matches = actions.filter(a => {
    const type = String(a.action_type || '').toLowerCase();
    if (!type) return false;
    const tail = type.split('.').pop();
    return tail === want || tail.endsWith('_' + want);
  });
  return total(matches);
}

// Merges per-account insight objects into a single total, recomputing every
// derived metric from the summed base values instead of averaging ratios.
// Note: reach is summed, so it double counts people reached by more than one
// account; frequency inherits that approximation.
export function combineInsights(list) {
  const sum = (field) => list.reduce((acc, r) => acc + (Number(r?.[field]) || 0), 0);

  const spend = sum('spend');
  const impressions = sum('impressions');
  const clicks = sum('clicks');
  const reach = sum('reach');
  const bookings = sum('bookings');
  const conversions = sum('conversions');
  const purchase_value = sum('purchase_value');

  return {
    spend, impressions, clicks, reach, bookings, conversions, purchase_value,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
    frequency: reach > 0 ? impressions / reach : 0,
    cost_per_booking: bookings > 0 ? spend / bookings : 0,
    roas: spend > 0 && purchase_value > 0 ? purchase_value / spend : 0
  };
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
