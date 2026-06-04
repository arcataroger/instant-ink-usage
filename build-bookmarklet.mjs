#!/usr/bin/env node
/**
 * Build the distributable bookmarklet from bookmarklet.src.js:
 *
 *   build/bookmarklet.txt   the raw `javascript:` URL (paste into a bookmark)
 *   docs/index.html         install page with a draggable button (served by
 *                           GitHub Pages, and openable locally by double-click)
 *
 * We URL-encode the entire source rather than minify it: encoded newlines
 * (%0A) survive, so `//` line comments stay correctly terminated and none of
 * the regexes/strings get mangled. encodeURIComponent output contains no HTML
 * special characters, so the URL is safe to drop straight into an href="...".
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";

const here = (p) => new URL(p, import.meta.url);
const src = await readFile(here("./bookmarklet.src.js"), "utf8");

// Trailing `;void 0` makes the script's completion value undefined so the
// browser doesn't try to navigate to the async IIFE's returned Promise.
const url = "javascript:" + encodeURIComponent(src + "\n;void 0");

await mkdir(here("./build"), { recursive: true });
await writeFile(here("./build/bookmarklet.txt"), url + "\n");

const REPO = "https://github.com/arcataroger/instant-ink-usage";
const PORTAL = "https://portal.hpsmart.com/us/en/print_plans/account_history";

const indexHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install · Instant Ink Usage</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#f6f2e7; background-image:radial-gradient(circle at 1px 1px,rgba(22,19,15,.05) 1px,transparent 0);
    background-size:15px 15px; color:#16130f; padding:40px 20px;
    font-family:ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace; line-height:1.6; }
  .card { width:100%; max-width:620px; }
  .eyebrow { font-size:11px; letter-spacing:.3em; text-transform:uppercase; color:#8f8676; }
  h1 { font:900 clamp(34px,7vw,52px)/1 Georgia,"Hoefler Text",serif; letter-spacing:-.02em; margin:.2em 0 .1em; }
  .cmyk { display:flex; height:6px; width:118px; margin:16px 0 22px; }
  .cmyk i { flex:1; }
  p { font-size:14.5px; }
  .lead { font-size:16px; }
  .step { display:flex; gap:14px; align-items:flex-start; margin:18px 0; }
  .n { flex:none; width:30px; height:30px; border-radius:50%; background:#16130f; color:#f6f2e7;
    display:flex; align-items:center; justify-content:center; font-weight:700; font-size:14px; }
  .step div { padding-top:3px; }
  .drag { display:inline-block; margin:6px 0; padding:14px 24px; background:#e5007e; color:#fff;
    text-decoration:none; border-radius:4px; font-weight:700; letter-spacing:.02em; cursor:grab;
    box-shadow:0 6px 0 #b30062; user-select:none; }
  .drag:active { cursor:grabbing; transform:translateY(2px); box-shadow:0 4px 0 #b30062; }
  a { color:#0077b3; }
  a.btn2 { display:inline-block; margin-top:4px; padding:9px 16px; border:1.5px solid #16130f;
    border-radius:3px; color:#16130f; text-decoration:none; font-size:12.5px; cursor:pointer; }
  a.btn2:hover, #copy:hover { background:#16130f; color:#f6f2e7; }
  #copy { font:inherit; font-size:12.5px; margin-top:4px; padding:9px 16px; border:1.5px solid #16130f;
    border-radius:3px; background:transparent; color:#16130f; cursor:pointer; }
  .hint { font-size:12.5px; color:#6e675a; }
  hr { border:none; border-top:1px solid rgba(22,19,15,.15); margin:30px 0; }
  .shot { width:100%; border:1px solid rgba(22,19,15,.15); border-radius:6px; margin-top:10px; }
</style>
</head>
<body>
<div class="card">
  <div class="eyebrow">HP Instant Ink · Usage Statement</div>
  <h1>Instant Ink Usage</h1>
  <div class="cmyk"><i style="background:#0098d4"></i><i style="background:#e5007e"></i><i style="background:#f5b500"></i><i style="background:#16130f"></i></div>
  <p class="lead">A one-click button that shows your whole HP Instant Ink printing history —
  how many pages you've printed each month and each year. It runs in your own browser using
  the HP login you already have.</p>

  <hr>

  <div class="step"><div class="n">1</div><div>
    <strong>Drag this button up to your bookmarks bar:</strong><br>
    <a class="drag" href="${url}">📊 Instant Ink Usage</a>
    <div class="hint">Can't drag? <button id="copy">Copy the code</button> then make a new
    bookmark and paste it as the address. <span id="copied" style="color:#0098d4"></span></div>
  </div></div>

  <div class="step"><div class="n">2</div><div>
    <strong>Open your HP Instant Ink history and sign in:</strong><br>
    <a class="btn2" href="${PORTAL}" target="_blank" rel="noopener">Open Print &amp; Payment History →</a>
    <div class="hint">This is HP's own page (portal.hpsmart.com). Log in there like normal.</div>
  </div></div>

  <div class="step"><div class="n">3</div><div>
    <strong>Click the “Instant Ink Usage” bookmark.</strong><br>
    <span class="hint">Your report appears right on the page. You can copy it or download it
    as a spreadsheet (CSV) or JSON file.</span>
  </div></div>

  <hr>
  <p class="hint">Free &amp; open source (public domain). Want the details, the code, or to
  see exactly what it does? <a href="${REPO}">Read more on GitHub →</a></p>
  <img class="shot" src="screenshot.png" alt="Example of the usage report">
</div>
<script>
  document.getElementById("copy").addEventListener("click", async function () {
    try { await navigator.clipboard.writeText(document.querySelector(".drag").getAttribute("href"));
      document.getElementById("copied").textContent = "Copied!"; } catch (e) {}
  });
</script>
</body>
</html>
`;
await mkdir(here("./docs"), { recursive: true });
await writeFile(here("./docs/index.html"), indexHtml);

console.log(`Built build/bookmarklet.txt (${url.length} chars) and docs/index.html`);
