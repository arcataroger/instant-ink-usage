# Instant Ink Usage

See your **entire HP Instant Ink printing history** as an annual + monthly
pages-printed report — from one browser bookmarklet. No install, no account, no
server; it runs in your browser using the login you already have.

---

## 🚀 Install — drag it to your bookmarks bar

1. Open **[`build/install.html`](build/install.html)** in your browser
   (download the repo and double-click it, or use the GitHub Pages link if
   enabled — see [below](#one-click-hosted-install-optional)).
2. **Drag the “📊 Instant Ink Usage” button onto your bookmarks bar.** Done.

<sup>Prefer to do it by hand? Make a new bookmark and paste the contents of
**[`build/bookmarklet.txt`](build/bookmarklet.txt)** as the URL.</sup>

> ℹ️ A draggable bookmarklet can't live directly in this README: GitHub strips
> `javascript:` links when it renders Markdown. That's why the drag button is in
> `install.html` — which is just this README's install step as a real, working
> page.

![Screenshot of the usage report](docs/screenshot.png)

---

## ▶️ Use it

1. Log in to HP Smart and go to **HP Instant Ink → Print and Payment History**
   (`portal.hpsmart.com/.../print_plans/account_history`).
2. Click the **Instant Ink Usage** bookmark.
3. A small status chip shows progress while it reads every billing cycle, then a
   report opens with:
   - **Annual totals** — bar chart of pages printed per year
   - **Monthly breakdown** — 12-column chart per year, each year's peak month
     highlighted
   - **Copy report** (plain-text version), **Download JSON**, **Download CSV**

Press <kbd>Esc</kbd>, click the backdrop, or hit ✕ to close.

## 🔒 Why a bookmarklet (and is it safe?)

HP sign-in is protected by [Arkose Labs](https://www.arkoselabs.com/) bot
detection, so there's no clean way to log in from a script. With a bookmarklet
you log in normally, then run it **on the dashboard page** — it executes in that
page's origin with your existing session, so it looks like the dashboard's own
activity.

- **No credentials are entered, stored, or transmitted by this tool.**
- Everything runs locally in your browser. The only network calls are to HP's
  own dashboard API — the same ones the dashboard itself makes.
- The code is plain, readable JavaScript in
  [`bookmarklet.src.js`](bookmarklet.src.js); read it before you trust it.

## ⚙️ How it works

The HP dashboard exposes an undocumented JSON API at
`instantink.hpconnected.com/api/dashboard/v1`:

| Call | Purpose |
| --- | --- |
| `GET /subscription/{sub}/activities` | Lists account events; each billed `payment_event` links to `/billing_cycles/{id}/pdf` — the month index (cycle IDs are opaque and non-sequential). |
| `GET /subscription/{sub}/billing_cycle/{id}` | One billing cycle, including `daily_usage` with `{x: days-since-1970, y: pages}` points. |

The bookmarklet:

1. Finds your subscription ID (scraped from the page).
2. Gets a working bearer token by gathering candidates (scanning
   `sessionStorage`/`localStorage` and minting one via
   `POST /api/session/v3/token`) and **probing each against the API**, keeping
   whichever returns `200`.
3. De-duplicates the cycle IDs from `/activities` and fetches each cycle.
4. Buckets every day's pages into its **true calendar month/year** (cycles run
   ~25th→24th, so they straddle month boundaries). Summing all `daily_usage`
   series equals the reported `totals.total_pages` — real pages printed.

## 🛠️ Build from source

The bookmarklet is generated from [`bookmarklet.src.js`](bookmarklet.src.js):

```bash
npm run build      # writes build/bookmarklet.txt and build/install.html
```

`build-bookmarklet.mjs` URL-encodes the source into a `javascript:` URL (no
minification, so comments and regexes survive). [`preview.html`](preview.html)
renders the real bookmarklet against a mocked API for visual QA.

## 🌐 One-click hosted install (optional)

To make the drag button available at a URL (so people can install without
downloading anything), publish `build/install.html` with **GitHub Pages**. Note
that a Pages site is publicly visible. Once enabled, link it at the top of this
README, e.g. `https://arcataroger.github.io/instant-ink-usage/install.html`.

## 📄 License

[CC0 1.0 Universal](LICENSE) — public domain. Do whatever you want, no
attribution required.
