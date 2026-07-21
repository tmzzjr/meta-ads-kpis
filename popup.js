// Popup logic: login, account selection, date range and KPI rendering.

import {
  STORAGE_KEYS, getLocal, setLocal, getPreferences
} from './lib/storage.js';
import {
  listAdAccounts, validateToken, getAccountInsights, getCampaignInsights, MetaApiError
} from './lib/api.js';
import {
  KPI_DEFINITIONS, DATE_PRESETS, formatValue, percentChange,
  previousRange, trendDirection, toIsoDate
} from './lib/utils.js';

// In-memory popup state (not persisted between popup openings)
const state = {
  token: null,
  accounts: [],
  account: null,         // { id, name, currency }
  preset: 'last_7d',
  range: null,           // { since, until }
  preferences: null,
  insights: null,        // current period data
  previous: null,        // previous period data, for comparison
  campaigns: []
};

// Calendar state for the custom range picker
const cal = {
  view: null,      // Date pointing at the first day of the visible month
  start: null,     // Date | null
  end: null,       // Date | null
  open: false
};

const $ = (sel) => document.querySelector(sel);

document.addEventListener('DOMContentLoaded', init);

async function init() {
  applyTheme();
  bindEvents();

  state.preferences = await getPreferences();
  refreshTheme();
  state.token = await getLocal(STORAGE_KEYS.ACCESS_TOKEN);

  if (!state.token) {
    showView('login');
    return;
  }
  showView('main');

  renderPresetChips();
  setPreset(state.preferences.defaultDatePreset || 'last_7d');

  await loadAccounts({ fromCacheFirst: true });
  await loadInsights();
}

/* ---------- Theme ---------- */

function applyTheme() {
  // Dark is the CSS default; the .light class flips to the light theme
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  document.body.classList.toggle('light', !mql.matches);
  mql.addEventListener('change', (e) => {
    if (state.preferences?.theme === 'auto') {
      document.body.classList.toggle('light', !e.matches);
    }
  });
}

function refreshTheme() {
  const pref = state.preferences?.theme || 'auto';
  if (pref === 'auto') {
    document.body.classList.toggle('light', !window.matchMedia('(prefers-color-scheme: dark)').matches);
  } else {
    document.body.classList.toggle('light', pref === 'light');
  }
}

/* ---------- Events ---------- */

function bindEvents() {
  $('#login-btn').addEventListener('click', handleLogin);
  $('#token-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
  });
  $('#refresh-btn').addEventListener('click', () => loadInsights());
  $('#options-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#reload-accounts-btn').addEventListener('click', () => loadAccounts({ fromCacheFirst: false }));
  $('#account-select').addEventListener('change', onAccountChange);

  // Preset chips apply immediately, no apply button
  $('#preset-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) setPreset(chip.dataset.preset, { reload: true });
  });

  // Calendar popover
  $('#range-trigger').addEventListener('click', toggleCalendar);
  $('#cal-prev').addEventListener('click', () => shiftMonth(-1));
  $('#cal-next').addEventListener('click', () => shiftMonth(1));
  $('#cal-reset').addEventListener('click', resetCalendarSelection);
  $('#cal-grid').addEventListener('click', onDayClick);

  // Close the calendar when clicking outside of it
  document.addEventListener('click', (e) => {
    if (!cal.open) return;
    if (e.target.closest('#calendar') || e.target.closest('#range-trigger')) return;
    closeCalendar();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cal.open) closeCalendar();
  });
}

function showView(name) {
  $('#view-login').hidden = name !== 'login';
  $('#view-main').hidden = name !== 'main';
}

/* ---------- Login ---------- */

async function handleLogin() {
  const input = $('#token-input');
  const errEl = $('#login-error');
  errEl.hidden = true;
  const token = input.value.trim();
  if (!token) {
    errEl.textContent = 'Enter an access token.';
    errEl.hidden = false;
    return;
  }
  setBusy($('#login-btn'), true, 'Validating…');
  try {
    // Validate with a simple /me call
    await validateToken(token);
    await setLocal(STORAGE_KEYS.ACCESS_TOKEN, token);
    state.token = token;
    input.value = '';
    showView('main');

    renderPresetChips();
    setPreset(state.preferences.defaultDatePreset || 'last_7d');

    await loadAccounts({ fromCacheFirst: false });
    await loadInsights();
  } catch (e) {
    errEl.textContent = friendlyError(e);
    errEl.hidden = false;
  } finally {
    setBusy($('#login-btn'), false, 'Sign in');
  }
}

/* ---------- Accounts ---------- */

async function loadAccounts({ fromCacheFirst }) {
  const select = $('#account-select');
  select.innerHTML = '<option>Loading…</option>';

  // Try the cache first for an instant render
  if (fromCacheFirst) {
    const cached = await getLocal(STORAGE_KEYS.ACCOUNTS_CACHE);
    if (Array.isArray(cached) && cached.length) {
      state.accounts = cached;
      renderAccountOptions();
      await ensureSelectedAccount();
    }
  }

  // Always refetch in the background to stay current
  try {
    const fresh = await listAdAccounts();
    state.accounts = fresh;
    await setLocal(STORAGE_KEYS.ACCOUNTS_CACHE, fresh);
    renderAccountOptions();
    await ensureSelectedAccount();
  } catch (e) {
    if (!state.accounts.length) {
      select.innerHTML = '<option>None</option>';
      showStatus('error', friendlyError(e));
    }
  }
}

function renderAccountOptions() {
  const select = $('#account-select');
  if (!state.accounts.length) {
    select.innerHTML = '<option>No accounts found</option>';
    return;
  }
  select.innerHTML = '';
  for (const acc of state.accounts) {
    const opt = document.createElement('option');
    opt.value = acc.id;
    opt.textContent = `${acc.name} · ${acc.account_id} · ${acc.currency}`;
    select.appendChild(opt);
  }
}

// Select the last used account, or the first available one
async function ensureSelectedAccount() {
  if (!state.accounts.length) return;
  const saved = await getLocal(STORAGE_KEYS.SELECTED_ACCOUNT);
  const matched = saved && state.accounts.find(a => a.id === saved.id);
  state.account = matched || state.accounts[0];
  $('#account-select').value = state.account.id;
  await setLocal(STORAGE_KEYS.SELECTED_ACCOUNT, state.account);
}

async function onAccountChange(e) {
  const id = e.target.value;
  const acc = state.accounts.find(a => a.id === id);
  if (!acc) return;
  state.account = acc;
  await setLocal(STORAGE_KEYS.SELECTED_ACCOUNT, acc);
  await loadInsights();
}

/* ---------- Date presets ---------- */

// Short labels so the chips stay on one line
const CHIP_LABELS = {
  today: 'Today',
  yesterday: 'Yesterday',
  last_7d: '7 days',
  last_14d: '14 days',
  last_30d: '30 days',
  this_month: 'This month',
  last_month: 'Last month',
  custom: 'Custom'
};

function renderPresetChips() {
  const root = $('#preset-chips');
  root.innerHTML = '';
  for (const key of Object.keys(DATE_PRESETS)) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.dataset.preset = key;
    chip.setAttribute('role', 'tab');
    chip.textContent = CHIP_LABELS[key] || DATE_PRESETS[key].label;
    root.appendChild(chip);
  }
}

// Select a preset, update the chips and reload (no apply button)
function setPreset(key, { reload = false } = {}) {
  if (!DATE_PRESETS[key]) key = 'last_7d';
  state.preset = key;

  for (const chip of $('#preset-chips').querySelectorAll('.chip')) {
    const active = chip.dataset.preset === key;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-selected', String(active));
  }

  const isCustom = key === 'custom';
  $('#custom-range').hidden = !isCustom;
  if (!isCustom) {
    closeCalendar();
    if (reload) loadInsights();
    return;
  }

  // Seed the picker with the current range and open it
  const base = state.range || DATE_PRESETS.last_7d.range();
  cal.start = parseIsoDate(base.since);
  cal.end = parseIsoDate(base.until);
  cal.view = startOfMonth(cal.end || new Date());
  updateRangeLabel();
  if (reload) openCalendar();
}

/* ---------- Calendar range picker ---------- */

function toggleCalendar(e) {
  e.stopPropagation();
  cal.open ? closeCalendar() : openCalendar();
}

function openCalendar() {
  cal.open = true;
  $('#calendar').hidden = false;
  $('#range-trigger').classList.add('open');
  if (!cal.view) cal.view = startOfMonth(cal.end || new Date());
  renderCalendar();
}

function closeCalendar() {
  cal.open = false;
  $('#calendar').hidden = true;
  $('#range-trigger').classList.remove('open');
}

function shiftMonth(delta) {
  cal.view = new Date(cal.view.getFullYear(), cal.view.getMonth() + delta, 1);
  renderCalendar();
}

function resetCalendarSelection() {
  cal.start = null;
  cal.end = null;
  updateRangeLabel();
  renderCalendar();
}

// Builds the visible month grid, including the leading/trailing days
function renderCalendar() {
  const grid = $('#cal-grid');
  const view = cal.view;
  const today = stripTime(new Date());

  $('#cal-title').textContent = view.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  $('#cal-hint').textContent = !cal.start || cal.end
    ? 'Pick a start date'
    : 'Now pick an end date';

  // Start the grid on the Sunday on or before the 1st of the month
  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());

  grid.innerHTML = '';
  for (let i = 0; i < 42; i++) {
    const day = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cal-day';
    btn.textContent = day.getDate();
    btn.dataset.date = toIsoDate(day);

    if (day.getMonth() !== view.getMonth()) btn.classList.add('outside');
    if (sameDay(day, today)) btn.classList.add('today');
    // Meta has no data for the future
    if (day > today) btn.classList.add('disabled');

    // Range highlighting
    const { start, end } = orderedSelection();
    if (start && end) {
      if (day > start && day < end) btn.classList.add('in-range');
      if (sameDay(day, start) || sameDay(day, end)) {
        btn.classList.add('edge');
        if (sameDay(start, end)) btn.classList.add('solo');
        else if (sameDay(day, start)) btn.classList.add('start');
        else btn.classList.add('end');
      }
    } else if (start && sameDay(day, start)) {
      btn.classList.add('edge', 'solo');
    }

    grid.appendChild(btn);
  }
}

function onDayClick(e) {
  const btn = e.target.closest('.cal-day');
  if (!btn || btn.classList.contains('disabled')) return;
  const day = parseIsoDate(btn.dataset.date);

  // First click (or restarting) sets the start; second click closes the range
  if (!cal.start || cal.end) {
    cal.start = day;
    cal.end = null;
    renderCalendar();
    updateRangeLabel();
    return;
  }

  cal.end = day;
  renderCalendar();
  updateRangeLabel();

  // Both ends picked: apply right away and close
  const { start, end } = orderedSelection();
  state.range = { since: toIsoDate(start), until: toIsoDate(end) };
  closeCalendar();
  loadInsights();
}

// Selection can be made backwards, so normalize before using it
function orderedSelection() {
  if (cal.start && cal.end && cal.end < cal.start) {
    return { start: cal.end, end: cal.start };
  }
  return { start: cal.start, end: cal.end };
}

function updateRangeLabel() {
  const label = $('#range-label');
  const { start, end } = orderedSelection();
  if (start && end) {
    label.textContent = `${prettyDate(start)} to ${prettyDate(end)}`;
  } else if (start) {
    label.textContent = `${prettyDate(start)} to …`;
  } else {
    label.textContent = 'Pick a date range';
  }
}

function prettyDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function parseIsoDate(s) {
  // Parse as local time to avoid the UTC off-by-one shift
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function stripTime(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function sameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Resolve the active range from the selected preset
function resolveRange() {
  if (state.preset === 'custom') {
    return state.range || DATE_PRESETS.last_7d.range();
  }
  const def = DATE_PRESETS[state.preset];
  return def?.range ? def.range() : DATE_PRESETS.last_7d.range();
}

/* ---------- Insights ---------- */

async function loadInsights() {
  if (!state.account) return;
  const range = resolveRange();
  state.range = range;

  hideStatus();
  renderSkeleton();
  $('#refresh-btn').classList.add('spinning');

  try {
    // Current and previous periods in parallel, for the trend arrows.
    // "daily_spend" needs one extra call scoped to today.
    const prev = previousRange(range);
    const todayRange = DATE_PRESETS.today.range();

    const [accountData, prevData, todayData, campaigns] = await Promise.all([
      getAccountInsights(state.account.id, range),
      getAccountInsights(state.account.id, prev),
      getAccountInsights(state.account.id, todayRange),
      getCampaignInsights(state.account.id, range)
    ]);

    accountData.daily_spend = todayData.spend;
    prevData.daily_spend = 0; // today has no meaningful previous period here

    state.insights = accountData;
    state.previous = prevData;
    state.campaigns = campaigns;

    hideStatus();
    renderKpis();
    renderCampaigns();
    renderFooter();
  } catch (e) {
    clearKpis();
    showStatus('error', friendlyError(e));
  } finally {
    $('#refresh-btn').classList.remove('spinning');
  }
}

/* ---------- Rendering ---------- */

function clearKpis() {
  $('#kpi-grid').innerHTML = '';
  $('#campaigns').innerHTML = '';
  $('#footer-meta').textContent = '';
  $('#campaign-count').hidden = true;
}

// Animated placeholders while insights load
function renderSkeleton() {
  const grid = $('#kpi-grid');
  const count = state.preferences.kpiOrder.filter(k => state.preferences.kpiEnabled[k]).length || 6;
  grid.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const card = document.createElement('div');
    card.className = 'kpi-card skeleton';
    card.innerHTML = `
      <div class="skeleton-line sm"></div>
      <div class="skeleton-line lg"></div>
      <div class="skeleton-line sm"></div>
    `;
    grid.appendChild(card);
  }
  $('#campaigns').innerHTML = '';
  $('#campaign-count').hidden = true;
}

function renderKpis() {
  const grid = $('#kpi-grid');
  grid.innerHTML = '';
  const prefs = state.preferences;
  const currency = prefs.preferredCurrency || state.account.currency || 'USD';

  for (const key of prefs.kpiOrder) {
    if (!prefs.kpiEnabled[key]) continue;
    const def = KPI_DEFINITIONS[key];
    if (!def) continue;
    const value = state.insights[key];
    const prev  = state.previous?.[key];
    const change = percentChange(value, prev);
    const dir = trendDirection(key, value, prev);

    const card = document.createElement('div');
    card.className = 'kpi-card';
    card.innerHTML = `
      <span class="label">${escapeHtml(def.label)}</span>
      <span class="value">${formatValue(value, def.format, currency)}</span>
      <span class="trend ${dir}">
        <span class="arrow">${dir === 'up' ? '▲' : dir === 'down' ? '▼' : '●'}</span>
        ${change === null
          ? '<span class="vs">no comparison</span>'
          : `${Math.abs(change).toFixed(1)}% <span class="vs">vs. previous</span>`}
      </span>
    `;
    grid.appendChild(card);
  }
}

function renderCampaigns() {
  const root = $('#campaigns');
  const countPill = $('#campaign-count');
  root.innerHTML = '';

  if (!state.campaigns.length) {
    countPill.hidden = true;
    const empty = document.createElement('div');
    empty.className = 'status empty';
    empty.textContent = 'No campaigns with data in this period.';
    root.appendChild(empty);
    return;
  }

  countPill.textContent = state.campaigns.length;
  countPill.hidden = false;

  // Sort by spend, descending
  const sorted = [...state.campaigns].sort((a, b) => (b.spend || 0) - (a.spend || 0));
  const currency = state.preferences.preferredCurrency || state.account.currency || 'USD';
  const topSpend = sorted[0]?.spend || 0;

  for (const c of sorted) {
    // Bar relative to the top spender, to compare campaigns at a glance
    const share = topSpend > 0 ? Math.max(2, ((c.spend || 0) / topSpend) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'campaign';
    row.innerHTML = `
      <span class="name" title="${escapeHtml(c.name)}">${escapeHtml(c.name || '(unnamed)')}</span>
      <span class="spend">${formatValue(c.spend, 'currency', currency)}</span>
      <div class="meta">
        <span>Impr <b>${formatValue(c.impressions, 'integer')}</b></span>
        <span>Clicks <b>${formatValue(c.clicks, 'integer')}</b></span>
        <span>CTR <b>${formatValue(c.ctr, 'percent')}</b></span>
        <span>CPC <b>${formatValue(c.cpc, 'currency', currency)}</b></span>
      </div>
      <div class="share" style="width:${share}%"></div>
    `;
    root.appendChild(row);
  }
}

function renderFooter() {
  const r = state.range;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  $('#footer-meta').textContent = `${r.since} → ${r.until} · updated at ${hh}:${mm}`;
}

/* ---------- Visual states ---------- */

function showStatus(type, message) {
  const el = $('#status');
  el.className = `status ${type}`;
  el.innerHTML = (type === 'loading' ? '<span class="spinner"></span>' : '') + escapeHtml(message);
  el.hidden = false;
}

function hideStatus() {
  $('#status').hidden = true;
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.textContent = label;
}

/* ---------- Helpers ---------- */

// Friendly messages for the common API failures
function friendlyError(e) {
  if (!(e instanceof MetaApiError)) return e.message || String(e);
  if (e.code === 190) return 'Token invalid or expired. Open ⚙ Settings to replace it.';
  if (e.code === 17 || e.code === 4) return 'Rate limit reached. Try again in a few minutes.';
  if (e.code === 100) return `Invalid query parameter. ${e.message}`;
  return e.message || 'Unknown Meta API error.';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// React to preference changes made in the options page
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'sync' && changes[STORAGE_KEYS.PREFERENCES]) {
    state.preferences = await getPreferences();
    refreshTheme();
    if (state.insights) {
      renderKpis();
      renderCampaigns();
    }
  }
});
