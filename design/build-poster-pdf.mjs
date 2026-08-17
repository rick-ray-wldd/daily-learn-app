#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Regenerate the A2 poster PDFs from their HTML sources.
//
//     node design/build-poster-pdf.mjs
//
// The HTML is the source; the PDFs are build output. Edit the HTML,
// re-run this — editing a PDF directly means the next run silently
// throws your change away.
//
// ── Why this drives Chrome over DevTools Protocol ───────────────────
// Chrome's `--print-to-pdf` CLI flag **ignores `@page { size: A2 }`**
// and hands back US Letter (216 × 279 mm) — measured, not assumed.
// Only `Page.printToPDF` with `preferCSSPageSize` honours the CSS page
// size, which is what keeps the paper size defined in the stylesheet
// where the rest of the design lives.
//
// Zero dependencies: Node ≥ 22 ships a global WebSocket, which is all
// CDP needs.
// ─────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const POSTERS = [
  { src: 'poster-pre-demo-day.html',    out: 'poster-pre-demo-day.pdf',    label: '中文' },
  { src: 'poster-pre-demo-day-en.html', out: 'poster-pre-demo-day-en.pdf', label: 'English' },
];

/** A2 portrait, in inches — the fallback if the CSS @page goes missing. */
const A2 = { w: 420 / 25.4, h: 594 / 25.4 };
const EXPECT_MM = [420, 594];

// ── drift check ──────────────────────────────────────────────────────
// The two posters carry duplicate <style> blocks so each stays a
// self-contained, publishable page. Duplication is only safe if someone
// notices when they diverge — so: notice. Comments are stripped first,
// since each file is allowed its own header note.
function extractCss(html) {
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!m) return null;
  return m[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .join('\n');
}

async function checkDrift() {
  const [a, b] = await Promise.all(
    POSTERS.map((p) => readFile(join(DIR, p.src), 'utf8').then(extractCss)),
  );
  if (a === null || b === null) return;
  if (a === b) return;

  const la = a.split('\n');
  const lb = b.split('\n');
  const diffs = [];
  for (let i = 0; i < Math.max(la.length, lb.length) && diffs.length < 8; i++) {
    if (la[i] !== lb[i]) diffs.push(`  line ${i + 1}\n    中文: ${la[i] ?? '—'}\n    EN  : ${lb[i] ?? '—'}`);
  }
  console.warn('⚠️  兩份 <style> 已經不一致 — 兩張海報不會長得一樣：');
  console.warn(diffs.join('\n'));
  console.warn('   （照樣繼續產生 PDF）\n');
}

// ── minimal CDP client ───────────────────────────────────────────────
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    };
    ws.onerror = () => reject(new Error(`CDP socket failed: ${url}`));
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const n = ++id;
            pending.set(n, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: n, method, params }));
          }),
        close: () => ws.close(),
      });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* Chrome not listening yet */
    }
    await sleep(200);
  }
  throw new Error('Chrome never exposed a page target');
}

async function readPort(profile, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const txt = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      const port = parseInt(txt.split('\n')[0], 10);
      if (port > 0) return port;
    } catch {
      /* not written yet */
    }
    await sleep(200);
  }
  throw new Error('Chrome never wrote DevToolsActivePort');
}

/**
 * Does the content actually fit on the page?
 *
 * `.poster` is a grid whose middle row is `1fr`, so when the columns
 * grow past their allotted row the grid does NOT get taller — the
 * column content just spills out the bottom and the printer silently
 * crops it. `scrollHeight` misses this entirely (measured: it reported
 * a clean fit while the PDF was losing the whole footer).
 *
 * So measure what can't lie: the lowest painted edge of any descendant,
 * relative to the top of the page.
 */
const FIT_EXPR = `(async () => {
  const p = document.querySelector('.poster');
  p.style.setProperty('width', '420mm', 'important');
  p.style.setProperty('height', '594mm', 'important');
  p.style.setProperty('aspect-ratio', 'auto', 'important');
  await document.fonts.ready;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const top = p.getBoundingClientRect().top;
  const limit = p.getBoundingClientRect().bottom;
  let worst = null, worstBottom = -Infinity;
  for (const el of p.querySelectorAll('*')) {
    if (el.closest('svg') && el.tagName !== 'svg') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.bottom > worstBottom) { worstBottom = r.bottom; worst = el; }
  }
  const mm = px => +(px / (96 / 25.4)).toFixed(1);
  return JSON.stringify({
    overflow: mm(worstBottom - limit),
    used: mm(worstBottom - top),
    worst: worst ? (worst.className || worst.tagName).toString().split(' ')[0] : null,
    text: worst ? worst.textContent.trim().slice(0, 48) : null,
  });
})()`;

/** Page size actually baked into the PDF, read back from its MediaBox. */
async function measure(file) {
  const buf = await readFile(file);
  const m = buf
    .toString('latin1')
    .match(/MediaBox\s*\[\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/);
  if (!m) return null;
  return [+m[1], +m[2]].map((pt) => Math.round((pt * 25.4) / 72));
}

/**
 * How many pages the PDF actually has — the one measurement that cannot
 * be fooled.
 *
 * The DOM-side fit check above under-reports: `.poster` is a grid whose
 * middle row is `1fr`, so the footer's box stays pinned at the same
 * coordinate whether or not the content above it fits, and every
 * `getBoundingClientRect()` agrees the page is fine. Meanwhile Chrome
 * quietly pushes the overflow onto page 2 — measured: a poster that
 * reported "587.6 / 594 mm, fits" came out as a 2-page PDF with the
 * last line of the footer stranded on the second sheet.
 *
 * A poster is one sheet. If this returns anything but 1, it is broken.
 */
async function pageCount(file) {
  const s = (await readFile(file)).toString('latin1');
  const byCount = s.match(/\/Count\s+(\d+)/);
  if (byCount) return +byCount[1];
  return (s.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

async function render({ src, out, label }) {
  const profile = await mkdtemp(join(tmpdir(), 'echo-pdf-'));
  const url = pathToFileURL(join(DIR, src)).href;

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    url,
  ], { stdio: 'ignore' });

  try {
    const port = await readPort(profile);
    const cdp = await connect(await pageTarget(port));

    // Wait for layout to settle. Container queries resolve on first
    // layout, but fonts land a beat later and the type scale depends
    // on them — printing early yields a subtly different poster.
    for (let i = 0; i < 50; i++) {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: 'document.readyState === "complete" && document.fonts.status === "loaded"',
        returnByValue: true,
      });
      if (result.value === true) break;
      await sleep(100);
    }
    await sleep(300);

    // Fit check runs in a throwaway clone of the layout — force print
    // media first so any @media print rule is part of what we measure.
    await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
    const fitRaw = await cdp.send('Runtime.evaluate', {
      expression: FIT_EXPR, awaitPromise: true, returnByValue: true,
    });
    const fit = JSON.parse(fitRaw.result.value);
    await cdp.send('Page.reload', {});
    await sleep(900);

    const { data } = await cdp.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,   // ← the @page rule in the stylesheet wins
      paperWidth: A2.w,          //   these two only apply if it goes missing
      paperHeight: A2.h,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
      scale: 1,
      landscape: false,
    });

    const dest = join(DIR, out);
    await writeFile(dest, Buffer.from(data, 'base64'));
    cdp.close();

    const size = await measure(dest);
    const kb = Math.round((await stat(dest)).size / 1024);
    const dims = size ? `${size[0]} × ${size[1]} mm` : 'size unknown';
    const ok = size && Math.abs(size[0] - EXPECT_MM[0]) <= 1 && Math.abs(size[1] - EXPECT_MM[1]) <= 1;

    const pages = await pageCount(dest);
    const onePage = pages === 1;
    const pass = ok && onePage;

    console.log(
      `${pass ? '✓' : '✗'} ${label.padEnd(8)} ${out.padEnd(30)} ` +
      `${String(kb).padStart(5)} KB   ${dims}   ${pages} 頁   內容約 ${fit.used} mm`,
    );
    if (!ok) {
      console.error(`   ⚠️  期待 ${EXPECT_MM[0]} × ${EXPECT_MM[1]} mm。檢查 @page 那一行還在不在。`);
    }
    if (!onePage) {
      console.error(`   ⚠️  變成 ${pages} 頁 —— 尾巴掉到第 2 張紙上了，送印只會印到第 1 頁。`);
      console.error(`       最底下的元素：.${fit.worst}  「${fit.text}」`);
      console.error(`       改法：刪文案（最有效），或把兩份 <style> 的 gap / font-size 一起再縮一點。`);
    }
    return pass;
  } finally {
    chrome.kill();
    // Chrome keeps flushing its profile for a beat after SIGTERM, so a
    // prompt rmdir loses a race with it. The temp dir is disposable —
    // never let cleanup be the thing that fails the build.
    await sleep(600);
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* the OS will reap it from /tmp */ }
  }
}

// ── go ───────────────────────────────────────────────────────────────
await checkDrift();

let allOk = true;
for (const p of POSTERS) allOk = (await render(p)) && allOk;

console.log(
  allOk
    ? '\n兩份都是 A2 直式（420 × 594 mm）、無邊界，可以直接送印。'
    : '\n有 PDF 的尺寸不對 —— 送印前先修好。',
);
process.exit(allOk ? 0 : 1);
