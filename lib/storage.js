// Helpers para chrome.storage.local (dados sensíveis) e chrome.storage.sync (preferências)

// Chaves usadas nos storages
export const STORAGE_KEYS = {
  // local: dados sensíveis e cache
  ACCESS_TOKEN: 'access_token',
  SELECTED_ACCOUNT: 'selected_account', // { id, name, currency }
  ACCOUNTS_CACHE: 'accounts_cache',
  LAST_INSIGHTS: 'last_insights',
  // action_types seen in the last insights call, used to populate the booking event picker
  AVAILABLE_ACTIONS: 'available_actions',
  // sync: preferências do usuário
  PREFERENCES: 'preferences'
};

// Preferências padrão; reordenamento por drag-and-drop usa este array como base
export const DEFAULT_PREFERENCES = {
  // Ordem dos cards (a ordem importa para o drag-and-drop)
  kpiOrder: [
    'spend', 'daily_spend', 'impressions', 'clicks',
    'ctr', 'cpc', 'cpm', 'reach',
    'frequency', 'cost_per_booking', 'roas'
  ],
  // Quais cards estão habilitados
  kpiEnabled: {
    spend: true,
    daily_spend: true,
    impressions: true,
    clicks: true,
    ctr: true,
    cpc: true,
    cpm: true,
    reach: true,
    frequency: true,
    cost_per_booking: true,
    roas: true
  },
  // Which Meta action_type counts as a "booking". Varies per pixel setup,
  // so it is configurable; "schedule" is Meta's standard appointment event.
  bookingActionType: 'schedule',
  // Moeda preferida para exibição; se vazio usa a moeda da conta
  preferredCurrency: '',
  // Auto-refresh em minutos (0 desliga)
  autoRefreshMinutes: 0,
  // Tema: 'auto' segue o sistema; 'light' ou 'dark' fixos
  theme: 'auto',
  // Período padrão ao abrir o popup
  defaultDatePreset: 'last_7d'
};

// Recupera valor do storage local
export async function getLocal(key) {
  const result = await chrome.storage.local.get(key);
  return result[key];
}

// Salva valor no storage local
export async function setLocal(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// Remove chave do storage local
export async function removeLocal(key) {
  await chrome.storage.local.remove(key);
}

// Recupera as preferências do storage sync (com merge dos padrões)
export async function getPreferences() {
  const result = await chrome.storage.sync.get(STORAGE_KEYS.PREFERENCES);
  const prefs = result[STORAGE_KEYS.PREFERENCES] || {};
  return {
    ...DEFAULT_PREFERENCES,
    ...prefs,
    // merge profundo para evitar perder KPIs novos quando o usuário tinha preferências antigas
    kpiEnabled: { ...DEFAULT_PREFERENCES.kpiEnabled, ...(prefs.kpiEnabled || {}) },
    kpiOrder: mergeKpiOrder(DEFAULT_PREFERENCES.kpiOrder, prefs.kpiOrder)
  };
}

// Salva as preferências do usuário
export async function setPreferences(prefs) {
  await chrome.storage.sync.set({ [STORAGE_KEYS.PREFERENCES]: prefs });
}

// Garante que a ordem inclua todos os KPIs padrão (adiciona novos ao final)
function mergeKpiOrder(defaultOrder, userOrder) {
  if (!Array.isArray(userOrder) || userOrder.length === 0) return [...defaultOrder];
  const merged = userOrder.filter(k => defaultOrder.includes(k));
  for (const k of defaultOrder) {
    if (!merged.includes(k)) merged.push(k);
  }
  return merged;
}

// Limpa todos os dados sensíveis (logout)
export async function clearCredentials() {
  await chrome.storage.local.remove([
    STORAGE_KEYS.ACCESS_TOKEN,
    STORAGE_KEYS.SELECTED_ACCOUNT,
    STORAGE_KEYS.ACCOUNTS_CACHE,
    STORAGE_KEYS.LAST_INSIGHTS
  ]);
}
