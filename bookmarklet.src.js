/**
 * HP Instant Ink — usage history bookmarklet (readable source).
 *
 * Run it while logged in on:
 *   https://portal.hpsmart.com/us/en/print_plans/account_history?t1=...
 *
 * It runs in that page's origin with your live session, so to HP it looks like
 * the dashboard's own traffic. It:
 *   1. finds your subscription id (scraped from the page),
 *   2. obtains a usable bearer token (scans storage + mints one, then probes
 *      each candidate against the API and keeps whichever returns 200),
 *   3. lists every billing cycle via /activities,
 *   4. fetches each /billing_cycle/{id},
 *   5. buckets daily_usage into true calendar months/years,
 *   6. renders an in-page Shadow-DOM modal (annual + monthly charts) with
 *      buttons to copy the ASCII report / download JSON + CSV.
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

  // ---- tiny status overlay -------------------------------------------------
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;top:16px;right:16px;z-index:2147483647;background:#111;color:#0f0;" +
    "font:13px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:10px 14px;border-radius:8px;" +
    "box-shadow:0 4px 20px rgba(0,0,0,.4);max-width:320px";
  document.body.appendChild(box);
  const say = (m) => { box.textContent = "Instant Ink: " + m; };
  const fail = (m) => { box.style.color = "#f55"; box.textContent = "Instant Ink: " + m; };
  say("starting…");

  try {
    // ---- 1. subscription id ------------------------------------------------
    let sub = (document.body.innerText.match(/Subscription\s*ID:?\s*(\d{6,})/i) || [])[1];
    if (!sub) sub = (location.href.match(/subscription[/=](\d{6,})/i) || [])[1];
    if (!sub) sub = prompt("Couldn't auto-detect your Subscription ID. Enter it:") || "";
    sub = sub.trim();
    if (!/^\d+$/.test(sub)) throw new Error("no subscription id");

    // ---- 2. obtain a working bearer token ----------------------------------
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

    say(`probing ${candidates.size} token candidate(s)…`);
    let token = null;
    for (const t of candidates) {
      if (await probe(sub, t)) { token = t; break; }
    }
    if (!token) throw new Error("couldn't get a working token — are you logged in on this page?");

    // ---- 3. enumerate billing cycles via /activities -----------------------
    say("listing billing cycles…");
    const acts = await apiGet(`${API}/subscription/${sub}/activities`, token);
    const ids = [];
    const seen = new Set();
    for (const a of acts.activities || []) {
      const m = (a?.activity?.invoice_download_link || "").match(/\/billing_cycles\/(\d+)\//);
      if (m && !seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
    }
    if (!ids.length) throw new Error("no billing cycles found in activity list");

    // ---- 4. fetch each cycle (limited concurrency) -------------------------
    const byYear = new Map();
    const byYM = new Map();
    const days = [];
    let done = 0;
    const CONC = 5;
    let cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        try {
          const c = await apiGet(`${API}/subscription/${sub}/billing_cycle/${id}`, token);
          accumulate(c, byYear, byYM, days);
        } catch (e) { /* skip a bad cycle, keep going */ }
        say(`fetching cycles… ${++done}/${ids.length}`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, ids.length) }, worker));
    if (!byYear.size) throw new Error("fetched cycles but found no usage data");

    // ---- 5/6. render report -----------------------------------------------
    days.sort();
    openReport({
      sub,
      cycleCount: ids.length,
      first: days[0],
      last: days[days.length - 1],
      byYear,
      byYM,
    });
    box.style.color = "#0f0";
    say(`done — ${ids.length} cycles. Report opened.`);
    setTimeout(() => box.remove(), 4000);
  } catch (err) {
    fail(err.message || String(err));
    setTimeout(() => box.remove(), 8000);
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
  async function probe(sub, token) {
    try {
      const r = await fetch(`${API}/subscription/${sub}/activities`, { headers: authHeaders(token) });
      return r.ok;
    } catch { return false; }
  }
  async function apiGet(url, token) {
    const r = await fetch(url, { headers: authHeaders(token) });
    if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
    return r.json();
  }

  function ym(x) { const d = new Date(EPOCH_MS + x * 86400000); return [d.getUTCFullYear(), d.getUTCMonth()]; }
  function accumulate(cycle, byYear, byYM, days) {
    const du = cycle.daily_usage || {};
    for (const series of Object.values(du)) {
      if (!Array.isArray(series)) continue;
      for (const p of series) {
        const pages = p && p.y || 0;
        if (!pages) continue;
        const [y, m] = ym(p.x);
        byYear.set(y, (byYear.get(y) || 0) + pages);
        const k = y + "-" + m;
        byYM.set(k, (byYM.get(k) || 0) + pages);
        days.push(new Date(EPOCH_MS + p.x * 86400000).toISOString().slice(0, 10));
      }
    }
  }

  function bar(value, max, width) {
    width = width || 40;
    if (max <= 0 || value <= 0) return "";
    const units = (value / max) * width;
    const whole = Math.floor(units);
    const rem = Math.round((units - whole) * 8);
    const parts = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
    let s = "█".repeat(whole);
    if (rem > 0) s += parts[rem];
    return s || "▏";
  }
  function num(n) { return n.toLocaleString("en-US"); }

  function buildText(d) {
    const years = [...d.byYear.keys()].sort((a, b) => a - b);
    const grand = [...d.byYear.values()].reduce((a, b) => a + b, 0);
    const L = [];
    L.push("HP Instant Ink — Pages Printed");
    L.push(`Subscription ${d.sub} · ${d.cycleCount} billing cycles · ${d.first} → ${d.last}`);
    L.push("─".repeat(64), "", "ANNUAL TOTALS");
    const aMax = Math.max(0, ...d.byYear.values());
    const aW = Math.max(...years.map((y) => num(d.byYear.get(y) || 0).length));
    for (const y of years) {
      const v = d.byYear.get(y) || 0;
      L.push(`  ${y}  ${num(v).padStart(aW)}  ${bar(v, aMax)}`);
    }
    L.push(`  ${"─".repeat(4)}`, `  All   ${num(grand).padStart(aW)} pages total`, "", "MONTHLY BREAKDOWN");
    const mMax = Math.max(0, ...d.byYM.values());
    const mW = num(mMax).length;
    for (const y of years) {
      L.push("", `── ${y} ──  (${num(d.byYear.get(y) || 0)} pages)`);
      for (let m = 0; m < 12; m++) {
        const v = d.byYM.get(y + "-" + m) || 0;
        L.push(`  ${MONTHS[m]}  ${num(v).padStart(mW)}  ${bar(v, mMax)}`);
      }
    }
    return L.join("\n");
  }
  function buildJson(d) {
    return {
      subscription: d.sub,
      generated_at: new Date().toISOString(),
      annual: Object.fromEntries([...d.byYear.entries()].sort((a, b) => a[0] - b[0])),
      monthly: Object.fromEntries(
        [...d.byYM.entries()].sort().map(([k, v]) => {
          const [y, m] = k.split("-");
          return [`${y}-${String(+m + 1).padStart(2, "0")}`, v];
        })
      ),
    };
  }
  function buildCsv(d) {
    const rows = [["year", "month", "pages"]];
    for (const [k, v] of [...d.byYM.entries()].sort()) {
      const [y, m] = k.split("-");
      rows.push([y, String(+m + 1).padStart(2, "0"), String(v)]);
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

    const years = [...d.byYear.keys()].sort((a, b) => a - b);
    const grand = [...d.byYear.values()].reduce((a, b) => a + b, 0);
    const annualMax = Math.max(1, ...d.byYear.values());
    const monthMax = Math.max(1, ...d.byYM.values());
    const CMYK = ["#0098d4", "#e5007e", "#f5b500", "#16130f"]; // cyan magenta yellow key

    const annualRows = years
      .map((y, i) => {
        const v = d.byYear.get(y) || 0;
        return `<div class=arow><span class=ayr>${y}</span>` +
          `<span class=atrack><span class=afill style="--w:${(v / annualMax) * 100}%;--c:${CMYK[i % 4]};--d:${i * 80}ms"></span></span>` +
          `<span class=aval>${num(v)}</span></div>`;
      })
      .join("");

    const monthBlocks = years
      .map((y) => {
        const vals = MONTHS.map((_, m) => d.byYM.get(y + "-" + m) || 0);
        const peak = Math.max(...vals);
        const cols = vals
          .map((v, m) =>
            `<div class=col><span class=cval>${v ? num(v) : ""}</span>` +
            `<span class=cwrap><span class="cbar${v && v === peak ? " peak" : ""}" style="--h:${(v / monthMax) * 100}%;--d:${m * 40}ms"></span></span>` +
            `<span class=clab>${MONTHS[m]}</span></div>`
          )
          .join("");
        return `<section class=yblock><header class=yhead><span class=yname>${y}</span>` +
          `<span class=ytot>${num(d.byYear.get(y) || 0)} pages</span></header>` +
          `<div class=months>${cols}</div></section>`;
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
.hero{display:flex;align-items:baseline;gap:14px;margin:24px 0 18px}
.hnum{font-weight:800;font-size:clamp(40px,7vw,62px);color:#e5007e;line-height:1;letter-spacing:-.02em}
.hlab{font-size:11px;text-transform:uppercase;letter-spacing:.22em;color:#6e675a}
.cmyk{display:flex;height:6px;width:118px;margin-bottom:24px;border-radius:1px;overflow:hidden}
.cmyk i{flex:1}
.tools{display:flex;flex-wrap:wrap;gap:10px}
.tools button{font-family:inherit;font-size:11.5px;letter-spacing:.05em;padding:9px 16px;cursor:pointer;background:transparent;color:#16130f;border:1.5px solid #16130f;border-radius:2px;transition:.18s}
.tools button:hover{background:#16130f;color:#f6f2e7}
.sec{font-weight:700;font-size:12px;letter-spacing:.24em;text-transform:uppercase;margin:38px 0 18px;padding-bottom:9px;border-bottom:1px solid rgba(22,19,15,.16)}
.annual{display:flex;flex-direction:column;gap:13px}
.arow{display:grid;grid-template-columns:52px 1fr auto;align-items:center;gap:15px}
.ayr{font-weight:700;font-size:14px}
.atrack{height:22px;background:rgba(22,19,15,.07);border-radius:2px;overflow:hidden}
.afill{display:block;height:100%;width:var(--w);background:var(--c);animation:grow .85s cubic-bezier(.2,.85,.2,1) var(--d) both}
.aval{font-weight:700;font-size:13px;min-width:50px;text-align:right}
.monthly{display:flex;flex-direction:column;gap:28px}
.yhead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px}
.yname{font-weight:700;font-size:23px}
.ytot{font-size:11.5px;color:#6e675a;letter-spacing:.04em}
.months{display:grid;grid-template-columns:repeat(12,1fr);gap:6px}
.col{display:flex;flex-direction:column;align-items:center;gap:5px}
.cval{font-size:9.5px;color:#8f8676;height:13px;line-height:13px}
.cwrap{height:120px;width:100%;display:flex;align-items:flex-end;justify-content:center}
.cbar{width:62%;max-width:26px;height:var(--h);min-height:2px;background:#0098d4;border-radius:2px 2px 0 0;animation:growh .72s cubic-bezier(.2,.85,.2,1) var(--d) both}
.cbar.peak{background:#e5007e}
.clab{font-size:9.5px;color:#9a917f;text-transform:uppercase;letter-spacing:.02em}
.foot{margin-top:32px;padding-top:15px;border-top:1px solid rgba(22,19,15,.13);font-size:10.5px;color:#9a917f;letter-spacing:.03em}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes rise{from{opacity:0;transform:translateY(16px) scale(.985)}to{opacity:1;transform:none}}
@keyframes grow{from{width:0}to{width:var(--w)}}
@keyframes growh{from{height:0}to{height:var(--h)}}
@media (prefers-reduced-motion:reduce){*{animation-duration:.001ms!important}}`;

    root.innerHTML =
      `<style>${css}</style>` +
      `<div class=backdrop><div class=dialog role=dialog aria-modal=true aria-label="Instant Ink usage">` +
      `<i class="reg tl"></i><i class="reg tr"></i><i class="reg bl"></i><i class="reg br"></i>` +
      `<button class=x title="Close (Esc)" aria-label=Close>&times;</button>` +
      `<div class=scroll>` +
      `<div class=eyebrow>HP Instant Ink &middot; Usage Statement</div>` +
      `<h1>Pages<br>Printed</h1>` +
      `<div class=meta>Subscription ${esc(d.sub)} &nbsp;&middot;&nbsp; ${esc(d.cycleCount)} billing cycles &nbsp;&middot;&nbsp; ${esc(d.first)} &rarr; ${esc(d.last)}</div>` +
      `<div class=hero><span class=hnum>${num(grand)}</span><span class=hlab>pages, all&#8209;time</span></div>` +
      `<div class=cmyk><i style="background:#0098d4"></i><i style="background:#e5007e"></i><i style="background:#f5b500"></i><i style="background:#16130f"></i></div>` +
      `<div class=tools><button data-a=copy>Copy report</button><button data-a=json>Download JSON</button><button data-a=csv>Download CSV</button></div>` +
      `<h2 class=sec>Annual totals</h2><div class=annual>${annualRows}</div>` +
      `<h2 class=sec>Monthly breakdown</h2><div class=monthly>${monthBlocks}</div>` +
      `<div class=foot>Generated ${esc(new Date().toLocaleString())} &middot; the ASCII version is on &ldquo;Copy report&rdquo;.</div>` +
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
