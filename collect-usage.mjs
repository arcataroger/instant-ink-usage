#!/usr/bin/env node
/**
 * Collect the full HP Instant Ink usage history for a subscription and print
 * an annual summary + per-year monthly breakdown of pages printed, each shown
 * as a number and an ASCII bar chart.
 *
 * How it works
 * ------------
 * The HP Instant Ink dashboard (portal.hpsmart.com) talks to:
 *
 *   GET /api/dashboard/v1/subscription/{sub}/activities
 *        -> list of account events; every "Billed"/"Prepaid" payment_event
 *           carries an invoice_download_link of the form
 *           /api/dashboard/v1/billing_cycles/{cycleId}/pdf  ← the month index
 *
 *   GET /api/dashboard/v1/subscription/{sub}/billing_cycle/{cycleId}
 *        -> one billing cycle, including daily_usage.{regular,rollover,overage,
 *           trial,credit_pages}[] where each point is {x: <days since
 *           1970-01-01>, y: <pages printed that day>}. Summing y across every
 *           series equals totals.total_pages (verified), i.e. the real pages
 *           printed that cycle. Cycles run ~25th→24th, so each day is bucketed
 *           into its true calendar month/year for exact annual/monthly totals.
 *
 * Credentials (bearer token + subscription id) and, optionally, already-captured
 * responses are read straight out of any *.har file in this directory, so the
 * normal workflow is: export a fresh HAR from the dashboard, then `npm run usage`.
 *
 * Auth precedence: --token/--sub flags > INSTANTINK_TOKEN/INSTANTINK_SUBSCRIPTION
 * env vars > Authorization header + subscription id auto-extracted from a *.har.
 */

import { readdir, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const API_HOST = "https://instantink.hpconnected.com";
const EPOCH = Date.UTC(1970, 0, 1);
const CACHE_DIR = path.resolve("cache");
const REQUEST_DELAY_MS = 150;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { refresh: false, offline: false, token: null, sub: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--refresh") out.refresh = true;
    else if (a === "--offline") out.offline = true;
    else if (a === "--token") out.token = argv[++i];
    else if (a === "--sub") out.sub = argv[++i];
    else if (a === "--json") out.json = argv[++i] ?? "usage-summary.json";
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`Usage: npm run usage [-- options]

Options:
  --refresh        Ignore the on-disk cache and re-fetch every cycle.
  --offline        Don't make network calls; use only data found in *.har / cache.
  --token <bearer> Authorization header value (e.g. "Bearer eyJ...").
  --sub <id>       Subscription id (defaults to the one found in a *.har).
  --json [file]    Also write the structured summary to a JSON file.
  -h, --help       Show this help.

By default, credentials and any captured responses are read from *.har files
in the current directory. Tokens expire (~1h), so export a fresh HAR and run
soon after.`);
}

// ---------------------------------------------------------------------------
// HAR parsing
// ---------------------------------------------------------------------------
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function loadHarFiles(dir) {
  let names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".har"));
  // Process oldest → newest so the most recently exported HAR wins for the
  // bits where "last write wins" (token, subscription id, activities list).
  const withMtime = await Promise.all(
    names.map(async (n) => ({ n, mtime: (await stat(path.join(dir, n))).mtimeMs }))
  );
  names = withMtime.sort((a, b) => a.mtime - b.mtime).map((x) => x.n);
  const seed = {
    token: null,
    sub: null,
    activities: null, // array of activity objects
    cycles: new Map(), // cycleId -> parsed billing_cycle response
  };

  for (const name of names) {
    const har = safeJson(await readFile(path.join(dir, name), "utf8"));
    const entries = har?.log?.entries;
    if (!Array.isArray(entries)) continue;

    for (const e of entries) {
      const url = e?.request?.url || "";
      if (!url.startsWith(API_HOST)) continue;

      // subscription id + bearer token (last one wins → freshest export)
      const subMatch = url.match(/\/subscription\/(\d+)/);
      if (subMatch) seed.sub = subMatch[1];
      const auth = e.request.headers?.find((h) => h.name.toLowerCase() === "authorization");
      if (auth?.value) seed.token = auth.value;

      const body = e?.response?.content?.text;
      if (!body) continue;
      const json = safeJson(body);
      if (!json) continue;

      if (url.endsWith("/activities") && Array.isArray(json.activities)) {
        seed.activities = json.activities;
      }
      const cycMatch = url.match(/\/billing_cycle\/(\d+)(?:[/?#]|$)/);
      if (cycMatch && json.totals) {
        seed.cycles.set(cycMatch[1], json);
      }
    }
  }
  return seed;
}

/** Pull ordered, de-duplicated billing-cycle ids out of the activities list. */
function cycleIdsFromActivities(activities) {
  const ids = [];
  const seen = new Set();
  for (const a of activities) {
    const link = a?.activity?.invoice_download_link;
    const m = typeof link === "string" && link.match(/\/billing_cycles\/(\d+)\//);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  return ids; // newest first (activities come newest-first)
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authHeaders(token) {
  return {
    Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    Accept: "application/json, text/plain, */*",
    Origin: "https://portal.hpsmart.com",
    Referer: "https://portal.hpsmart.com/",
    "User-Agent": "instantink-usage-script",
  };
}

async function apiGet(url, token) {
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Auth rejected (HTTP ${res.status}). Your bearer token has likely expired — ` +
        `export a fresh .har from the dashboard (or pass --token) and run again.`
    );
  }
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

async function readCache(id) {
  const file = path.join(CACHE_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  return safeJson(await readFile(file, "utf8"));
}

async function writeCache(id, data) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, `${id}.json`), JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
function ymFromSerial(x) {
  const d = new Date(EPOCH + x * 86400000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() }; // month 0-11
}

/** Add a billing cycle's daily pages into the year/month accumulators. */
function accumulate(cycle, byYear, byYearMonth) {
  const du = cycle.daily_usage || {};
  let cycleTotal = 0;
  for (const series of Object.values(du)) {
    if (!Array.isArray(series)) continue;
    for (const pt of series) {
      const pages = pt?.y || 0;
      if (!pages) continue;
      cycleTotal += pages;
      const { year, month } = ymFromSerial(pt.x);
      byYear.set(year, (byYear.get(year) || 0) + pages);
      const key = `${year}-${month}`;
      byYearMonth.set(key, (byYearMonth.get(key) || 0) + pages);
    }
  }
  return cycleTotal;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const PARTIALS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

function bar(value, max, width = 40) {
  if (max <= 0 || value <= 0) return "";
  const units = (value / max) * width;
  const whole = Math.floor(units);
  const rem = Math.round((units - whole) * 8);
  let s = "█".repeat(whole);
  if (rem > 0) s += PARTIALS[rem];
  return s || "▏";
}

const num = (n) => n.toLocaleString("en-US");

function renderReport({ sub, cycleCount, firstDay, lastDay, byYear, byYearMonth }) {
  const lines = [];
  const rule = "─".repeat(64);

  lines.push("");
  lines.push("HP Instant Ink — Pages Printed");
  lines.push(
    `Subscription ${sub} · ${cycleCount} billing cycles · ${firstDay} → ${lastDay}`
  );
  lines.push(rule);

  const years = [...byYear.keys()].sort((a, b) => a - b);
  const grandTotal = [...byYear.values()].reduce((a, b) => a + b, 0);

  // --- Annual summary ---
  lines.push("");
  lines.push("ANNUAL TOTALS");
  const annualMax = Math.max(0, ...byYear.values());
  const annualNumW = Math.max(...years.map((y) => num(byYear.get(y) || 0).length));
  for (const y of years) {
    const v = byYear.get(y) || 0;
    lines.push(`  ${y}  ${num(v).padStart(annualNumW)}  ${bar(v, annualMax)}`);
  }
  lines.push(`  ${"────"}  ${"".padStart(annualNumW)}`);
  lines.push(`  All   ${num(grandTotal).padStart(annualNumW)} pages total`);

  // --- Monthly breakdown per year ---
  lines.push("");
  lines.push("MONTHLY BREAKDOWN");
  const monthMax = Math.max(0, ...byYearMonth.values());
  const monthNumW = num(monthMax).length;
  for (const y of years) {
    const yearTotal = byYear.get(y) || 0;
    lines.push("");
    lines.push(`── ${y} ──  (${num(yearTotal)} pages)`);
    for (let m = 0; m < 12; m++) {
      const v = byYearMonth.get(`${y}-${m}`) || 0;
      lines.push(`  ${MONTHS[m]}  ${num(v).padStart(monthNumW)}  ${bar(v, monthMax)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  if (typeof fetch !== "function") {
    console.error("This script needs Node 18+ (global fetch). Current:", process.version);
    process.exit(1);
  }

  const cwd = process.cwd();
  const seed = await loadHarFiles(cwd);

  const token = args.token || process.env.INSTANTINK_TOKEN || seed.token;
  const sub = args.sub || process.env.INSTANTINK_SUBSCRIPTION || seed.sub;

  if (!sub) {
    console.error("No subscription id found. Pass --sub <id> or include a *.har file.");
    process.exit(1);
  }

  // Month index: from the activities response (HAR) or live.
  let activities = seed.activities;
  if (!activities && !args.offline) {
    if (!token) {
      console.error(
        "No activities list in any *.har and no token to fetch it. " +
          "Export a HAR of the usage/activity page, or pass --token."
      );
      process.exit(1);
    }
    console.error("Fetching activity list…");
    const data = await apiGet(`${API_HOST}/api/dashboard/v1/subscription/${sub}/activities`, token);
    activities = data.activities || [];
  }
  if (!activities) {
    console.error("No activities list available (offline mode and none in *.har).");
    process.exit(1);
  }

  const cycleIds = cycleIdsFromActivities(activities);
  if (cycleIds.length === 0) {
    console.error("Found the activity list but no billing-cycle invoice links in it.");
    process.exit(1);
  }
  console.error(`Found ${cycleIds.length} billing cycles. Collecting…`);

  // Seed the on-disk cache with any cycles already captured in HAR files.
  for (const [id, data] of seed.cycles) await writeCache(id, data);

  const byYear = new Map();
  const byYearMonth = new Map();
  const dayKeys = []; // ISO yyyy-mm-dd of every active day, to report the real span
  let fetched = 0;
  let fromCache = 0;
  let failures = 0;

  for (let i = 0; i < cycleIds.length; i++) {
    const id = cycleIds[i];
    const isNewest = i === 0; // newest cycle may still be in progress → prefer fresh
    let cycle = null;

    if (!args.refresh && !(isNewest && !args.offline)) {
      cycle = await readCache(id);
      if (cycle) fromCache++;
    }
    if (!cycle && !args.offline) {
      if (!token) {
        console.error(`  ! cycle ${id}: not cached and no token to fetch; skipping.`);
        failures++;
        continue;
      }
      try {
        cycle = await apiGet(
          `${API_HOST}/api/dashboard/v1/subscription/${sub}/billing_cycle/${id}`,
          token
        );
        await writeCache(id, cycle);
        fetched++;
        await sleep(REQUEST_DELAY_MS);
      } catch (err) {
        console.error(`  ! cycle ${id}: ${err.message}`);
        failures++;
        if (/expired|401|403/.test(err.message)) break; // no point continuing
        continue;
      }
    }
    if (!cycle) {
      // offline and not cached
      failures++;
      continue;
    }

    accumulate(cycle, byYear, byYearMonth);
    for (const series of Object.values(cycle.daily_usage || {})) {
      if (!Array.isArray(series)) continue;
      for (const pt of series) {
        if (pt?.y > 0) dayKeys.push(new Date(EPOCH + pt.x * 86400000).toISOString().slice(0, 10));
      }
    }
  }

  if (byYear.size === 0) {
    console.error("No usage data could be collected.");
    process.exit(1);
  }

  dayKeys.sort();
  const report = renderReport({
    sub,
    cycleCount: cycleIds.length - failures,
    firstDay: dayKeys[0] || "?",
    lastDay: dayKeys[dayKeys.length - 1] || "?",
    byYear,
    byYearMonth,
  });

  console.error(
    `Done. ${fetched} fetched, ${fromCache} from cache` +
      (failures ? `, ${failures} unavailable.` : ".")
  );
  console.log(report);

  if (args.json) {
    const out = {
      subscription: sub,
      generated_at: new Date().toISOString(),
      annual: Object.fromEntries([...byYear.entries()].sort((a, b) => a[0] - b[0])),
      monthly: Object.fromEntries(
        [...byYearMonth.entries()].sort().map(([k, v]) => {
          const [y, m] = k.split("-");
          return [`${y}-${String(+m + 1).padStart(2, "0")}`, v];
        })
      ),
    };
    await writeFile(args.json, JSON.stringify(out, null, 2));
    console.error(`Wrote ${args.json}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
