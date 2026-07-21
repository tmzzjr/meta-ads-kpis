// Settings page: KPI selection/reordering, currency, theme, auto refresh and sign out.
// Everything saves automatically, with no save button.

import {
  getPreferences, setPreferences, DEFAULT_PREFERENCES, clearCredentials,
  getLocal, setLocal, STORAGE_KEYS
} from './lib/storage.js';
import { KPI_DEFINITIONS, DATE_PRESETS, debounce } from './lib/utils.js';
import { getAuth, clearAuth } from './lib/oauth.js';

const $ = (sel) => document.querySelector(sel);

let prefs = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  prefs = await getPreferences();
  applyTheme();
  populateDefaultPreset();
  await populateBookingEvents();
  await renderAuthStatus();
  renderKpiList();
  fillControls();
  bindForm();
}

// Offers the action_types this account actually reports, captured on the last
// insights call, so the booking event never has to be guessed.
async function populateBookingEvents() {
  const select = $('#booking-event');
  const seen = (await getLocal(STORAGE_KEYS.AVAILABLE_ACTIONS)) || [];
  const current = prefs.bookingActionType || 'schedule';
  const options = Array.from(new Set([current, 'schedule', ...seen])).sort();

  select.innerHTML = '';
  for (const key of options) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = key;
    select.appendChild(opt);
  }
  select.value = current;

  if (!seen.length) {
    $('#booking-hint').textContent = 'Open the popup once to load this account’s events.';
  }
}

// Aplica o tema selecionado (dark é o padrão do CSS; .light inverte)
function applyTheme() {
  const setMode = () => {
    if (prefs.theme === 'auto') {
      document.body.classList.toggle('light', !window.matchMedia('(prefers-color-scheme: dark)').matches);
    } else {
      document.body.classList.toggle('light', prefs.theme === 'light');
    }
  };
  setMode();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (prefs.theme === 'auto') setMode();
  });
}

function populateDefaultPreset() {
  const select = $('#default-preset');
  select.innerHTML = '';
  for (const [key, def] of Object.entries(DATE_PRESETS)) {
    if (key === 'custom') continue; // padrão não faz sentido ser custom
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = def.label;
    select.appendChild(opt);
  }
}

// Constrói a lista de KPIs (reorderável + interruptores)
function renderKpiList() {
  const list = $('#kpi-list');
  list.innerHTML = '';
  for (const key of prefs.kpiOrder) {
    const def = KPI_DEFINITIONS[key];
    if (!def) continue;
    const enabled = !!prefs.kpiEnabled[key];
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.key = key;
    li.classList.toggle('off', !enabled);
    li.innerHTML = `
      <span class="handle" aria-hidden="true">⋮⋮</span>
      <span class="kpi-name">${escapeHtml(def.label)}</span>
      <label class="switch" title="${enabled ? 'Hide' : 'Show'}">
        <input type="checkbox" data-key="${key}" ${enabled ? 'checked' : ''} />
        <span class="track"></span>
      </label>
    `;
    list.appendChild(li);
  }
}

// Preenche os controles de exibição a partir das preferências
function fillControls() {
  $('#currency-select').value = prefs.preferredCurrency || '';
  $('#default-preset').value = prefs.defaultDatePreset || 'last_7d';
  $('#auto-refresh').value = prefs.autoRefreshMinutes ?? 0;
  for (const seg of $('#theme-seg').querySelectorAll('.seg')) {
    const active = seg.dataset.theme === (prefs.theme || 'auto');
    seg.classList.toggle('active', active);
    seg.setAttribute('aria-checked', String(active));
  }
  for (const seg of $('#lang-seg').querySelectorAll('.seg')) {
    const active = seg.dataset.lang === (prefs.insightsLanguage || 'en');
    seg.classList.toggle('active', active);
    seg.setAttribute('aria-checked', String(active));
  }
}

// Claude connection state lives in local storage, never in synced preferences
async function renderAuthStatus() {
  const auth = await getAuth();
  const label = !auth
    ? 'Not connected. Connect from the popup.'
    : auth.mode === 'oauth'
      ? 'Connected with your Claude account.'
      : 'Connected with an API key.';
  $('#auth-status').textContent = label;
  $('#disconnect-btn').hidden = !auth;
}

// Drag-and-drop vanilla com base na ordem do DOM
function enableDragAndDrop(list) {
  let dragging = null;

  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    dragging = li;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // alguns navegadores exigem setData para iniciar o drag
    e.dataTransfer.setData('text/plain', li.dataset.key);
  });

  list.addEventListener('dragend', () => {
    if (dragging) dragging.classList.remove('dragging');
    list.querySelectorAll('li.drop-target').forEach(el => el.classList.remove('drop-target'));
    dragging = null;
  });

  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    const target = e.target.closest('li');
    if (!target || target === dragging) return;
    list.querySelectorAll('li.drop-target').forEach(el => el.classList.remove('drop-target'));
    target.classList.add('drop-target');
  });

  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = e.target.closest('li');
    if (!target || !dragging || target === dragging) return;
    const rect = target.getBoundingClientRect();
    const middle = rect.top + rect.height / 2;
    // se o ponteiro está acima do meio, insere antes; caso contrário, depois
    if (e.clientY < middle) {
      list.insertBefore(dragging, target);
    } else {
      list.insertBefore(dragging, target.nextSibling);
    }
    target.classList.remove('drop-target');
    save();
  });
}

function bindForm() {
  const list = $('#kpi-list');
  enableDragAndDrop(list);

  // Interruptores de KPI salvam na hora
  list.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    cb.closest('li').classList.toggle('off', !cb.checked);
    save();
  });

  // Tema aplica e salva imediatamente
  $('#theme-seg').addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    prefs.theme = seg.dataset.theme;
    fillControls();
    applyTheme();
    save();
  });

  // Language segmented control
  $('#lang-seg').addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    prefs.insightsLanguage = seg.dataset.lang;
    fillControls();
    save();
  });

  $('#disconnect-btn').addEventListener('click', async () => {
    if (!confirm('Disconnect Claude? You will need to authorize again.')) return;
    await clearAuth();
    await renderAuthStatus();
    flash('ok', 'Disconnected');
  });

  $('#booking-event').addEventListener('change', save);
  $('#currency-select').addEventListener('change', save);
  $('#default-preset').addEventListener('change', save);
  $('#auto-refresh').addEventListener('input', debounce(save, 500));

  $('#reset-btn').addEventListener('click', resetDefaults);
  $('#logout-btn').addEventListener('click', logout);
}

async function save() {
  // Coleta a ordem e os interruptores a partir do DOM
  const items = Array.from($('#kpi-list').querySelectorAll('li'));
  const kpiOrder = items.map(li => li.dataset.key);
  const kpiEnabled = {};
  for (const li of items) {
    const cb = li.querySelector('input[type="checkbox"]');
    kpiEnabled[li.dataset.key] = !!cb.checked;
  }

  const next = {
    ...prefs,
    kpiOrder,
    kpiEnabled,
    preferredCurrency: $('#currency-select').value,
    bookingActionType: $('#booking-event').value || 'schedule',
    insightsLanguage: prefs.insightsLanguage || 'en',
    theme: prefs.theme || 'auto',
    defaultDatePreset: $('#default-preset').value,
    autoRefreshMinutes: clampInt($('#auto-refresh').value, 0, 120)
  };

  try {
    await setPreferences(next);
    prefs = next;
    flash('ok', 'Saved');

    // Notifica o background para reagendar o auto-refresh, se houver service worker
    chrome.runtime.sendMessage({ type: 'preferences-updated' }).catch(() => { /* ignore */ });
  } catch (e) {
    flash('error', 'Save failed');
  }
}

// Mostra um selo de status que some sozinho
let flashTimer = null;
function flash(kind, text) {
  const el = $('#save-status');
  el.className = `pill ${kind}`;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

async function resetDefaults() {
  if (!confirm('Restore all default settings?')) return;
  prefs = { ...DEFAULT_PREFERENCES };
  await setPreferences(prefs);
  await populateBookingEvents();
  renderKpiList();
  fillControls();
  applyTheme();
  flash('ok', 'Restored');
}

async function logout() {
  if (!confirm('Remove the saved token? You will need to paste it again in the popup.')) return;
  await clearCredentials();
  flash('ok', 'Token removed');
}

function clampInt(value, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
