// Claude API wrapper: turns the account's numbers into a media buyer's read.
// Raw fetch rather than the npm SDK because this extension has no build step.

import { getLocal, STORAGE_KEYS } from './storage.js';
import { formatValue } from './utils.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';

export class AiError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
  }
}

// The persona. Written to force specifics: this analyst cites campaign names
// and numbers, and never pads the answer with generic marketing advice.
function systemPrompt(language) {
  const output = language === 'pt-BR'
    ? 'Escreva em português do Brasil.'
    : 'Write in English.';

  return `You are a senior performance marketing strategist who has personally managed over $200M in Meta Ads spend across direct response, lead generation and e-commerce. You have run agencies, in-house teams and your own offers. You have seen every way an account can quietly bleed money.

You are looking at a live snapshot of one ad account. Give the read you would give a client paying you a retainer.

How you work:
- Lead with the single most important thing you see. Not a summary of the data, a judgement.
- Cite exact campaign names and exact numbers. "Campaign X is at $47 cost per booking against an account average of $31" beats "some campaigns are underperforming".
- Rank actions by money at stake. What to kill, what to scale, what to leave alone.
- Say when the data is too thin to conclude anything. Low spend or low volume means noise, and pretending otherwise costs the client money.
- If something looks structurally wrong (no conversions tracked, a campaign eating budget with zero results, frequency climbing past 3), say so plainly.

What you never do:
- Never open with a restatement of the numbers you were given. They can already see those.
- Never give generic advice that would apply to any account ("test more creatives", "monitor performance closely", "consider A/B testing").
- Never hedge every sentence. Commit to a call and be clear about your confidence.
- Never invent metrics you were not given. If ROAS is zero because purchase tracking is missing, say that rather than treating it as a real ROAS of zero.

Format: short markdown. Use ## for at most three section headings, bold for campaign names and key numbers, and tight bullets. No preamble, no sign-off, no offer to help further. Aim for under 400 words. ${output}`;
}

// Compact brief: only aggregate numbers, no personal data ever leaves the browser
function buildBrief({ account, range, currency, insights, campaigns, bookingEvent }) {
  const money = (v) => formatValue(v, 'currency', currency);
  const int = (v) => formatValue(v, 'integer');

  const lines = [
    `Ad account: ${account.name} (${currency})`,
    `Date range: ${range.since} to ${range.until}`,
    `Booking event tracked as: ${bookingEvent || 'schedule'}`,
    '',
    'ACCOUNT TOTALS',
    `Spend: ${money(insights.spend)}`,
    `Impressions: ${int(insights.impressions)}`,
    `Clicks: ${int(insights.clicks)}`,
    `CTR: ${formatValue(insights.ctr, 'percent')}`,
    `CPC: ${money(insights.cpc)}`,
    `CPM: ${money(insights.cpm)}`,
    `Reach: ${int(insights.reach)}`,
    `Frequency: ${formatValue(insights.frequency, 'decimal')}`,
    `Bookings: ${int(insights.bookings)}`,
    `Cost per booking: ${money(insights.cost_per_booking)}`,
    `ROAS: ${formatValue(insights.roas, 'multiplier')}`,
    ''
  ];

  if (campaigns.length) {
    lines.push('ACTIVE CAMPAIGNS (paused and archived are not included)');
    for (const c of [...campaigns].sort((a, b) => (b.spend || 0) - (a.spend || 0))) {
      const budget = c.daily_budget
        ? `, daily budget ${money(Number(c.daily_budget) / 100)}`
        : c.lifetime_budget
          ? `, lifetime budget ${money(Number(c.lifetime_budget) / 100)}`
          : '';
      lines.push(
        `- ${c.name} [${c.objective || 'unknown objective'}]${budget}: ` +
        `spend ${money(c.spend)}, bookings ${int(c.bookings)}, ` +
        `cost/booking ${c.bookings ? money(c.cost_per_booking) : 'no bookings'}, ` +
        `CTR ${formatValue(c.ctr, 'percent')}, CPC ${money(c.cpc)}, ` +
        `impressions ${int(c.impressions)}, frequency ${formatValue(c.frequency, 'decimal')}`
      );
    }
  } else {
    lines.push('ACTIVE CAMPAIGNS: none with delivery in this period.');
  }

  return lines.join('\n');
}

// Streams the analysis. onDelta receives text chunks as they arrive.
export async function analyzeAccount(context, onDelta) {
  const apiKey = await getLocal(STORAGE_KEYS.ANTHROPIC_KEY);
  if (!apiKey) {
    throw new AiError('No Anthropic API key saved. Add one in Settings.', { code: 'no-key' });
  }

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required for requests originating from a browser context
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        // Adaptive thinking: the model decides how much reasoning the read needs
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system: systemPrompt(context.language),
        messages: [{ role: 'user', content: buildBrief(context) }],
        stream: true
      })
    });
  } catch (e) {
    throw new AiError('Network error while calling the Claude API.', { code: 'network' });
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = body.error || {};
    if (res.status === 401) {
      throw new AiError('Invalid Anthropic API key. Check it in Settings.', { code: 'auth' });
    }
    if (res.status === 429) {
      throw new AiError('Anthropic rate limit reached. Try again shortly.', { code: 'rate' });
    }
    throw new AiError(err.message || `Claude API error (HTTP ${res.status}).`, { code: 'api' });
  }

  return consumeStream(res, onDelta);
}

// Parses the SSE stream, forwarding text deltas as they land
async function consumeStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let refused = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;   // partial or non-JSON keepalive
        }

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          full += event.delta.text;
          onDelta?.(event.delta.text);
        } else if (event.type === 'message_delta' && event.delta?.stop_reason === 'refusal') {
          refused = true;
        } else if (event.type === 'error') {
          throw new AiError(event.error?.message || 'Claude API stream error.', { code: 'api' });
        }
      }
    }
  }

  if (refused && !full.trim()) {
    throw new AiError('Claude declined to analyze this request.', { code: 'refusal' });
  }
  return full;
}
