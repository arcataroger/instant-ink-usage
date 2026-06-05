/**
 * HP Instant Ink — usage history bookmarklet (readable source).
 *
 * Run it while logged in on:
 *   https://portal.hpsmart.com/us/en/print_plans/account_history?t1=...
 *
 * It runs in that page's origin with your live session, so to HP it looks like
 * the dashboard's own traffic. It:
 *   1. obtains a usable bearer token (scans storage + mints one, then probes
 *      each candidate against /user and keeps whichever returns 200),
 *   2. reads your subscription id straight from that /user response (no page
 *      scraping, so it works anywhere you're signed in on portal.hpsmart.com),
 *   3. lists every billing cycle via /activities,
 *   4. fetches each /billing_cycle/{id} (pages + HP's own cost totals),
 *   5. groups cycles by the calendar year they END in,
 *   6. renders an in-page Shadow-DOM modal — all-time totals, annualized
 *      averages, a per-year summary (pages + base/overage cost) and a
 *      per-cycle breakdown — with buttons to copy ASCII / download JSON + CSV.
 *
 * Build the clickable bookmarklet:  node build-bookmarklet.mjs
 * Maintenance notes & fragile HP dependencies:  see AGENTS.md
 */
(async function () {
  "use strict";
  const API = "https://instantink.hpconnected.com/api/dashboard/v1";
  const EPOCH_MS = Date.UTC(1970, 0, 1);
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
  const HISTORY_URL = "https://portal.hpsmart.com/us/en/print_plans/account_history";

  // ---- 0. make sure we're on the HP portal --------------------------------
  // The script needs your live HP session and scrapes your Subscription ID off
  // the Print and Payment History page, so it only works on portal.hpsmart.com.
  // If we're somewhere else, offer to send the user there (then they re-click
  // the bookmark) rather than asking them to type an account number by hand.
  if (location.hostname !== "portal.hpsmart.com" && !window.__IIPREVIEW) {
    if (confirm(
      "Instant Ink Usage needs to run on your HP account page, where you're already signed in.\n\n" +
      "Go to your HP Instant Ink \"Print and Payment History\" page now?\n\n" +
      "(Once it loads, click the Instant Ink Usage bookmark again.)"
    )) {
      location.href = HISTORY_URL;
    }
    return;
  }

  // ---- status chip (centered top, styled to match the report) -------------
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
    "display:flex;align-items:center;gap:11px;box-sizing:border-box;max-width:92vw;" +
    "background:#f6f2e7;color:#16130f;border:1px solid rgba(22,19,15,.16);border-radius:999px;" +
    "padding:11px 18px;box-shadow:0 12px 34px -10px rgba(18,16,12,.5);" +
    "font:600 13.5px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif";
  const dot = (c) =>
    '<i style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + c + '"></i>';
  box.innerHTML =
    '<span id="iidots" style="display:inline-flex;gap:4px">' +
    dot("#0098d4") + dot("#e5007e") + dot("#f5b500") + dot("#16130f") +
    "</span><span id=\"iitext\"></span>";
  document.body.appendChild(box);
  const dotsEl = box.querySelector("#iidots");
  const textEl = box.querySelector("#iitext");
  // gentle on-brand "wave" so it reads as working (Web Animations API, no CSS needed)
  dotsEl.querySelectorAll("i").forEach((d, i) =>
    d.animate(
      [{ transform: "translateY(0)" }, { transform: "translateY(-4px)" }, { transform: "translateY(0)" }],
      { duration: 900, iterations: Infinity, delay: i * 120, easing: "ease-in-out" }
    ));
  const say = (m) => { textEl.textContent = m; };
  const fail = (m) => { dotsEl.style.display = "none"; box.style.color = "#b00020"; textEl.textContent = m; };
  say("Getting ready…");

  try {
    // ---- 1. obtain a working bearer token ----------------------------------
    const candidates = new Set();

    // (a) scan storages for anything that looks like a JWT
    for (const store of [sessionStorage, localStorage]) {
      for (let i = 0; i < store.length; i++) {
        const v = store.getItem(store.key(i)) || "";
        const direct = v.match(JWT_RE);
        if (direct) candidates.add(direct[0]);
        // values are often JSON blobs holding the token
        try { deepCollectJwts(JSON.parse(v), candidates); } catch {}
      }
    }
    // (b) mint a fresh token the same way the SPA does
    try {
      const r = await fetch("/api/session/v3/token", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantType: "orgless", shellTenantsData: {} }),
      });
      if (r.ok) deepCollectJwts(await r.json().catch(() => null), candidates);
    } catch {}

    // ---- 2. identify the account -------------------------------------------
    // Probe each candidate token against /user (no subscription id required);
    // the first that returns 200 is our token, and its body carries the
    // account id — so we never have to scrape it off the page.
    say("Connecting to your HP account…");
    let token = null;
    let sub = null;
    for (const t of candidates) {
      const user = await fetchUser(t);
      if (!user) continue;
      token = t;
      sub = String(user.lastViewedAccountIdentifier || (user.accountIdentifiers || [])[0] || "").trim();
      break;
    }
    if (!token) {
      // No token the API will accept → not signed in (or the session expired).
      // Offer to (re)open the history page, where HP shows its own login prompt;
      // we never hardcode an HP login URL of our own.
      if (confirm(
        "You don't seem to be signed in to HP (or your session has expired).\n\n" +
        "Open your HP Instant Ink page to sign in now? Once you're signed in, " +
        "click the Instant Ink Usage bookmark again."
      )) {
        location.href = HISTORY_URL;
        return;
      }
      fail("You don't seem to be signed in to HP. Please sign in and try again.");
      setTimeout(() => box.remove(), 9000);
      return;
    }
    if (!/^\d+$/.test(sub)) throw new Error("You're signed in, but this HP profile doesn't seem to have an Instant Ink subscription.");

    // ---- 3. enumerate billing cycles via /activities -----------------------
    say("Finding your printing history…");
    const acts = await apiGet(`${API}/subscription/${sub}/activities`, token);
    const ids = [];
    const seen = new Set();
    for (const a of acts.activities || []) {
      const m = (a?.activity?.invoice_download_link || "").match(/\/billing_cycles\/(\d+)\//);
      if (m && !seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
    }
    if (!ids.length) throw new Error("We couldn't find any printing history on your account yet.");

    // ---- 4. fetch each cycle (limited concurrency) -------------------------
    const cycles = [];
    let done = 0;
    const CONC = 5;
    let cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        try {
          const c = await apiGet(`${API}/subscription/${sub}/billing_cycle/${id}`, token);
          const rec = cycleRecord(c);
          if (rec) cycles.push(rec);
        } catch (e) { /* skip a bad cycle, keep going */ }
        say(`Adding up your pages… ${++done} of ${ids.length} cycles`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, ids.length) }, worker));
    if (!cycles.length) throw new Error("We couldn't read your usage history. Please try again in a moment.");

    // ---- 5/6. render report -----------------------------------------------
    openReport(buildModel(sub, cycles));
    say("All done — here's your report!");
    setTimeout(() => box.remove(), 3500);
  } catch (err) {
    const m = String((err && err.message) || err);
    // show our friendly messages as-is; replace any raw technical error
    fail(/^(HTTP|Failed|NetworkError|Load failed|TypeError|fetch|Unexpected)/i.test(m)
      ? "Something went wrong while talking to HP. Please refresh the page and try again."
      : m);
    setTimeout(() => box.remove(), 9000);
  }

  // ---- helpers -------------------------------------------------------------
  function deepCollectJwts(node, set, depth = 0) {
    if (node == null || depth > 6) return;
    if (typeof node === "string") { const m = node.match(JWT_RE); if (m) set.add(m[0]); return; }
    if (typeof node === "object") for (const v of Object.values(node)) deepCollectJwts(v, set, depth + 1);
  }

  function authHeaders(token) {
    return { Authorization: token.startsWith("Bearer ") ? token : "Bearer " + token, Accept: "application/json" };
  }
  async function fetchUser(token) {
    try {
      const r = await fetch(`${API}/user?isAgentSession=false`, { headers: authHeaders(token) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }
  async function apiGet(url, token) {
    const r = await fetch(url, { headers: authHeaders(token) });
    if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
    return r.json();
  }

  // Parse an HP money string ("$1.79", "$1.79 Plan", "$1,200.00") into a number
  // + its currency symbol. Amounts arrive as display strings, some with a
  // trailing label, so read the leading symbol and the first numeric run.
  function r2(n) { return Math.round(n * 100) / 100; } // hoisted: used by cycleRecord during fetch
  function parseMoney(s) {
    s = String(s == null ? "" : s);
    const sym = (s.match(/^\s*([^\s\d.,+-])/) || [, ""])[1];
    const m = s.match(/-?[\d,]*\.?\d+/);
    const amt = m ? parseFloat(m[0].replace(/,/g, "")) : 0;
    return { amount: isFinite(amt) ? amt : 0, symbol: sym };
  }
  function fmtMoney(n, sym) {
    return (sym || "$") + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function isoDay(serial) { return new Date(EPOCH_MS + serial * 86400000).toISOString().slice(0, 10); }
  function fmtDay(iso) { const [y, m, d] = iso.split("-"); return `${MONTHS[+m - 1]} ${+d} ${y}`; }
  function fmtRange(startIso, endIso) {
    const s = fmtDay(startIso), e = fmtDay(endIso);
    // drop the (redundant) year from the start when both ends share it
    return (startIso.slice(0, 4) === endIso.slice(0, 4) ? s.replace(/ \d+$/, "") : s) + " → " + e;
  }
  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // Turn one billing_cycle response into a flat record. Pages and cost come
  // straight from HP's `totals`; the real start/end dates (the strings omit the
  // year) come from the span of daily_usage `x` serials. See schema/.
  function cycleRecord(cycle) {
    const du = cycle.daily_usage || {};
    let minX = Infinity, maxX = -Infinity;
    for (const series of Object.values(du)) {
      if (!Array.isArray(series)) continue;
      for (const p of series) {
        if (p && typeof p.x === "number") { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; }
      }
    }
    if (!isFinite(minX)) return null; // no usable data points
    const t = cycle.totals || {};
    const totalPages = t.total_pages || 0;
    const overagePages = t.additional_pages || 0;
    const base = parseMoney(t.regular_price);
    const overage = parseMoney(t.additional_price);
    const total = parseMoney(t.total_price);
    const lessTax = parseMoney(t.total_price_less_tax);
    const tax = Math.max(0, r2(total.amount - lessTax.amount));
    return {
      id: cycle.id,
      startSerial: minX, endSerial: maxX,
      start: isoDay(minX), end: isoDay(maxX),
      year: new Date(EPOCH_MS + maxX * 86400000).getUTCFullYear(), // belongs to the year it ENDS
      symbol: base.symbol || total.symbol || overage.symbol || "",
      pages: { base: Math.max(0, totalPages - overagePages), overage: overagePages, total: totalPages },
      cost: { base: base.amount, overage: overage.amount, tax, total: total.amount },
    };
  }

  // Roll the per-cycle records up into the single model every renderer consumes.
  function buildModel(sub, cycles) {
    cycles.sort((a, b) => a.startSerial - b.startSerial);
    const symbol = (cycles.find((c) => c.symbol) || {}).symbol || "$";
    const byYear = new Map();
    for (const c of cycles) {
      let b = byYear.get(c.year);
      if (!b) {
        b = { year: c.year, spanStart: c.start, spanEnd: c.end, cycleCount: 0,
          pages: { base: 0, overage: 0, total: 0 }, cost: { base: 0, overage: 0, tax: 0, total: 0 } };
        byYear.set(c.year, b);
      }
      b.cycleCount++;
      if (c.start < b.spanStart) b.spanStart = c.start;
      if (c.end > b.spanEnd) b.spanEnd = c.end;
      for (const k of ["base", "overage", "total"]) b.pages[k] += c.pages[k];
      for (const k of ["base", "overage", "tax", "total"]) b.cost[k] += c.cost[k];
    }
    const allTime = {
      pages: cycles.reduce((s, c) => s + c.pages.total, 0),
      cost: cycles.reduce((s, c) => s + c.cost.total, 0),
    };
    const n = cycles.length || 1; // annualize: plan is monthly, so 12 cycles ≈ a year
    const avg = {
      pages: { mean: (allTime.pages / n) * 12, median: median(cycles.map((c) => c.pages.total)) * 12 },
      cost: { mean: (allTime.cost / n) * 12, median: median(cycles.map((c) => c.cost.total)) * 12 },
    };
    return { sub, symbol, cycles, byYear, allTime, avg,
      first: cycles.length && cycles[0].start, last: cycles.length && cycles[cycles.length - 1].end };
  }

  function num(n) { return Number(n).toLocaleString("en-US"); }

  function buildText(d) {
    const years = [...d.byYear.keys()].sort((a, b) => a - b);
    const $ = (n) => fmtMoney(n, d.symbol);
    const costStr = (c) => {
      let s = `base ${$(c.base)} · overage ${$(c.overage)}`;
      if (c.tax > 0.0049) s += ` · tax ${$(c.tax)}`;
      return s;
    };
    const L = [];
    L.push("HP Instant Ink — Pages & Cost");
    L.push(`Subscription ${d.sub} · ${d.cycles.length} billing cycles · ${fmtRange(d.first, d.last)}`);
    L.push(`${num(d.allTime.pages)} pages · ${$(d.allTime.cost)} all-time`);
    L.push("─".repeat(66), "");
    L.push("PER-YEAR AVERAGE (annualized from billing cycles)");
    L.push(`  Pages   mean ${num(Math.round(d.avg.pages.mean))}   median ${num(Math.round(d.avg.pages.median))}`);
    L.push(`  Cost    mean ${$(d.avg.cost.mean)}   median ${$(d.avg.cost.median)}`);
    L.push("", "ANNUAL SUMMARY  (each year = billing cycles ending that year)", "");
    for (const y of years) {
      const b = d.byYear.get(y);
      L.push(`  ${y}   ${fmtRange(b.spanStart, b.spanEnd)} · ${b.cycleCount} cycle${b.cycleCount === 1 ? "" : "s"}`);
      L.push(`         ${num(b.pages.total)} pages   base ${num(b.pages.base)} · overage ${num(b.pages.overage)}`);
      L.push(`         ${$(b.cost.total)}   ${costStr(b.cost)}`);
      L.push("");
    }
    L.push("  ────");
    L.push(`  All    ${num(d.allTime.pages)} pages · ${$(d.allTime.cost)}`);
    L.push("", "BILLING CYCLES", "");
    for (const y of years) {
      L.push(`── ends ${y} ──`);
      for (const c of d.cycles.filter((c) => c.year === y)) {
        L.push(`  ${fmtRange(c.start, c.end)}`);
        L.push(`      ${num(c.pages.total)} pages   base ${num(c.pages.base)} · overage ${num(c.pages.overage)}   ${costStr(c.cost)} = ${$(c.cost.total)}`);
      }
      L.push("");
    }
    return L.join("\n").replace(/\n+$/, "") + "\n";
  }
  function buildJson(d) {
    const rc = (c) => ({ base: r2(c.base), overage: r2(c.overage), tax: r2(c.tax), total: r2(c.total) });
    return {
      subscription: d.sub,
      generated_at: new Date().toISOString(),
      currency: d.symbol,
      all_time: { pages: d.allTime.pages, cost: r2(d.allTime.cost) },
      annual_average: {
        note: "annualized from billing cycles (per-cycle figure × 12)",
        pages: { mean: Math.round(d.avg.pages.mean), median: Math.round(d.avg.pages.median) },
        cost: { mean: r2(d.avg.cost.mean), median: r2(d.avg.cost.median) },
      },
      annual: Object.fromEntries([...d.byYear.keys()].sort((a, b) => a - b).map((y) => {
        const b = d.byYear.get(y);
        return [String(y), { span: { start: b.spanStart, end: b.spanEnd }, cycles: b.cycleCount, pages: { ...b.pages }, cost: rc(b.cost) }];
      })),
      cycles: d.cycles.map((c) => ({ id: c.id, start: c.start, end: c.end, year: c.year, pages: { ...c.pages }, cost: rc(c.cost) })),
    };
  }
  function buildCsv(d) {
    const rows = [["cycle_start", "cycle_end", "year", "total_pages", "base_pages", "overage_pages", "base_cost", "overage_cost", "tax", "total_cost"]];
    for (const c of d.cycles) {
      rows.push([c.start, c.end, c.year, c.pages.total, c.pages.base, c.pages.overage, r2(c.cost.base), r2(c.cost.overage), r2(c.cost.tax), r2(c.cost.total)]);
    }
    return rows.map((r) => r.join(",")).join("\n");
  }

  // Renders an in-page "ink usage statement" overlay inside a Shadow DOM, so it
  // survives popup blockers and is fully isolated from the host page's CSS.
  function openReport(d) {
    const text = buildText(d);
    const json = JSON.stringify(buildJson(d), null, 2);
    const csv = buildCsv(d);
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

    const $ = (n) => fmtMoney(n, d.symbol);
    const years = [...d.byYear.keys()].sort((a, b) => a - b);
    const maxYP = Math.max(1, ...years.map((y) => d.byYear.get(y).pages.total));
    const maxCP = Math.max(1, ...d.cycles.map((c) => c.pages.total));
    const taxBit = (c) => (c.tax > 0.0049 ? ` &middot; tax ${$(c.tax)}` : "");

    const annualRows = years
      .map((y, i) => {
        const b = d.byYear.get(y);
        return `<div class=yrow>` +
          `<div class=yhd><span class=yy>${y}</span><span class=ysub>${esc(fmtRange(b.spanStart, b.spanEnd))} &middot; ${b.cycleCount} cycle${b.cycleCount === 1 ? "" : "s"}</span></div>` +
          `<div class=ybar><span class=segb style="--w:${(b.pages.base / maxYP) * 100}%;--d:${i * 80}ms"></span><span class=sego style="--w:${(b.pages.overage / maxYP) * 100}%;--d:${i * 80 + 80}ms"></span></div>` +
          `<div class=yfig><span class=yp>${num(b.pages.total)} pages <em>base ${num(b.pages.base)} &middot; overage ${num(b.pages.overage)}</em></span>` +
          `<span class=yc>${$(b.cost.total)} <em>base ${$(b.cost.base)} &middot; overage ${$(b.cost.overage)}${taxBit(b.cost)}</em></span></div>` +
          `</div>`;
      })
      .join("");

    const cycleBlocks = years
      .map((y) => {
        const rows = d.cycles.filter((c) => c.year === y).map((c) =>
          `<div class=cyrow>` +
          `<div class=cytop>` +
            `<span class=cyd>${esc(fmtRange(c.start, c.end))}</span>` +
            `<span class=cybar><span class=segb style="--w:${(c.pages.base / maxCP) * 100}%"></span><span class=sego style="--w:${(c.pages.overage / maxCP) * 100}%"></span></span>` +
            `<span class=cyc>${$(c.cost.total)}</span>` +
          `</div>` +
          `<div class=cyfig>` +
            `<span><b>${num(c.pages.total)} pages</b><em>base ${num(c.pages.base)} &middot; overage ${num(c.pages.overage)}</em></span>` +
            `<span><b>cost</b><em>base ${$(c.cost.base)} &middot; overage ${$(c.cost.overage)}${taxBit(c.cost)}</em></span>` +
          `</div>` +
          `</div>`
        ).join("");
        return `<section class=cyb><header class=cyh>ends ${y}</header>${rows}</section>`;
      })
      .join("");

    document.getElementById("ii-usage-overlay")?.remove();
    const host = document.createElement("div");
    host.id = "ii-usage-overlay";
    const root = host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(host);

    const css = `
:host{all:initial}
*{margin:0;box-sizing:border-box}
.backdrop{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:5vh 18px;overflow:auto;background:rgba(18,16,12,.55);-webkit-backdrop-filter:blur(7px) saturate(115%);backdrop-filter:blur(7px) saturate(115%);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#16130f;animation:fade .3s ease both}
.dialog{position:relative;width:min(920px,100%);background:#f6f2e7;background-image:radial-gradient(circle at 1px 1px,rgba(22,19,15,.05) 1px,transparent 0);background-size:15px 15px;border:1px solid rgba(22,19,15,.14);border-radius:4px;box-shadow:0 34px 90px -22px rgba(18,16,12,.55),inset 0 1px 0 rgba(255,255,255,.7);animation:rise .42s cubic-bezier(.2,.85,.2,1) both}
.scroll{padding:42px clamp(22px,5vw,58px) 30px}
.reg{position:absolute;width:17px;height:17px;opacity:.45;pointer-events:none}
.reg::before,.reg::after{content:"";position:absolute;background:#16130f}
.reg::before{left:50%;top:0;width:1px;height:100%;transform:translateX(-.5px)}
.reg::after{top:50%;left:0;height:1px;width:100%;transform:translateY(-.5px)}
.reg.tl{top:12px;left:12px}.reg.tr{top:12px;right:12px}.reg.bl{bottom:12px;left:12px}.reg.br{bottom:12px;right:12px}
.x{position:absolute;top:15px;right:15px;z-index:3;width:34px;height:34px;border:1px solid rgba(22,19,15,.22);background:#f6f2e7;border-radius:50%;font:300 21px/1 system-ui,sans-serif;color:#16130f;cursor:pointer;transition:.22s}
.x:hover{background:#16130f;color:#f6f2e7;transform:rotate(90deg)}
.x:focus,.tools button:focus{outline:none}
.x:focus-visible,.tools button:focus-visible{outline:2px solid #0098d4;outline-offset:2px}
.eyebrow{font-size:10.5px;letter-spacing:.3em;text-transform:uppercase;color:#8f8676;font-weight:500}
h1{font-weight:800;font-size:clamp(44px,9vw,82px);line-height:.9;letter-spacing:-.03em;margin:.16em 0 .34em}
.meta{font-size:12px;color:#6e675a;letter-spacing:.02em}
.hero{display:flex;align-items:baseline;gap:34px;flex-wrap:wrap;margin:24px 0 14px}
.hstat{display:flex;flex-direction:column;gap:4px}
.hnum{font-weight:800;font-size:clamp(38px,7vw,60px);color:#e5007e;line-height:1;letter-spacing:-.02em}
.hnum.hk{color:#16130f;font-size:clamp(30px,5.5vw,48px)}
.hlab{font-size:11px;text-transform:uppercase;letter-spacing:.22em;color:#6e675a}
.avg{font-size:12px;color:#6e675a;letter-spacing:.01em;margin-bottom:22px}
.avg b{color:#16130f;font-weight:700}
.cmyk{display:flex;height:6px;width:118px;margin-bottom:24px;border-radius:1px;overflow:hidden}
.cmyk i{flex:1}
.tools{display:flex;flex-wrap:wrap;gap:10px}
.tools button{font-family:inherit;font-size:11.5px;letter-spacing:.05em;padding:9px 16px;cursor:pointer;background:transparent;color:#16130f;border:1.5px solid #16130f;border-radius:2px;transition:.18s}
.tools button:hover{background:#16130f;color:#f6f2e7}
.sec{font-weight:700;font-size:12px;letter-spacing:.24em;text-transform:uppercase;margin:38px 0 18px;padding-bottom:9px;border-bottom:1px solid rgba(22,19,15,.16)}
.legend{font-size:10.5px;color:#9a917f;text-transform:none;letter-spacing:.02em;font-weight:500}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin:0 3px 0 9px;vertical-align:middle}
.legend .swo{background:repeating-linear-gradient(45deg,#e5007e 0 2px,#c2006a 2px 4px)}
.ann{display:flex;flex-direction:column;gap:20px}
.yrow{display:flex;flex-direction:column;gap:8px}
.yhd{display:flex;align-items:baseline;gap:12px}
.yy{font-weight:800;font-size:22px;letter-spacing:-.01em}
.ysub{font-size:11px;color:#8f8676;letter-spacing:.02em}
.ybar{display:flex;height:18px;background:rgba(22,19,15,.07);border-radius:2px;overflow:hidden}
.segb,.sego{display:block;height:100%;width:var(--w);animation:grow .85s cubic-bezier(.2,.85,.2,1) var(--d,0ms) both}
.segb{background:#0098d4}
.sego{background:repeating-linear-gradient(45deg,#e5007e 0 5px,#c2006a 5px 10px)}
.yfig{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;font-size:13px;font-weight:700}
.yfig em{font-style:normal;font-weight:500;color:#6e675a;font-size:11.5px;margin-left:6px}
.yc{text-align:right}
.cycles{display:flex;flex-direction:column;gap:22px}
.cyb{display:flex;flex-direction:column;gap:15px}
.cyh{font-weight:700;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#9a917f}
.cyrow{display:flex;flex-direction:column;gap:5px}
.cytop{display:grid;grid-template-columns:200px 1fr 66px;align-items:center;gap:16px}
.cyd{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cybar{display:flex;height:11px;background:rgba(22,19,15,.06);border-radius:2px;overflow:hidden}
.cyc{font-weight:700;font-size:13px;text-align:right}
.cyfig{display:flex;justify-content:space-between;flex-wrap:wrap;gap:2px 16px;font-size:11.5px}
.cyfig b{font-weight:700}
.cyfig em{font-style:normal;color:#8f8676;margin-left:5px}
.foot{margin-top:32px;padding-top:15px;border-top:1px solid rgba(22,19,15,.13);font-size:10.5px;color:#9a917f;letter-spacing:.03em;line-height:1.6}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes rise{from{opacity:0;transform:translateY(16px) scale(.985)}to{opacity:1;transform:none}}
@keyframes grow{from{width:0}to{width:var(--w)}}
@media (prefers-reduced-motion:reduce){*{animation-duration:.001ms!important}}`;

    root.innerHTML =
      `<style>${css}</style>` +
      `<div class=backdrop><div class=dialog role=dialog aria-modal=true aria-label="Instant Ink usage">` +
      `<i class="reg tl"></i><i class="reg tr"></i><i class="reg bl"></i><i class="reg br"></i>` +
      `<button class=x title="Close (Esc)" aria-label=Close>&times;</button>` +
      `<div class=scroll>` +
      `<div class=eyebrow>HP Instant Ink &middot; Usage Statement</div>` +
      `<h1>Pages<br>&amp; Cost</h1>` +
      `<div class=meta>Subscription ${esc(d.sub)} &nbsp;&middot;&nbsp; ${d.cycles.length} billing cycles &nbsp;&middot;&nbsp; ${esc(fmtRange(d.first, d.last))}</div>` +
      `<div class=hero>` +
        `<div class=hstat><span class=hnum>${num(d.allTime.pages)}</span><span class=hlab>pages, all&#8209;time</span></div>` +
        `<div class=hstat><span class="hnum hk">${$(d.allTime.cost)}</span><span class=hlab>billed, all&#8209;time</span></div>` +
      `</div>` +
      `<div class=avg>Annualized average &middot; <b>Pages</b> mean ${num(Math.round(d.avg.pages.mean))} / median ${num(Math.round(d.avg.pages.median))} &nbsp;&middot;&nbsp; <b>Cost</b> mean ${$(d.avg.cost.mean)} / median ${$(d.avg.cost.median)}</div>` +
      `<div class=cmyk><i style="background:#0098d4"></i><i style="background:#e5007e"></i><i style="background:#f5b500"></i><i style="background:#16130f"></i></div>` +
      `<div class=tools><button data-a=copy>Copy report</button><button data-a=json>Download JSON</button><button data-a=csv>Download CSV</button></div>` +
      `<h2 class=sec>Annual summary <span class=legend><i style="background:#0098d4"></i>base<i class=swo></i>overage</span></h2><div class=ann>${annualRows}</div>` +
      `<h2 class=sec>Billing cycles <span class=legend><i style="background:#0098d4"></i>base<i class=swo></i>overage</span></h2><div class=cycles>${cycleBlocks}</div>` +
      `<div class=foot>Each year = billing cycles ending in it &middot; costs are HP's own per-cycle charges &middot; the plain-text version is on &ldquo;Copy report&rdquo;.</div>` +
      `</div></div></div>`;

    const close = () => { host.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    root.querySelector(".x").onclick = close;
    root.querySelector(".backdrop").addEventListener("click", (e) => { if (e.target === e.currentTarget) close(); });

    const dl = (name, type, data) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([data], { type }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    root.querySelectorAll(".tools button").forEach((b) => {
      b.onclick = () => {
        const a = b.getAttribute("data-a");
        if (a === "copy") {
          if (navigator.clipboard) navigator.clipboard.writeText(text);
          const old = b.textContent; b.textContent = "Copied ✓";
          setTimeout(() => (b.textContent = old), 1400);
        } else if (a === "json") dl("instantink-usage.json", "application/json", json);
        else if (a === "csv") dl("instantink-usage.csv", "text/csv", csv);
      };
    });
    root.querySelector(".x").focus();
  }
})();
