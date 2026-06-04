# Instant Ink Usage

Collect your **full HP Instant Ink printing history** and view it as an annual
summary + per-year monthly breakdown of pages printed — with bar charts.

Two ways to use it:

- **Bookmarklet** (recommended) — runs in your browser on the HP dashboard,
  using your existing login. Shows a polished in-page report.
- **Node CLI** — for HAR-based / offline use or scripting.

![Screenshot of the usage report modal](docs/screenshot.png)

---

## Why a bookmarklet?

HP sign-in is protected by [Arkose Labs](https://www.arkoselabs.com/) bot
detection, so there's no clean way to log in from a script. Instead, you log in
normally in your browser and then run a bookmarklet **on the dashboard page**.
It executes in that page's origin with your live session, so it looks like the
dashboard's own traffic — and **no credentials are ever entered, stored, or
transmitted anywhere by this tool**. All data stays in your browser; the only
network calls are to HP's own dashboard API.

## Install the bookmarklet

**Option A — drag to install (easiest):** open [`build/install.html`](build/install.html)
in your browser and drag the **📊 Instant Ink Usage** button to your bookmarks bar.

**Option B — paste:** create a new bookmark and paste the entire contents of
[`build/bookmarklet.txt`](build/bookmarklet.txt) as its URL.

## Run it

1. Log in to HP Smart and navigate to **HP Instant Ink → Print and Payment
   History** (`portal.hpsmart.com/.../print_plans/account_history`).
2. Click the **Instant Ink Usage** bookmark.
3. A status chip shows progress while it fetches every billing cycle, then a
   report opens with:
   - **Annual totals** (CMYK bar chart)
   - **Monthly breakdown** per year (12-column small-multiples; each year's peak
     month highlighted)
   - **Copy report** (plain-text ASCII version), **Download JSON**, **Download CSV**

Press <kbd>Esc</kbd>, click the backdrop, or hit ✕ to close.

## How it works

The HP dashboard exposes an undocumented JSON API at
`instantink.hpconnected.com/api/dashboard/v1`:

| Call | Purpose |
| --- | --- |
| `GET /subscription/{sub}/activities` | Lists account events; each billed `payment_event` links to `/billing_cycles/{id}/pdf` — the month index (cycle IDs are opaque and non-sequential). |
| `GET /subscription/{sub}/billing_cycle/{id}` | One billing cycle, including `daily_usage` with `{x: days-since-1970, y: pages}` points. |

The tool de-duplicates the cycle IDs, fetches each cycle, and buckets every
day's pages into its **true calendar month/year** (cycles run ~25th→24th, so
they straddle month boundaries). Summing all `daily_usage` series equals the
reported `totals.total_pages`, i.e. real pages printed.

To authenticate to the API, the bookmarklet gathers candidate bearer tokens
(scanning `sessionStorage`/`localStorage` and minting one via
`POST /api/session/v3/token`) and **probes each against the API**, using
whichever returns `200`.

## Node CLI (alternative)

Requires Node 18+ (uses global `fetch`). No dependencies.

```bash
# Live pull: paste a bearer token copied from your browser's DevTools
npm run usage -- --token "Bearer eyJ..." --sub 1234567890

# Or drop a Firefox HAR export of the dashboard into the folder; the CLI
# reads the token, subscription id, and any captured cycles from it
npm run usage

# Re-run from the on-disk cache only, no network
npm run usage:offline

# Ignore cache and re-fetch everything
npm run usage:refresh
```

Options: `--token`, `--sub`, `--json [file]`, `--offline`, `--refresh`, `--help`.
Completed cycles are cached under `cache/` (immutable), so re-runs are fast and
only the current month is re-fetched.

> **Note:** HP bearer tokens expire after ~1 hour, so run the CLI soon after
> grabbing one. Chrome sanitizes `Authorization`/`Cookie` from HAR exports — use
> a **Firefox** HAR if you go the HAR route.

## Build

The bookmarklet is generated from [`bookmarklet.src.js`](bookmarklet.src.js):

```bash
npm run build      # writes build/bookmarklet.txt and build/install.html
```

`build-bookmarklet.mjs` URL-encodes the source into a `javascript:` URL (no
minification, so comments/regexes survive). [`preview.html`](preview.html)
renders the real bookmarklet against a mocked API for visual QA.

## Privacy & security

- **No credentials handled by this tool.** You log in yourself; the bookmarklet
  reuses the session your browser already has.
- All processing is local to your browser (or your machine, for the CLI).
- **Never commit HAR files** — a dashboard HAR contains your bearer token, and a
  login HAR contains your **plaintext password**. They're git-ignored here.

## License

[MIT](LICENSE)
