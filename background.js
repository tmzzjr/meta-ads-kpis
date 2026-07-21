// Service worker da extensão (MV3).
// Responsável por agendar o auto-refresh dos insights via chrome.alarms.
// Como o popup só roda quando aberto, o "refresh" aqui realiza a chamada
// e mantém o cache atualizado para a próxima abertura do popup.

import { getPreferences, getLocal, setLocal, STORAGE_KEYS } from './lib/storage.js';
import { getAccountInsights } from './lib/api.js';
import { DATE_PRESETS } from './lib/utils.js';

const ALARM_NAME = 'meta-ads-auto-refresh';

// Reagenda o alarme com base na preferência atual
async function rescheduleAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  const prefs = await getPreferences();
  const minutes = Number(prefs.autoRefreshMinutes) || 0;
  if (minutes <= 0) return;
  // O Chrome impõe mínimo de 1 minuto para alarmes em extensões.
  const periodInMinutes = Math.max(1, minutes);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: periodInMinutes, periodInMinutes });
}

// Executa o refresh em background (sem UI)
async function backgroundRefresh() {
  try {
    const token = await getLocal(STORAGE_KEYS.ACCESS_TOKEN);
    const account = await getLocal(STORAGE_KEYS.SELECTED_ACCOUNT);
    if (!token || !account) return;
    const prefs = await getPreferences();
    const presetKey = prefs.defaultDatePreset || 'last_7d';
    const def = DATE_PRESETS[presetKey];
    const range = def?.range ? def.range() : DATE_PRESETS.last_7d.range();
    const data = await getAccountInsights(account.id, range);
    await setLocal(STORAGE_KEYS.LAST_INSIGHTS, {
      account_id: account.id,
      range,
      data,
      fetched_at: Date.now()
    });
  } catch (e) {
    // Silenciar em background; o popup mostrará erro detalhado se a chamada falhar lá também
    console.warn('Auto-refresh falhou:', e?.message || e);
  }
}

// Eventos do ciclo de vida do service worker
chrome.runtime.onInstalled.addListener(() => rescheduleAlarm());
chrome.runtime.onStartup.addListener(() => rescheduleAlarm());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) backgroundRefresh();
});

// O popup envia esta mensagem quando o usuário salva novas preferências
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'preferences-updated') {
    rescheduleAlarm().then(() => sendResponse({ ok: true }));
    return true; // mantém o canal aberto até a Promise resolver
  }

  // Troca/refresh do token OAuth do Claude.
  // Roda aqui no service worker porque o endpoint de token rejeita origem de
  // página ("Disallowed CORS origin"); o worker faz a chamada com as
  // host_permissions da extensão, sem a checagem de CORS da página.
  if (msg?.type === 'oauth-token') {
    fetch(msg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.payload)
    })
      .then(async (r) => sendResponse({ ok: r.ok, status: r.status, body: await r.text() }))
      .catch((e) => sendResponse({ ok: false, status: 0, body: String(e?.message || e) }));
    return true;
  }
});
