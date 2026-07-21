// Utilitários de formatação, datas e cálculos derivados

// Definição de cada KPI: rótulo, formato e como extraí-lo do payload de insights
export const KPI_DEFINITIONS = {
  spend:           { label: 'Total Spent',      format: 'currency' },
  daily_spend:     { label: "Today's Spend",    format: 'currency' },
  impressions:     { label: 'Impressions',      format: 'integer'  },
  clicks:          { label: 'Clicks',           format: 'integer'  },
  ctr:             { label: 'CTR',              format: 'percent'  },
  cpc:             { label: 'CPC',              format: 'currency' },
  cpm:             { label: 'CPM',              format: 'currency' },
  reach:           { label: 'Reach',            format: 'integer'  },
  frequency:        { label: 'Frequency',        format: 'decimal'  },
  cost_per_booking: { label: 'Cost per Booking', format: 'currency' },
  roas:             { label: 'ROAS',             format: 'multiplier' }
};

// Presets de data: cada um devolve um par {since, until} em formato YYYY-MM-DD
export const DATE_PRESETS = {
  today:        { label: 'Today',        range: () => rangeFromOffsets(0, 0) },
  yesterday:    { label: 'Yesterday',    range: () => rangeFromOffsets(1, 1) },
  last_7d:      { label: 'Last 7 days',  range: () => rangeFromOffsets(6, 0) },
  last_14d:     { label: 'Last 14 days', range: () => rangeFromOffsets(13, 0) },
  last_30d:     { label: 'Last 30 days', range: () => rangeFromOffsets(29, 0) },
  this_month:   { label: 'This month',   range: () => monthRange(0) },
  last_month:   { label: 'Last month',   range: () => monthRange(-1) },
  custom:       { label: 'Custom',       range: null }
};

// Devolve {since, until} usando deslocamentos em dias relativos a hoje
export function rangeFromOffsets(daysSinceStart, daysSinceEnd) {
  const end = new Date();
  end.setDate(end.getDate() - daysSinceEnd);
  const start = new Date();
  start.setDate(start.getDate() - daysSinceStart);
  return { since: toIsoDate(start), until: toIsoDate(end) };
}

// Devolve {since, until} do mês atual (offset 0) ou anterior (offset -1)
export function monthRange(offset) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = offset === 0
    ? now
    : new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  return { since: toIsoDate(start), until: toIsoDate(end) };
}

// Converte Date em string YYYY-MM-DD respeitando o fuso local
export function toIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Calcula o período "anterior" de mesma duração (para comparação)
export function previousRange({ since, until }) {
  const sinceDate = new Date(since + 'T00:00:00');
  const untilDate = new Date(until + 'T00:00:00');
  const diffMs = untilDate - sinceDate;
  const newUntil = new Date(sinceDate.getTime() - 86400000); // dia anterior ao since
  const newSince = new Date(newUntil.getTime() - diffMs);
  return { since: toIsoDate(newSince), until: toIsoDate(newUntil) };
}

// Formata um número conforme o tipo do KPI
export function formatValue(value, format, currency = 'USD') {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const num = Number(value);
  switch (format) {
    case 'currency':
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        maximumFractionDigits: 2
      }).format(num);
    case 'integer':
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(num);
    case 'decimal':
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(num);
    case 'percent':
      // a API já devolve CTR em porcentagem (ex.: 1.23 => 1.23%)
      return `${num.toFixed(2)}%`;
    case 'multiplier':
      return `${num.toFixed(2)}x`;
    default:
      return String(num);
  }
}

// Calcula a variação percentual entre dois valores; null se não der para comparar
export function percentChange(current, previous) {
  const c = Number(current);
  const p = Number(previous);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return ((c - p) / p) * 100;
}

// Para alguns KPIs, "menos é melhor" (custos); o indicador verde/vermelho inverte
const LOWER_IS_BETTER = new Set(['cpc', 'cpm', 'cost_per_booking', 'frequency']);

// Devolve 'up' | 'down' | 'flat' levando em conta se "menos é melhor"
export function trendDirection(kpi, current, previous) {
  const change = percentChange(current, previous);
  if (change === null) return 'flat';
  if (Math.abs(change) < 0.5) return 'flat'; // tolerância
  const positive = change > 0;
  const goodWhenUp = !LOWER_IS_BETTER.has(kpi);
  return positive === goodWhenUp ? 'up' : 'down';
}

// Soma valores de um campo numérico em um array de insights (paginação manual já feita)
export function sumField(rows, field) {
  return rows.reduce((acc, r) => acc + (Number(r[field]) || 0), 0);
}

// Extrai um action_value específico do array "actions" ou "action_values" da API
export function extractAction(actions, type) {
  if (!Array.isArray(actions)) return 0;
  const match = actions.find(a => a.action_type === type);
  return match ? Number(match.value) || 0 : 0;
}

// Aplica debounce simples para evitar múltiplos cliques rápidos
export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
