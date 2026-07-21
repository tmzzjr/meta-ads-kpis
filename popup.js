// Popup logic: login, account selection, date range and KPI rendering.

import {
  STORAGE_KEYS, getLocal, setLocal, getPreferences
} from './lib/storage.js';
import {
  listAdAccounts, validateToken, getAccountInsights, combineInsights,
  getCampaigns, getAdSets, getAds, setEntityStatus, setEntityBudget, MetaApiError
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

  // Campaign tree: expand, pause/resume and budget editing
  $('#campaigns').addEventListener('click', onTreeClick);
  $('#campaigns').addEventListener('change', onTreeToggle);

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
  const topSpend = sorted[0]?.spend || 0;

  for (const c of sorted) {
    root.appendChild(buildNode(c, 'campaign', topSpend));
  }
}

// Builds one row of the campaign > ad set > ad tree
function buildNode(node, level, topSpend) {
  const currency = state.preferences.preferredCurrency
    || node.currency || state.account.currency || 'USD';
  const active = String(node.status || '').toUpperCase() === 'ACTIVE';
  const share = topSpend > 0 ? Math.max(2, ((node.spend || 0) / topSpend) * 100) : 0;

  // A node carries either a daily or a lifetime budget, or none (budget lives
  // on another level, as with campaign budget optimization)
  const field = node.daily_budget ? 'daily_budget'
    : node.lifetime_budget ? 'lifetime_budget' : null;
  const minor = field ? Number(node[field]) || 0 : 0;

  const wrap = document.createElement('div');
  wrap.className = `node level-${level}${active ? '' : ' paused'}`;
  wrap.dataset.id = node.id;
  wrap.dataset.level = level;
  wrap.dataset.currency = currency;
  if (field) wrap.dataset.minor = String(minor);

  const budgetCell = field
    ? `<button class="node-budget" type="button" data-field="${field}" title="Click to edit budget">
         ${formatValue(minor / 100, 'currency', currency)}${field === 'daily_budget' ? '/day' : ''}
       </button>`
    : '<span class="node-budget none"></span>';

  const row = document.createElement('div');
  row.className = 'node-row';
  row.innerHTML = `
    <button class="twisty" type="button" aria-label="Expand"${level === 'ad' ? ' hidden' : ''}>›</button>
    <label class="switch sm" title="${active ? 'Pause' : 'Activate'}">
      <input type="checkbox" ${active ? 'checked' : ''} />
      <span class="track"></span>
    </label>
    <span class="node-name" title="${escapeHtml(node.name || '')}">${escapeHtml(node.name || '(unnamed)')}</span>
    ${budgetCell}
    <span class="node-spend">${formatValue(node.spend, 'currency', currency)}</span>
  `;
  wrap.appendChild(row);

  const children = document.createElement('div');
  children.className = 'node-children';
  children.hidden = true;
  wrap.appendChild(children);

  const bar = document.createElement('div');
  bar.className = 'share';
  bar.style.width = `${share}%`;
  wrap.appendChild(bar);

  return wrap;
}

/* ---------- Campaign tree interactions ---------- */

function onTreeClick(e) {
  const twisty = e.target.closest('.twisty');
  if (twisty) return toggleNode(twisty.closest('.node'));

  const budget = e.target.closest('button.node-budget');
  if (budget) return startBudgetEdit(budget);
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
      const top = sorted[0]?.spend || 0;
      for (const r of sorted) {
        children.appendChild(buildNode({ ...r, currency: wrap.dataset.currency }, childLevel, top));
      }
    }
    children.dataset.loaded = '1';
  } catch (err) {
    children.innerHTML = `<div class="node-error">${escapeHtml(friendlyError(err))}</div>`;
  }
}

// Pause or resume. Reverts the switch if Meta rejects the change.
async function onTreeToggle(e) {
  const cb = e.target.closest('input[type="checkbox"]');
  if (!cb) return;
  const wrap = cb.closest('.node');
  const next = cb.checked ? 'ACTIVE' : 'PAUSED';

  cb.disabled = true;
  try {
    await setEntityStatus(wrap.dataset.id, next);
    wrap.classList.toggle('paused', next === 'PAUSED');
    hideStatus();
  } catch (err) {
    cb.checked = !cb.checked;
    showStatus('error', friendlyError(err));
  } finally {
    cb.disabled = false;
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
      btn.textContent = formatValue(major, 'currency', currency)
        + (field === 'daily_budget' ? '/day' : '');
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
