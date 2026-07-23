// Popup logic: login, account selection, date range and KPI rendering.

import {
  STORAGE_KEYS, getLocal, setLocal, getPreferences, setPreferences
} from './lib/storage.js';
import {
  listAdAccounts, validateToken, getAccountInsights, combineInsights,
  getCampaigns, getAdSets, getAds, getResultsTotal,
  setEntityStatus, setEntityBudget, MetaApiError
} from './lib/api.js';
import {
  KPI_DEFINITIONS, DATE_PRESETS, formatValue, percentChange,
  previousRange, trendDirection, toIsoDate
} from './lib/utils.js';
import { analyzeAccount, AiError } from './lib/ai.js';
import { gatherDeepDataset, requestDeepAnalysis, applyFinding, DeepAnalysisError } from './lib/deep-analysis.js';
import { beginAuthorization, exchangeCode, saveApiKey, getAuth } from './lib/oauth.js';

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

  $('#analyze-btn').addEventListener('click', runAnalysis);

  // Campaign tree: expand, pause/resume and budget editing
  $('#campaigns').addEventListener('click', onTreeClick);

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

  // Aggregate option first, only useful with more than one account
  if (state.accounts.length > 1) {
    const all = document.createElement('option');
    all.value = ALL_ACCOUNTS;
    all.textContent = `All accounts (${state.accounts.length})`;
    select.appendChild(all);
  }

  for (const acc of state.accounts) {
    const opt = document.createElement('option');
    opt.value = acc.id;
    opt.textContent = `${acc.name} · ${acc.account_id} · ${acc.currency}`;
    select.appendChild(opt);
  }
}

// Sentinel id for the aggregate "All accounts" option
const ALL_ACCOUNTS = '__all__';

// Pseudo account representing every account combined. Money can only be summed
// when the accounts share a currency, so flag the mixed case for the UI.
function allAccountsPseudo() {
  const currencies = Array.from(new Set(state.accounts.map(a => a.currency).filter(Boolean)));
  return {
    id: ALL_ACCOUNTS,
    name: 'All accounts',
    currency: currencies.length === 1
      ? currencies[0]
      : (state.preferences.preferredCurrency || 'USD'),
    mixedCurrency: currencies.length > 1
  };
}

// Select the last used account, or the first available one
async function ensureSelectedAccount() {
  if (!state.accounts.length) return;
  const saved = await getLocal(STORAGE_KEYS.SELECTED_ACCOUNT);

  if (saved?.id === ALL_ACCOUNTS && state.accounts.length > 1) {
    state.account = allAccountsPseudo();
  } else {
    const matched = saved && state.accounts.find(a => a.id === saved.id);
    state.account = matched || state.accounts[0];
  }
  $('#account-select').value = state.account.id;
  await setLocal(STORAGE_KEYS.SELECTED_ACCOUNT, state.account);
}

async function onAccountChange(e) {
  const id = e.target.value;
  const acc = id === ALL_ACCOUNTS
    ? allAccountsPseudo()
    : state.accounts.find(a => a.id === id);
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

    // "All accounts" fans out over every account and sums the results
    const targets = state.account.id === ALL_ACCOUNTS ? state.accounts : [state.account];

    const [accountData, prevData, todayData, campaigns] = await Promise.all([
      fetchCombined(targets, range),
      fetchCombined(targets, prev),
      fetchCombined(targets, todayRange),
      fetchCampaigns(targets, range)
    ]);

    accountData.daily_spend = todayData.spend;
    prevData.daily_spend = 0; // today has no meaningful previous period here

    // Results are the sum of each campaign's own result, so mixed-objective
    // accounts total correctly instead of reporting a single detected event
    await Promise.all([
      applyCampaignResults(accountData, targets, range),
      applyCampaignResults(prevData, targets, prev)
    ]);

    state.insights = accountData;
    state.previous = prevData;
    state.campaigns = campaigns;

    hideStatus();
    renderKpis();
    renderCampaigns();
    renderFooter();

    // Summing money across currencies produces a meaningless total, so say so
    if (state.account.mixedCurrency) {
      showStatus('warn', 'These accounts use different currencies. Money totals are not directly comparable.');
    }
  } catch (e) {
    clearKpis();
    showStatus('error', friendlyError(e));
  } finally {
    $('#refresh-btn').classList.remove('spinning');
  }
}

// Replaces the account-level result count with the sum across campaigns, then
// recomputes cost per result from it. Leaves the figure untouched on failure.
async function applyCampaignResults(insights, targets, range) {
  try {
    const results = await Promise.all(targets.map(a => getResultsTotal(a.id, range)));

    const bookings = results.reduce((sum, r) => sum + r.total, 0);
    const kinds = {};
    for (const r of results) {
      for (const [kind, n] of Object.entries(r.kinds)) kinds[kind] = (kinds[kind] || 0) + n;
    }

    insights.bookings = bookings;
    insights.cost_per_booking = bookings > 0 ? insights.spend / bookings : 0;
    insights.result_kind = dominantKind(kinds, bookings);
  } catch {
    /* keep the account-level figure */
  }
}

// Name the card after the conversion when one kind clearly dominates. With a
// genuine mix of objectives, "Results" is the honest label.
function dominantKind(kinds, total) {
  if (!total) return 'result';
  const [top] = Object.entries(kinds).sort((a, b) => b[1] - a[1]);
  if (!top) return 'result';
  return top[1] / total >= 0.8 ? top[0] : 'result';
}

// Plural label for the count card, and the matching cost-per label
const RESULT_LABELS = {
  schedule:     ['Bookings',      'Cost per Booking'],
  lead:         ['Leads',         'Cost per Lead'],
  purchase:     ['Purchases',     'Cost per Purchase'],
  registration: ['Registrations', 'Cost per Registration'],
  application:  ['Applications',  'Cost per Application'],
  trial:        ['Trials',        'Cost per Trial'],
  subscription: ['Subscriptions', 'Cost per Subscription'],
  contact:      ['Contacts',      'Cost per Contact'],
  add_to_cart:  ['Adds to Cart',  'Cost per Add to Cart'],
  conversion:   ['Conversions',   'Cost per Conversion'],
  result:       ['Results',       'Cost per Result']
};

// Overrides the static KPI label with the conversion actually being counted
function kpiLabel(key, def) {
  const pair = RESULT_LABELS[state.insights?.result_kind || 'result'] || RESULT_LABELS.result;
  if (key === 'bookings') return pair[0];
  if (key === 'cost_per_booking') return pair[1];
  return def.label;
}

// One account passes straight through; several are summed
async function fetchCombined(targets, range) {
  if (targets.length === 1) return getAccountInsights(targets[0].id, range);
  const list = await Promise.all(targets.map(a => getAccountInsights(a.id, range)));
  return combineInsights(list);
}

// Campaigns keep their owning account, so the aggregate view stays traceable
async function fetchCampaigns(targets, range) {
  const lists = await Promise.all(targets.map(async (acc) => {
    const rows = await getCampaigns(acc.id, range);
    return rows.map(c => ({ ...c, accountName: acc.name, accountId: acc.id, currency: acc.currency }));
  }));
  return lists.flat();
}

/* ---------- Rendering ---------- */

function clearKpis() {
  $('#kpi-grid').innerHTML = '';
  $('#campaigns').innerHTML = '';
  $('#footer-meta').textContent = '';
  $('#campaign-count').hidden = true;
  $('#ai-panel').hidden = true;   // any prior read is stale once data reloads
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
  $('#ai-panel').hidden = true;   // any prior read is stale once data reloads
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
    card.draggable = true;
    card.dataset.key = key;
    card.innerHTML = `
      <span class="label">${escapeHtml(kpiLabel(key, def))}</span>
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

  enableKpiDrag(grid);
  renderBookingHint();
}

// Drag a KPI card to reorder the grid. The new order is persisted, so it also
// shows up in Settings and survives the next open.
function enableKpiDrag(grid) {
  if (grid.dataset.dragBound) return;   // the grid element is reused across renders
  grid.dataset.dragBound = '1';

  let dragging = null;

  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.kpi-card');
    if (!card) return;
    dragging = card;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.key);
  });

  grid.addEventListener('dragend', () => {
    dragging?.classList.remove('dragging');
    grid.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    dragging = null;
  });

  grid.addEventListener('dragover', (e) => {
    e.preventDefault();
    const target = e.target.closest('.kpi-card');
    if (!target || target === dragging) return;
    grid.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    target.classList.add('drop-target');
  });

  grid.addEventListener('drop', async (e) => {
    e.preventDefault();
    const target = e.target.closest('.kpi-card');
    if (!target || !dragging || target === dragging) return;

    // Insert before or after depending on which half was dropped on
    const rect = target.getBoundingClientRect();
    const after = (e.clientX - rect.left) > rect.width / 2;
    grid.insertBefore(dragging, after ? target.nextSibling : target);
    target.classList.remove('drop-target');

    await persistKpiOrder(grid);
  });
}

// Visible cards carry only the enabled KPIs, so fold the new sequence back
// into the full order without disturbing the hidden ones
async function persistKpiOrder(grid) {
  const visible = [...grid.querySelectorAll('.kpi-card')].map(c => c.dataset.key);
  const next = visible[Symbol.iterator]();

  const merged = state.preferences.kpiOrder.map(key =>
    state.preferences.kpiEnabled[key] ? (next.next().value ?? key) : key
  );

  state.preferences = { ...state.preferences, kpiOrder: merged };
  await setPreferences(state.preferences);
}

// Spend with zero bookings almost always means the configured event name does
// not match what this account reports, so say that instead of showing a silent 0
async function renderBookingHint() {
  const hint = $('#booking-hint');
  const spend = state.insights.spend || 0;
  const bookings = state.insights.bookings || 0;

  if (!spend || bookings > 0) { hint.hidden = true; return; }

  // Still nothing: show what this account actually reports, so the gap is
  // visible instead of being another silent zero
  const seen = (await getLocal(STORAGE_KEYS.AVAILABLE_ACTIONS)) || [];
  const list = seen.length
    ? `This account reports: ${seen.slice(0, 8).map(escapeHtml).join(', ')}${seen.length > 8 ? '…' : ''}.`
    : 'Meta returned no conversion actions at all for this period, which usually means the pixel event is not firing.';

  hint.hidden = false;
  hint.innerHTML = `
    <span><b>No results found.</b> ${list}</span>
    <button type="button" class="btn btn-mini" id="fix-booking">Choose event</button>
  `;
  hint.querySelector('#fix-booking')
      .addEventListener('click', () => chrome.runtime.openOptionsPage());
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

  for (const c of sorted) {
    root.appendChild(buildNode(c, 'campaign'));
  }
}

/* Inline icons, matching the RF Analytics campaign table */
const ICONS = {
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  campaign: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>',
  adset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>',
  ad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L9 18"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>'
};

// Meta reports many effective_status values; collapse them into the three
// delivery states the RF table shows
function deliveryState(node) {
  const eff = String(node.effective_status || node.status || '').toUpperCase();
  if (eff === 'ACTIVE') return 'active';
  if (eff === 'PENDING_REVIEW' || eff === 'IN_PROCESS' || eff === 'PENDING_BILLING_INFO') return 'review';
  return 'paused';
}

const STATE_LABEL = { active: 'Active', paused: 'Paused', review: 'In review' };

// Human subtitle per level, mirroring the RF table's second line
function nodeSubtitle(node, level) {
  if (level === 'campaign') return prettyEnum(node.objective) || 'Campaign';
  if (level === 'adset') return prettyEnum(node.optimization_goal) || 'Ad set';
  return 'Ad';
}

function prettyEnum(v) {
  if (!v) return '';
  return String(v).toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

// Builds one row of the campaign > ad set > ad tree
function buildNode(node, level) {
  const currency = state.preferences.preferredCurrency
    || node.currency || state.account.currency || 'USD';
  const stateName = deliveryState(node);
  const on = stateName === 'active';
  const hasChildren = level !== 'ad';

  // A node carries either a daily or a lifetime budget, or none (budget lives
  // on another level, as with campaign budget optimization)
  const field = node.daily_budget ? 'daily_budget'
    : node.lifetime_budget ? 'lifetime_budget' : null;
  const minor = field ? Number(node[field]) || 0 : 0;

  const wrap = document.createElement('div');
  wrap.className = `node level-${level}${on ? '' : ' paused'}`;
  wrap.dataset.id = node.id;
  wrap.dataset.level = level;
  wrap.dataset.currency = currency;
  if (field) wrap.dataset.minor = String(minor);

  const row = document.createElement('div');
  row.className = `node-row${hasChildren ? ' clickable' : ''}`;
  row.innerHTML = `
    ${hasChildren
      ? `<button class="twisty" type="button" aria-label="Expand">${ICONS.chevron}</button>`
      : `<span class="node-glyph">${ICONS.ad}</span>`}
    <button class="node-switch${on ? ' on' : ''}" type="button"
            ${stateName === 'review' ? 'disabled' : ''}
            aria-pressed="${on}"
            title="${stateName === 'review' ? 'In review' : on ? 'Pause' : 'Activate'}">
      <span class="knob"></span>
    </button>
    <div class="node-title">
      <div class="node-title-line">
        <span class="node-name" title="${escapeHtml(node.name || '')}">${escapeHtml(node.name || '(unnamed)')}</span>
        <span class="status-pill ${stateName}"><span class="dot"></span>${STATE_LABEL[stateName]}</span>
      </div>
      <div class="node-sub">${escapeHtml(nodeSubtitle(node, level))}</div>
    </div>
  `;
  wrap.appendChild(row);

  const metrics = document.createElement('div');
  metrics.className = 'node-metrics';
  metrics.innerHTML = `
    <div class="metric">
      <span class="m-label">Budget</span>
      ${field
        ? `<button class="node-budget" type="button" data-field="${field}" title="Click to edit">
             <span class="amount">${formatValue(minor / 100, 'currency', currency)}</span>
             ${field === 'daily_budget' ? '<span class="unit">/day</span>' : ''}
             <span class="pencil">${ICONS.pencil}</span>
           </button>`
        : '<span class="m-value dash">-</span>'}
    </div>
    ${metricCell('Results', node.bookings ? formatValue(node.bookings, 'integer') : '-')}
    ${metricCell('Cost / result', node.cost_per_booking ? formatValue(node.cost_per_booking, 'currency', currency) : '-', true)}
    ${metricCell('Spent', node.spend ? formatValue(node.spend, 'currency', currency) : '-')}
    ${metricCell('Reach', node.reach ? formatValue(node.reach, 'integer') : '-', true)}
    ${metricCell('CTR', node.ctr ? formatValue(node.ctr, 'percent') : '-', true)}
  `;
  wrap.appendChild(metrics);

  const children = document.createElement('div');
  children.className = 'node-children';
  children.hidden = true;
  wrap.appendChild(children);

  return wrap;
}

function metricCell(label, value, dim = false) {
  return `<div class="metric${dim ? ' dim' : ''}">
    <span class="m-label">${label}</span>
    <span class="m-value">${value}</span>
  </div>`;
}

/* ---------- AI analyst ---------- */

async function runAnalysis() {
  if (!state.insights) return;

  // With a traffic-manager server configured, run the deep analysis (down to
  // ads and creatives) there. Otherwise fall back to the in-browser read.
  const server = (state.preferences.analystServer || '').trim();
  if (server) return runDeepAnalysis(server);

  // Not connected yet: authorize inline instead of sending the user to Settings
  if (!(await getAuth())) return showConnectCard();

  const panel = $('#ai-panel');
  const btn = $('#analyze-btn');
  const label = btn.querySelector('.label');
  panel.hidden = false;
  panel.className = 'ai-panel thinking';
  panel.innerHTML = '<span class="spinner"></span>Reading the account…';
  btn.disabled = true;
  label.textContent = 'Analyzing…';

  let text = '';
  try {
    await analyzeAccount({
      account: state.account,
      range: state.range,
      currency: state.preferences.preferredCurrency || state.account.currency || 'USD',
      insights: state.insights,
      campaigns: state.campaigns,
      bookingEvent: state.preferences.bookingActionType,
      language: state.preferences.insightsLanguage === 'pt-BR' ? 'pt-BR' : 'en'
    }, (chunk) => {
      // First chunk replaces the spinner
      if (!text) panel.className = 'ai-panel';
      text += chunk;
      panel.innerHTML = renderMarkdown(text) + '<span class="caret-blink"></span>';
      panel.scrollIntoView({ block: 'nearest' });
    });

    panel.className = 'ai-panel';
    panel.innerHTML = renderMarkdown(text)
      + `<div class="ai-foot">Claude Opus 4.8 · ${state.range.since} to ${state.range.until} · figures above are from your live account</div>`;
  } catch (e) {
    // A rejected key sends the user straight back to authorizing
    if (e instanceof AiError && (e.code === 'auth' || e.code === 'no-key')) {
      showConnectCard(e.code === 'auth' ? 'That key was rejected. Try another one.' : '');
    } else {
      panel.className = 'ai-panel error';
      panel.textContent = e.message || String(e);
    }
  } finally {
    btn.disabled = false;
    label.textContent = 'Analyze campaigns';
  }
}

/* ---------- Deep analysis (local traffic-manager server) ---------- */

async function runDeepAnalysis(server) {
  const panel = $('#ai-panel');
  const btn = $('#analyze-btn');
  const label = btn.querySelector('.label');
  panel.hidden = false;
  panel.className = 'ai-panel thinking';
  panel.innerHTML = '<span class="spinner"></span>Gathering campaigns, ad sets and creatives…';
  btn.disabled = true;
  label.textContent = 'Analyzing…';

  try {
    const currency = state.preferences.preferredCurrency || state.account.currency || 'USD';
    const dataset = await gatherDeepDataset(
      { account: state.account, range: state.range, currency, totals: state.insights, campaigns: state.campaigns },
      (done, total) => {
        panel.innerHTML = `<span class="spinner"></span>Reading campaigns… ${done}/${total}`;
      }
    );

    panel.innerHTML = '<span class="spinner"></span>The traffic manager is analyzing…';
    const language = state.preferences.insightsLanguage === 'pt-BR' ? 'pt-BR' : 'en';
    const report = await requestDeepAnalysis(server, dataset, language);

    renderFindings(report, currency);
  } catch (e) {
    panel.className = 'ai-panel error';
    if (e instanceof DeepAnalysisError && e.code === 'offline') {
      panel.innerHTML = `${escapeHtml(e.message)}<div class="ai-foot">Start it with <code>node server.js</code> in the Meta Ads Analyst Server folder, or clear the server URL in ⚙ Settings to use the in-browser read.</div>`;
    } else {
      panel.textContent = e.message || String(e);
    }
  } finally {
    btn.disabled = false;
    label.textContent = 'Analyze campaigns';
  }
}

const SEVERITY_LABEL = {
  critical: 'Critical', warning: 'Warning', opportunity: 'Opportunity', ok: 'Healthy'
};

function renderFindings(report, currency) {
  const panel = $('#ai-panel');
  panel.className = 'ai-panel findings';

  const findings = Array.isArray(report.findings) ? report.findings : [];
  const head = report.headline
    ? `<div class="findings-headline">${escapeHtml(report.headline)}</div>`
    : '';

  if (!findings.length) {
    panel.innerHTML = head + '<div class="ai-foot">No findings returned.</div>';
    return;
  }

  const cards = findings.map((f, i) => {
    const sev = SEVERITY_LABEL[f.severity] ? f.severity : 'warning';
    const stake = f.money_at_stake && f.money_at_stake !== '—'
      ? `<span class="finding-stake">${escapeHtml(f.money_at_stake)}</span>` : '';
    const where = f.entity?.name
      ? `<span class="finding-where">${escapeHtml(prettyEnum(f.entity.level))} · ${escapeHtml(f.entity.name)}</span>`
      : '';

    const canApply = ['pause', 'reduce_budget', 'scale_budget'].includes(f.action?.type) && f.action?.target_id;
    const applyBtn = canApply
      ? `<button class="btn btn-mini finding-apply" data-idx="${i}">${escapeHtml(f.action.label || 'Apply')}</button>`
      : (f.action?.type === 'creative'
          ? `<span class="finding-hint">${escapeHtml(f.action.label || 'Needs a new creative')}</span>`
          : '');

    return `
      <div class="finding sev-${sev}" data-idx="${i}">
        <div class="finding-top">
          <span class="finding-sev">${SEVERITY_LABEL[sev]}</span>
          ${stake}
        </div>
        <div class="finding-title">${escapeHtml(f.title || '')}</div>
        <div class="finding-detail">${escapeHtml(f.detail || '')}</div>
        <div class="finding-foot">
          ${where}
          <span class="finding-action">${applyBtn}</span>
        </div>
      </div>`;
  }).join('');

  panel.innerHTML = head + `<div class="findings-list">${cards}</div>`
    + `<div class="ai-foot">Claude Opus 4.8 · traffic-manager agent · ${state.range.since} to ${state.range.until}</div>`;

  // Wire the apply buttons. Each confirms before touching the live account.
  panel.querySelectorAll('.finding-apply').forEach((btn) => {
    btn.addEventListener('click', () => onApplyFinding(btn, findings[Number(btn.dataset.idx)]));
  });
}

async function onApplyFinding(btn, finding) {
  const action = finding.action;
  const summary = action.type === 'pause'
    ? `Pause "${finding.entity.name}"?`
    : `Change budget of "${finding.entity.name}" to ${formatValue(action.new_budget_major, 'currency', state.account.currency || 'USD')}${action.budget_field === 'daily_budget' ? '/day' : ''}?`;
  if (!confirm(summary)) return;

  btn.disabled = true;
  btn.textContent = 'Applying…';
  try {
    const done = await applyFinding(action);
    btn.textContent = `✓ ${done}`;
    btn.classList.add('done');
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Retry';
    btn.title = e.message || String(e);
  }
}

// Claude OAuth (PKCE), the same flow as `claude setup-token`. Kept available,
// but Anthropic currently answers 429 to every code exchange on the public
// client, so the API key path above is the one that works.
function showOAuthCard(notice = '') {
  const panel = $('#ai-panel');
  panel.hidden = false;
  panel.className = 'ai-panel';
  panel.innerHTML = `
    <div class="ai-connect">
      <span class="connect-title">Connect Claude</span>
      ${notice ? `<span class="error">${escapeHtml(notice)}</span>` : ''}
      <ol class="connect-steps">
        <li>
          <span>Authorize this extension on claude.ai and copy the code it gives you.</span>
          <button type="button" class="btn btn-mini" id="open-auth">Authorize with Claude ↗</button>
        </li>
        <li>
          <span>Paste the code back here.</span>
          <div class="connect-row">
            <input type="text" class="input" id="connect-code" placeholder="Paste the code"
                   autocomplete="off" spellcheck="false" />
            <button type="button" class="btn btn-primary" id="connect-btn">Connect</button>
          </div>
        </li>
      </ol>
      <span class="muted">Uses your Claude account. Nothing is stored outside this browser.</span>
      <button type="button" class="linklike" id="use-key">Use an API key instead</button>
    </div>
  `;

  panel.querySelector('#open-auth').addEventListener('click', async () => {
    const btn = panel.querySelector('#open-auth');
    btn.disabled = true;
    try {
      const url = await beginAuthorization();
      chrome.tabs.create({ url });
    } catch (e) {
      showConnectCard(e.message || 'Could not start the authorization.');
    }
  });

  const input = panel.querySelector('#connect-code');
  const connect = async () => {
    const value = input.value.trim();
    if (!value) return;

    const btn = panel.querySelector('#connect-btn');
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    try {
      await exchangeCode(value);
      runAnalysis();
    } catch (e) {
      // A blocked exchange is not worth retrying: route back to the key path
      if (e.code === 'blocked') showConnectCard(e.message);
      else showOAuthCard(e.message || 'Could not complete the authorization.');
    }
  };

  panel.querySelector('#connect-btn').addEventListener('click', connect);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  panel.querySelector('#use-key').addEventListener('click', () => showConnectCard());
  input.focus();
}

// Primary path: an Anthropic API key. This is what works today.
// Collapsed by default; expands when the user asks for an analysis.
function showConnectCard(notice = '', expanded = true) {
  const panel = $('#ai-panel');
  panel.hidden = false;
  panel.className = 'ai-panel';
  panel.innerHTML = `
    <details class="connect-box" ${expanded ? 'open' : ''}>
      <summary>
        <span class="connect-title">Connect Claude</span>
        <span class="summary-note">${notice ? 'action needed' : 'not connected'}</span>
      </summary>
      <div class="ai-connect">
        ${typeof notice === 'string' && notice ? `<span class="error">${escapeHtml(notice)}</span>` : ''}
        <ol class="connect-steps">
          <li>
            <span>Create an API key in the Anthropic console and copy it.</span>
            <button type="button" class="btn btn-mini" id="open-console">Open console ↗</button>
          </li>
          <li>
            <span>Paste it back here.</span>
            <div class="connect-row">
              <input type="password" class="input" id="key-input" placeholder="sk-ant-..."
                     autocomplete="off" spellcheck="false" />
              <button type="button" class="btn btn-primary" id="key-btn">Connect</button>
            </div>
          </li>
        </ol>
        <span class="muted">Stored locally in this browser and sent only to Anthropic. Billed to your own account.</span>
        <button type="button" class="linklike" id="try-oauth">Authorize with a Claude account instead</button>
      </div>
    </details>
  `;

  panel.querySelector('#open-console').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://console.anthropic.com/settings/keys' });
  });

  const input = panel.querySelector('#key-input');
  const connect = async () => {
    const value = input.value.trim();
    if (!value) return;
    await saveApiKey(value);
    runAnalysis();
  };

  panel.querySelector('#key-btn').addEventListener('click', connect);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  panel.querySelector('#try-oauth').addEventListener('click', () => showOAuthCard());
  if (expanded) input.focus();
}

// Minimal markdown: headings, bold and bullets. Escapes first, so model
// output can never inject markup into the popup.
function renderMarkdown(src) {
  const inline = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const out = [];
  let list = null;

  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();

    if (!line) { closeList(); continue; }

    if (/^#{1,6}\s/.test(line)) {
      closeList();
      out.push(`<h3>${inline(line.replace(/^#{1,6}\s*/, ''))}</h3>`);
    } else if (/^[-*]\s+/.test(line)) {
      list = list || [];
      list.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('');

  function closeList() {
    if (!list) return;
    out.push(`<ul>${list.join('')}</ul>`);
    list = null;
  }
}

/* ---------- Campaign tree interactions ---------- */

function onTreeClick(e) {
  // Switch and budget must win over the row's expand handler
  const sw = e.target.closest('.node-switch');
  if (sw) { e.stopPropagation(); return onSwitchClick(sw); }

  const budget = e.target.closest('button.node-budget');
  if (budget) { e.stopPropagation(); return startBudgetEdit(budget); }

  const row = e.target.closest('.node-row.clickable');
  if (row) return toggleNode(row.closest('.node'));
}

// Expands a node, lazily fetching its children the first time
async function toggleNode(wrap) {
  const children = wrap.querySelector(':scope > .node-children');
  const twisty = wrap.querySelector(':scope > .node-row > .twisty');

  if (!children.hidden) {
    children.hidden = true;
    twisty.classList.remove('open');
    return;
  }
  children.hidden = false;
  twisty.classList.add('open');
  if (children.dataset.loaded) return;

  const level = wrap.dataset.level;
  const childLevel = level === 'campaign' ? 'adset' : 'ad';
  children.innerHTML = '<div class="node-loading"><span class="spinner"></span>Loading…</div>';

  try {
    const rows = level === 'campaign'
      ? await getAdSets(wrap.dataset.id, state.range)
      : await getAds(wrap.dataset.id, state.range);

    children.innerHTML = '';
    if (!rows.length) {
      children.innerHTML = `<div class="node-empty">No ${childLevel === 'adset' ? 'ad sets' : 'ads'} here.</div>`;
    } else {
      const sorted = [...rows].sort((a, b) => (b.spend || 0) - (a.spend || 0));
      for (const r of sorted) {
        children.appendChild(buildNode({ ...r, currency: wrap.dataset.currency }, childLevel));
      }
    }
    children.dataset.loaded = '1';
  } catch (err) {
    children.innerHTML = `<div class="node-error">${escapeHtml(friendlyError(err))}</div>`;
  }
}

// Pause or resume. Flips optimistically and rolls back if Meta rejects it.
async function onSwitchClick(btn) {
  const wrap = btn.closest('.node');
  const turningOn = !btn.classList.contains('on');

  btn.disabled = true;
  paintDelivery(wrap, btn, turningOn);

  try {
    await setEntityStatus(wrap.dataset.id, turningOn ? 'ACTIVE' : 'PAUSED');
    hideStatus();
  } catch (err) {
    paintDelivery(wrap, btn, !turningOn);   // roll back
    showStatus('error', friendlyError(err));
  } finally {
    btn.disabled = false;
  }
}

// Keeps switch, row opacity and status pill in sync
function paintDelivery(wrap, btn, on) {
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? 'Pause' : 'Activate';
  wrap.classList.toggle('paused', !on);

  const pill = wrap.querySelector(':scope > .node-row .status-pill');
  if (pill) {
    const name = on ? 'active' : 'paused';
    pill.className = `status-pill ${name}`;
    pill.innerHTML = `<span class="dot"></span>${STATE_LABEL[name]}`;
  }
}

// Inline budget editing: Enter commits, Escape or blur cancels
function startBudgetEdit(btn) {
  const wrap = btn.closest('.node');
  const field = btn.dataset.field;
  const currency = wrap.dataset.currency || 'USD';
  const minor = Number(wrap.dataset.minor) || 0;

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'budget-input';
  input.min = '1';
  input.step = '0.01';
  input.value = minor ? (minor / 100).toFixed(2) : '';

  let settled = false;
  const restore = () => {
    if (settled) return;
    settled = true;
    input.replaceWith(btn);
  };

  input.addEventListener('keydown', async (ev) => {
    if (ev.key === 'Escape') return restore();
    if (ev.key !== 'Enter') return;

    const major = parseFloat(input.value);
    if (!Number.isFinite(major) || major <= 0) return restore();

    settled = true;              // stop blur from racing the commit
    input.disabled = true;
    try {
      await setEntityBudget(wrap.dataset.id, field, major * 100);
      wrap.dataset.minor = String(Math.round(major * 100));
      btn.querySelector('.amount').textContent = formatValue(major, 'currency', currency);
      hideStatus();
    } catch (err) {
      showStatus('error', friendlyError(err));
    }
    input.replaceWith(btn);
  });

  input.addEventListener('blur', restore);

  btn.replaceWith(input);
  input.focus();
  input.select();
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
    const previousBooking = state.preferences?.bookingActionType;
    state.preferences = await getPreferences();
    refreshTheme();

    // Bookings are computed while fetching, so changing the event needs a refetch
    if (state.preferences.bookingActionType !== previousBooking) {
      loadInsights();
      return;
    }
    if (state.insights) {
      renderKpis();
      renderCampaigns();
    }
  }
});
