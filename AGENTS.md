# AGENTS.md — maintainer & agent guide

This file is for anyone (human or AI) maintaining this project. The user-facing
docs are in [`README.md`](README.md); this is the "how the machine actually
works and what will break" version.

## What this project is

A single **browser bookmarklet** that reads your HP Instant Ink printing history
from HP's own dashboard API (using your already-logged-in browser session) and
renders an annual + monthly "pages printed" report as an in-page modal.

There is **no backend, no build-time secret, no dependency**. The whole program
is one file: [`bookmarklet.src.js`](bookmarklet.src.js). Everything else is
build tooling and docs.

## Repo layout

| Path | What it is |
| --- | --- |
| `bookmarklet.src.js` | **The program.** Readable source; edit this. |
| `build-bookmarklet.mjs` | Build script → `build/bookmarklet.txt` + `docs/index.html`. |
| `build/bookmarklet.txt` | The `javascript:` URL (generated; for copy-paste install). |
| `docs/index.html` | Install/landing page (generated; served by GitHub Pages). |
| `docs/screenshot.png` | README/install-page screenshot (regenerated from `preview.html`). |
| `docs/.nojekyll` | Stops GitHub Pages from running Jekyll on `docs/`. **Keep it.** |
| `preview.html` | Renders the real bookmarklet against a **mocked** API for visual QA. |
| `package.json` | Metadata + the single `npm run build` script. License: CC0-1.0. |

GitHub Pages is configured to serve from `main` branch, `/docs` folder →
<https://arcataroger.github.io/instant-ink-usage/>.

## How the bookmarklet works (pipeline)

All of this happens client-side, in the origin of the page the user runs it on
(must be `portal.hpsmart.com`). Numbered to match the comments in the source:

0. **Make sure we're on the portal.** If `location.hostname` isn't
   `portal.hpsmart.com`, offer (via `confirm()`) to redirect to the account-history
   URL and bail; the user re-clicks the bookmark once it loads. Everything below
   needs the live HP session, which is host-wide.
1. **Get a working bearer token.** Builds a set of candidate JWTs by (a) scanning
   `sessionStorage`/`localStorage` for anything matching a JWT regex (including
   inside JSON blobs), and (b) minting one via `POST /api/session/v3/token`
   (cookie-authed, same origin). This avoids hard-coding which storage key or
   token field is "the" token.
2. **Identify the account.** Probes each candidate token against
   `GET /api/dashboard/v1/user?isAgentSession=false`; the first that returns `200`
   is our token, and the subscription id is read from that response
   (`lastViewedAccountIdentifier`, else `accountIdentifiers[0]` — a ~10-digit
   number). No page scraping, so it works on **any** signed-in portal page.
3. **Enumerate billing cycles.** `GET /api/dashboard/v1/subscription/{sub}/activities`
   returns account events; each one with an `activity.invoice_download_link` of
   the form `/billing_cycles/{id}/pdf` yields a billing-cycle id. IDs are opaque
   and non-sequential, and the same cycle can appear twice, so they're de-duped.
4. **Fetch each cycle.** `GET /api/dashboard/v1/subscription/{sub}/billing_cycle/{id}`,
   5 in parallel.
5. **Bucket usage by calendar month/year.** Each cycle has
   `daily_usage.{regular,rollover,overage,trial,credit_pages}`, arrays of
   `{x, y}` points where **`x` = whole days since the Unix epoch (1970-01-01 UTC)**
   and `y` = pages printed that day. Summing `y` across *all* series equals the
   cycle's `totals.total_pages`. Billing cycles run ~25th→24th, so each day is
   assigned to its real calendar month/year rather than to the cycle.
6. **Render.** An in-page modal inside a Shadow DOM (style-isolated from HP's
   page). Annual horizontal bars + per-year 12-column monthly charts, plus
   copy/JSON/CSV export.

## Build & deploy

```bash
npm run build      # regenerates build/bookmarklet.txt and docs/index.html
```

- The build **URL-encodes the entire source** (`encodeURIComponent`) rather than
  minifying — encoded newlines keep `//` comments terminated and nothing gets
  mangled. `encodeURIComponent` output has no HTML-special chars, so the
  resulting `javascript:` URL is safe to drop directly into the install page's
  `href="..."`.
- A trailing `;void 0` is appended so the async IIFE's returned Promise isn't
  used as a navigation target.
- After editing `bookmarklet.src.js`, **always rebuild and commit the generated
  files**, then push. GitHub Pages redeploys `docs/` automatically.
- If the screenshot needs refreshing: open `preview.html` in headless Chrome and
  screenshot to `docs/screenshot.png` (see the test command below).

## Testing / preview (no real account needed)

`preview.html` stubs `fetch`/storage and loads the real `bookmarklet.src.js`, so
the actual code path runs against fake data. To visually verify a change:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --force-color-profile=srgb \
  --screenshot=docs/screenshot.png --window-size=1000,1180 \
  --virtual-time-budget=6000 "file://$PWD/preview.html"
```

Note: `new Function(src)` only catches *syntax* errors. A past bug was a
`const`-before-use **temporal dead zone** that only failed at runtime — the
preview/headless run is what catches those. Run it after non-trivial edits.

---

## ⚠️ Fragile parts — what HP might change, and how it'll fail

Everything here depends on **undocumented, private HP APIs and page markup**.
None of it is a stable contract; HP can change any of it without notice. Ordered
roughly most- to least-likely to break. The good news: each failure is designed
to surface as a clear message in the status chip rather than silently produce
wrong numbers.

### 1. Token acquisition (most fragile)
- **Depends on:** the mint endpoint `POST /api/session/v3/token` with body
  `{tenantType:"orgless",shellTenantsData:{}}`, and/or a JWT being findable in
  `sessionStorage`/`localStorage`, and that token being accepted by `GET /user`
  (the probe that both validates the token and yields the account id).
- **Fails as:** "couldn't get a working token — are you logged in on this page?"
- **To fix:** log in, open DevTools → Network on the account-history page, find
  the request the dashboard makes to `instantink.hpconnected.com` and look at its
  `Authorization` header; trace where the SPA got that token (storage, or a mint
  call) and update step 2. The probe-the-candidates design means you usually just
  need to add a new *source* of candidate tokens, not pin an exact one.

### 2. `/activities` shape & the invoice-link format
- **Depends on:** `activities[].activity.invoice_download_link` matching
  `/billing_cycles/(\d+)/pdf`. This is the only way we enumerate months.
- **Fails as:** "no billing cycles found in activity list".
- **Watch for:** a renamed field, a different link format, or **pagination**
  (today it appears to return full history in one response; if HP paginates,
  we'd silently miss older months — verify the count looks complete).
- **To fix:** inspect a real `/activities` response and update the regex /
  extraction in step 3.

### 3. `billing_cycle` `daily_usage` shape
- **Depends on:** `daily_usage` being an object of arrays of `{x, y}`, with
  **`x` = days since 1970-01-01 UTC**. The day→calendar-month math (`EPOCH_MS`,
  `ym()`) hinges on that epoch meaning.
- **Fails as:** wrong/empty months, or "fetched cycles but found no usage data".
- **Watch for:** HP changing `x` to a different unit/epoch (e.g. ms, or a date
  string), renaming the series, or adding a new page category we don't sum.
  We sum *all* series, so a new category is counted automatically — but verify
  the per-cycle sum still equals `totals.total_pages` after any change.

### 4. Origin / CORS
- **Depends on:** running on `portal.hpsmart.com`, whose `Origin` the API's CORS
  policy allows. Authenticated GETs trigger an `OPTIONS` preflight that HP
  currently answers.
- **Fails as:** network/CORS errors fetching cycles.
- **To fix:** if HP moves the dashboard to a new origin, update the install
  instructions (and `PORTAL` in `build-bookmarklet.mjs`) to that origin. The
  bookmarklet must be run from an origin the API trusts.

### 5. Subscription-id discovery (`/user`)
- **Depends on:** `GET /api/dashboard/v1/user?isAgentSession=false` returning
  `lastViewedAccountIdentifier` / `accountIdentifiers[]` (the ~10-digit account
  id the `/subscription/{id}/...` calls expect). Replaced the old DOM scrape.
- **Fails as:** "you're signed in, but this HP profile doesn't seem to have an
  Instant Ink subscription."
- **Watch for:** a renamed field, a non-numeric id, or **multiple accounts**
  (today we just take the last-viewed/first one; a multi-subscription user would
  need a picker).
- **To fix:** inspect a real `/user` response and update the field extraction in
  step 2.

### 6. Endpoint base path / API version
- **Depends on:** `https://instantink.hpconnected.com/api/dashboard/v1`. If HP
  bumps to `v2` or moves the host, every call 404s/fails.
- **To fix:** update `API` (and confirm the response shapes — a version bump
  often changes them too).

### 7. The login wall (context, not a code dependency)
HP sign-in is protected by **Arkose Labs** bot detection. **Do not** try to
automate login or "improve" this into an auto-login tool — the captcha token is
generated by browser-run JS, is single-use, and can't be reproduced from a
script. The bookmarklet approach exists *specifically* to sidestep this by
reusing the human's real session. Keep it that way.

## Re-capturing the API when something breaks

1. Log in and open `portal.hpsmart.com/.../print_plans/account_history`.
2. DevTools → Network, filter to `instantink.hpconnected.com`.
3. Click a billing cycle in the dropdown to trigger `/billing_cycle/{id}`, and
   note the `/activities` call on load. Inspect their JSON responses and the
   request `Authorization` header.
4. **Use Firefox to export a HAR if you need headers** — Chrome strips
   `Authorization`/`Cookie` from HAR exports; Firefox keeps them.
5. **Never commit a HAR or paste a token/cookie into the repo** — a dashboard HAR
   contains a bearer token and a login HAR contains a plaintext password. (There
   is intentionally no `.har` ignore rule advertised in docs, but still: don't.)

## Conventions / guardrails

- Keep it **dependency-free and single-file**. The value is that anyone can read
  the whole thing.
- License is **CC0 / public domain** — no attribution headers required.
- The report UI is a deliberate "ink usage statement" aesthetic (paper, CMYK)
  rendered in a **Shadow DOM** for style isolation. It uses only the system
  sans-serif stack — **no web-font / Google Fonts dependency** (don't reintroduce
  one; it can be blocked by a host page's CSP and adds an external request).
- Don't add analytics, network calls to anything other than HP, or anything that
  transmits the user's data off their machine. Safety is a feature.
