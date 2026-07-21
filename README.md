# Meta Ads KPIs Dashboard

Chrome extension (Manifest V3) that shows configurable Facebook/Meta Ads campaign
KPIs in a compact popup. No build step, no external dependencies: just load the
folder in Chrome.

---

## Folder structure

```
Meta Extension/
├── manifest.json          # Manifest V3
├── background.js          # Service worker (auto refresh)
├── popup.html             # Main UI
├── popup.css              # Design tokens + styles (dark by default)
├── popup.js               # UI orchestration + range calendar
├── options.html           # Settings page
├── options.css            # Settings styles
├── options.js             # Settings logic + drag-and-drop
├── lib/
│   ├── api.js             # Meta Marketing API v19.0 wrapper
│   ├── storage.js         # chrome.storage.local/sync helpers
│   └── utils.js           # Formatting, dates and derived math
├── assets/
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
└── README.md
```

---

## Install in developer mode

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Pin the icon to the toolbar if you like.

Works in any recent Chromium browser (Chrome, Edge, Brave, Arc).

---

## Getting a Meta access token

You need a **User Access Token** (or System User Token) with permission to read
Ads data. The simplest path is the Graph API Explorer:

1. Open <https://developers.facebook.com/tools/explorer/>.
2. Under **Meta App**, pick a *Business* app (or create one at
   <https://developers.facebook.com/apps/>).
3. Under **User or Page**, choose **User Access Token**.
4. Click **Generate Access Token** and grant the permissions below.
5. Copy the token and paste it into the extension.

> Tokens from the Graph API Explorer expire in about an hour. For longer use,
> exchange it for a *long-lived token*:
> <https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived>
> In production, prefer a Business Manager *System User token*, which does not expire.

### Required API permissions

| Permission             | Why                                                      |
| ---------------------- | -------------------------------------------------------- |
| `ads_read`             | List accounts (`/me/adaccounts`) and read campaigns.      |
| `read_insights`        | Access the `/act_{id}/insights` endpoint.                 |
| `ads_management`       | **Required** to pause/resume and to edit budgets.         |
| `business_management`* | Needed if the account belongs to a Business Manager.      |

\* Optional, depends on the account setup.

Without `ads_management` the dashboard still works, but every switch and budget
edit fails with a permissions error from Meta.

---

## Browser permissions

Declared in `manifest.json`:

- `storage` — stores tokens (`chrome.storage.local`) and preferences (`chrome.storage.sync`).
- `alarms` — schedules the background auto refresh.
- `host_permissions: https://graph.facebook.com/*` — calls the Graph API.
- `host_permissions: https://api.anthropic.com/*` — calls the Claude API for the
  AI analyst. Only reached when you press **Analyze account**.

The extension does **not** read the pages you visit and does **not** inject
scripts into websites. Your Meta token goes only to `graph.facebook.com`, and
your Anthropic key goes only to `api.anthropic.com`. Neither is ever sent
anywhere else.

**What the AI analyst sends.** Pressing **Analyze account** sends aggregate
numbers to Anthropic: account name and currency, the date range, the KPI totals,
and one line per active campaign (name, objective, budget, spend, bookings, CTR,
CPC, impressions, frequency). No customer data, audience data, creative, or Meta
token is included. Nothing is sent until you press the button.

---

## Usage

1. Paste your access token on first run.
2. Pick an ad account from the dropdown.
3. Choose a date range. Preset chips (Today, 7 days, 30 days, and so on) apply
   instantly. **Custom** opens a calendar where the first click sets the start
   date and the second sets the end, applying automatically. There is no apply button.
4. KPIs render as cards, with the campaign list below sorted by spend. Each
   campaign row has a bar proportional to the top spender.
5. Press **Analyze account** for the AI analyst: a senior media buyer's read on
   the current numbers, streamed as it is written. Requires an Anthropic API key
   in Settings; see the limitations below for what that costs.
6. Open ⚙ **Settings** to:
   - choose which KPIs are visible;
   - reorder them by drag-and-drop;
   - set a preferred currency;
   - pick a theme (auto/light/dark);
   - enable auto refresh every N minutes;
   - remove the stored token (sign out).

Settings save automatically, with no save button.

The ▲/▼ indicators compare the current period against the **previous period** of
equal length (for example, last 7 days vs. the 7 days before). For KPIs where
lower is better (CPC, CPM, Cost per Result, Frequency), green means a drop.

---

## Known limitations

- **Token expiry.** Short-lived Explorer tokens expire in about an hour and the
  extension does not refresh them. Use a long-lived or system user token.
- **Empty results look like zeros.** If the selected account had no delivery in
  the period, the API returns an empty set and every KPI renders as 0. That is
  not an error. Check the selected account and the date range first.
- **Daily Spend.** "Today's Spend" is an extra `insights` call scoped to today.
  Meta itself can take a few minutes to report intraday data.
- **ROAS.** Only computed when `action_values` include `purchase`. Campaigns
  without a pixel or Conversions API show `0.00x`.
- **Conversions.** Without `purchase`, the extension sums `offsite_conversion`,
  `lead` and `complete_registration`. For custom definitions, edit
  `aggregateInsights` in `lib/api.js`.
- **Rate limits.** Apps with many large accounts may hit Meta's limits. The
  extension handles codes `4`/`17` with a friendly message but does not
  implement exponential retry.
- **Auto refresh floor.** Chrome enforces a 1 minute minimum for `chrome.alarms`,
  so smaller values are rounded up.
- **No automated tests.** The API layer is simple enough to inspect by hand, but
  testing across currencies and account timezones is recommended.
- **The AI analyst bills your own Anthropic account.** It runs Claude Opus 4.8
  with adaptive thinking at medium effort. A typical analysis costs a few cents;
  a large account with many campaigns costs more, because every active campaign
  is one line of input. There is no spending cap in the extension, so set limits
  in the Anthropic console if that matters.
- **The analyst only sees what the dashboard sees.** Active campaigns only, one
  date range, no ad set or ad detail, no historical trend beyond the previous
  period. It cannot see your creative, your landing pages, or your CRM, so treat
  its read as a starting point rather than a verdict.
- **Write actions are immediate.** Switches and budget edits hit the Meta API
  right away, with no confirmation step and no undo. They affect live campaigns
  and real spend. A failed change reverts the switch and shows the API error.
- **Budgets are per level.** A campaign using campaign budget optimization holds
  the budget at the campaign level and its ad sets show none, and vice versa.
  The extension only offers editing where a budget actually exists.
- **Aggregate view across currencies.** "All accounts" sums every account. When
  they do not share a currency the money totals mix units, and the popup warns
  about it. Reach is summed too, so people reached by several accounts are
  counted more than once, which also affects frequency.

---

## Development

There is no build step. Edit the files and click **Reload** on
`chrome://extensions/`. Use the popup DevTools (right click the popup →
*Inspect*) and the service worker console (on `chrome://extensions/`, click
*service worker* under the extension).

Note: UI strings are in English; inline code comments are in Portuguese.
