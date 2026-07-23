// Deep analysis: gather the full account tree (with creative copy), hand it to
// the local traffic-manager agent, and apply the actions it recommends.
//
// The in-browser analyst (ai.js) reads account + campaign totals. This one
// walks down to ads and their creative, which is why it runs against a local
// server: more data, a heavier model call, and the key stays off the client.

import {
  getAdSets, getAdsWithCreatives, setEntityStatus, setEntityBudget
} from './api.js';

// Bounds so a big account doesn't fire hundreds of Graph calls. We drill only
// where money actually is: top campaigns/ad sets by spend, and skip anything
// that never delivered in the period.
const LIMITS = { campaigns: 12, adsetsPerCampaign: 6, adsPerAdset: 6 };

const spent = (n) => (Number(n?.spend) || 0) > 0;
const bySpend = (a, b) => (Number(b.spend) || 0) - (Number(a.spend) || 0);

// Builds the { account, totals, campaigns:[{...adsets:[{...ads:[{...creative}]}]}] }
// payload the server expects. onProgress(done, total) drives the popup meter.
export async function gatherDeepDataset({ account, range, currency, totals, campaigns }, onProgress) {
  const active = campaigns.filter(spent).sort(bySpend).slice(0, LIMITS.campaigns);

  let done = 0;
  const total = active.length || 1;

  const richCampaigns = [];
  for (const c of active) {
    const adsets = (await getAdSets(c.id, range))
      .filter(spent)
      .sort(bySpend)
      .slice(0, LIMITS.adsetsPerCampaign);

    // Ads (with creative) for each ad set, fetched in parallel per campaign
    const withAds = await Promise.all(
      adsets.map(async (a) => ({
        ...slimNode(a),
        ads: (await getAdsWithCreatives(a.id, range))
          .filter(spent)
          .sort(bySpend)
          .slice(0, LIMITS.adsPerAdset)
          .map(slimAd)
      }))
    );

    richCampaigns.push({ ...slimNode(c), adsets: withAds });
    onProgress?.(++done, total);
  }

  return {
    account: { id: account.id, name: account.name },
    range,
    currency,
    bookingEvent: totals.bookings_source || '',
    totals: slimInsights(totals),
    campaigns: richCampaigns
  };
}

// Keep only what the agent reasons over — drop UI-only and redundant fields to
// keep the payload (and the token bill) lean.
function slimNode(n) {
  return {
    id: n.id,
    name: n.name,
    objective: n.objective,
    optimization_goal: n.optimization_goal,
    daily_budget: n.daily_budget,
    lifetime_budget: n.lifetime_budget,
    ...slimInsights(n)
  };
}

function slimAd(ad) {
  return { id: ad.id, name: ad.name, creative: ad.creative, ...slimInsights(ad) };
}

function slimInsights(n) {
  const pick = (k) => (n[k] == null ? null : Number(n[k]));
  return {
    spend: pick('spend'),
    bookings: pick('bookings'),
    cost_per_booking: pick('cost_per_booking'),
    ctr: pick('ctr'),
    cpc: pick('cpc'),
    cpm: pick('cpm'),
    reach: pick('reach'),
    frequency: pick('frequency'),
    roas: pick('roas')
  };
}

// Sends the dataset to the analyst server. Returns { headline, findings }.
export async function requestDeepAnalysis(serverUrl, dataset, language) {
  const url = `${serverUrl.replace(/\/$/, '')}/api/analyze`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...dataset, language })
    });
  } catch (e) {
    throw new DeepAnalysisError(
      `Could not reach the analyst server at ${serverUrl}. Is it running?`,
      { code: 'offline' }
    );
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new DeepAnalysisError(body.detail || body.error || `Server error (HTTP ${res.status}).`, {
      code: 'server'
    });
  }
  return res.json();
}

// Executes a single finding's recommended action against the Meta API. The
// caller is responsible for confirming with the user first — nothing here is
// gated, on purpose, so the confirmation lives next to the button.
export async function applyFinding(action) {
  switch (action.type) {
    case 'pause':
      await setEntityStatus(action.target_id, 'PAUSED');
      return 'Paused';
    case 'reduce_budget':
    case 'scale_budget':
      if (!action.budget_field || action.new_budget_major == null) {
        throw new DeepAnalysisError('This budget action is missing its target.', { code: 'bad-action' });
      }
      // Meta wants minor units (cents) as an integer
      await setEntityBudget(action.target_id, action.budget_field, action.new_budget_major * 100);
      return 'Budget updated';
    default:
      throw new DeepAnalysisError('This finding has no automated action.', { code: 'no-action' });
  }
}

export class DeepAnalysisError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'DeepAnalysisError';
    this.code = code;
  }
}
