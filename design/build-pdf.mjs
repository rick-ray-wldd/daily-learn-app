#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Regenerate every print artefact in this folder from its HTML source.
//
//     node design/build-pdf.mjs            # everything
//     node design/build-pdf.mjs poster     # only the A2 posters
//     node design/build-pdf.mjs deck       # only the 16:9 decks
//
// The HTML is the source; the PDFs are build output. Edit the HTML,
// re-run this — editing a PDF directly means the next run silently
// throws your change away.
//
// ── Why this drives Chrome over DevTools Protocol ───────────────────
// Chrome's `--print-to-pdf` CLI flag **ignores `@page { size: … }`** and
// hands back US Letter (216 × 279 mm) — measured, not assumed. Only
// `Page.printToPDF` with `preferCSSPageSize` honours the CSS page size,
// which is what keeps the paper size defined in the stylesheet where
// the rest of the design lives. The alternative — ⌘P by hand — makes
// someone re-enter a custom paper size every time and checks nothing.
//
// Zero dependencies: Node ≥ 22 ships a global WebSocket, which is all
// CDP needs.
// ─────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * Paper sizes, in mm. `slide` is Google Slides' 16:9 — keeping that exact
 * size means the PDF drops into a Slides deck without being re-scaled.
 */
const PAPER = {
  a2:    { mm: [420, 594] },
  slide: { mm: [338.67, 190.5] },
};

/**
 * `root` is the selector for one printed page. A poster has exactly one;
 * a deck has one per slide, so its expected page count is however many
 * the document contains rather than a number written here (which would
 * go stale the moment a slide is added).
 *
 * `pair` groups the language editions whose <style> blocks are meant to
 * be identical — see checkDrift().
 */
const TARGETS = [
  { kind: 'poster', pair: 'poster', paper: 'a2',    root: '.poster', label: 'Poster 中文',
    src: 'poster-pre-demo-day.html',    out: 'poster-pre-demo-day.pdf' },
  { kind: 'poster', pair: 'poster', paper: 'a2',    root: '.poster', label: 'Poster EN',
    src: 'poster-pre-demo-day-en.html', out: 'poster-pre-demo-day-en.pdf' },
  { kind: 'deck',   pair: 'deck',   paper: 'slide', root: '.slide',  label: 'Deck 中文',
    src: 'deck-demo-day.html',          out: 'deck-demo-day.pdf' },
  { kind: 'deck',   pair: 'deck',   paper: 'slide', root: '.slide',  label: 'Deck EN',
    src: 'deck-demo-day-en.html',       out: 'deck-demo-day-en.pdf' },
];

// ── drift check ──────────────────────────────────────────────────────
// Each language edition carries a duplicate <style> block so it stays a
// self-contained, publishable page. Duplication is only safe if someone
// notices when they diverge — so: notice. Comments are stripped first,
// since each file is allowed its own header note.
//
// ⚠️ This covers the <style> block ONLY. The SVG and the copy below it
// can drift silently, and have: the timeline once drew a 30 s band under
// a "↺ 15s" arrow in all four files at once. Nothing here catches that.
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

async function checkDrift(targets) {
  const pairs = new Map();
  for (const t of targets) {
    if (!pairs.has(t.pair)) pairs.set(t.pair, []);
    pairs.get(t.pair).push(t);
  }

  let clean = true;
  for (const [name, group] of pairs) {
    if (group.length < 2) continue;
    const css = await Promise.all(
      group.map((t) => readFile(join(DIR, t.src), 'utf8').then(extractCss)),
    );
    const [base, ...rest] = css;
    if (base === null) continue;

    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === base || rest[i] === null) continue;
      clean = false;
      const la = base.split('\n');
      const lb = rest[i].split('\n');
      const diffs = [];
      for (let n = 0; n < Math.max(la.length, lb.length) && diffs.length < 8; n++) {
        if (la[n] !== lb[n]) {
          diffs.push(
            `  line ${n + 1}\n` +
            `    ${group[0].label}: ${la[n] ?? '—'}\n` +
            `    ${group[i + 1].label}: ${lb[n] ?? '—'}`,
          );
        }
      }
      console.warn(`⚠️  ${name}: 兩份 <style> 已經不一致 —— 兩個版本不會長得一樣：`);
      console.warn(diffs.join('\n'));
      console.warn('   （照樣繼續產生 PDF）\n');
    }
  }
  return clean;
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
 * Does the content actually fit inside each page frame?
 *
 * Both layouts hide their own overflow: `.poster` is a grid whose middle
 * row is `1fr`, so when a column grows past its allotted row the grid
 * does NOT get taller — the content just spills out the bottom; `.slide`
 * says `overflow: hidden` outright. `scrollHeight` misses both (measured:
 * it reported a clean fit while the PDF was losing the whole footer).
 *
 * So measure what can't lie: the lowest painted edge of any descendant,
 * relative to the bottom of the frame it is supposed to live in.
 */
/**
 * 內容裝不裝得下。
 *
 * ⚠️ 前兩版都量錯，而且錯得會給假通過：
 *
 *   ① 量「最深元素的底部」——`.poster` 是 grid、中間那列是 `1fr`，footer 的座標
 *      被那一列頂在固定高度，所以不管內容多長，量到的永遠是同一個數字（實測：
 *      刪掉整整三行文案，數字一動也不動）。
 *   ② 量 `.poster` 的盒高——它宣告了 `height: 594mm`，盒子被夾住，永遠回 594.00。
 *      配上 `overflow: hidden` 之後更糟：內容被剪掉了，量出來還是「剛好」。
 *
 * 唯一預測得準的是**把 grid 的每一列高度加起來**，再加 gap 與 padding，
 * 跟紙張比。實測 602.1 > 594 的那一次，正是印出來被裁掉的那一次。
 */
const fitExpr = (sel, wmm, hmm) => `(async () => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
  await document.fonts.ready;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const MM = 96 / 25.4;
  const px = v => parseFloat(v) || 0;

  const deepestIn = (root) => {
    let d = -Infinity;
    for (const el of root.querySelectorAll('*')) {
      if (el.closest('svg') && el.tagName !== 'svg') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.bottom > d) d = r.bottom;
    }
    return d;
  };

  const pages = els.map((el) => {
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const innerBottom = box.bottom - px(cs.paddingBottom);
    let overflow = 0, worst = null, text = null;

    const note = (amount, node) => {
      if (amount > overflow) {
        overflow = amount;
        worst = (node.className || node.tagName).toString().split(' ')[0];
        text = (node.textContent || '').trim().slice(0, 48);
      }
    };

    for (const row of el.children) {
      const rb = row.getBoundingClientRect();
      const d = deepestIn(row);
      if (d > -Infinity) note(d - rb.bottom, row);
    }
    const all = deepestIn(el);
    if (all > -Infinity) note(all - innerBottom, el);

    return {
      used: +((Math.max(...[...el.children].map(c => c.getBoundingClientRect().bottom)) - box.top) / MM).toFixed(1),
      overflow: +(overflow / MM).toFixed(1),
      worst, text,
    };
  });

  return JSON.stringify({ count: els.length, pages });
})()`;

/** Page size actually baked into the PDF, read back from its MediaBox. */
async function measure(file) {
  const buf = await readFile(file);
  const m = buf
    .toString('latin1')
    .match(/MediaBox\s*\[\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/);
  if (!m) return null;
  return [+m[1], +m[2]].map((pt) => (pt * 25.4) / 72);
}

/**
 * How many pages the PDF actually has — the one measurement that cannot
 * be fooled.
 *
 * The DOM-side fit check above under-reports: `.poster` is a grid whose
 * middle row is `1fr`, so the footer's box stays pinned at the same
 * coordinate whether or not the content above it fits, and every
 * `getBoundingClientRect()` agrees the page is fine. Meanwhile Chrome
 * quietly pushes the overflow onto the next sheet — measured: a poster
 * that reported "587.6 / 594 mm, fits" came out as a 2-page PDF with the
 * last line of the footer stranded on the second sheet.
 *
 * A poster is one sheet; a deck is one sheet per slide. Anything else is
 * broken.
 */
async function pageCount(file) {
  const s = (await readFile(file)).toString('latin1');

  // The page tree is a TREE, and Chrome nests it once a document has more
  // than a handful of pages — so the first `/Count` in the byte stream
  // belongs to some subtree, not the document. Measured: a 10-slide deck
  // whose first `/Count` read 8 (subtrees of 8 and 2 under a root of 10).
  // The root is the only `/Pages` node with no `/Parent`; its count is the
  // real total. Splitting on `endobj` gives exactly one object per chunk,
  // so `/Parent` in a chunk belongs to that object and no other.
  const counts = [];
  for (const obj of s.split(/\bendobj\b/)) {
    if (!/\/Type\s*\/Pages\b/.test(obj)) continue;
    const c = obj.match(/\/Count\s+(\d+)/);
    if (!c) continue;
    if (!/\/Parent\b/.test(obj)) return +c[1];
    counts.push(+c[1]);
  }
  if (counts.length) return Math.max(...counts);
  return (s.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

async function render(target) {
  const { src, out, label, root } = target;
  const [wmm, hmm] = PAPER[target.paper].mm;
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
    // on them — printing early yields a subtly different page.
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
      expression: fitExpr(root, wmm, hmm), awaitPromise: true, returnByValue: true,
    });
    const fit = JSON.parse(fitRaw.result.value);
    await cdp.send('Page.reload', {});
    await sleep(900);

    const { data } = await cdp.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,   // ← the @page rule in the stylesheet wins
      paperWidth: wmm / 25.4,    //   these two only apply if it goes missing
      paperHeight: hmm / 25.4,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
      scale: 1,
      landscape: false,
    });

    const dest = join(DIR, out);
    await writeFile(dest, Buffer.from(data, 'base64'));
    cdp.close();

    const size = await measure(dest);
    const kb = Math.round((await stat(dest)).size / 1024);
    // Chrome writes the MediaBox in whole points, so 420 mm comes back as
    // 420.19. Within tolerance, report the size that was asked for; report
    // what actually landed only when it is wrong, which is when it matters.
    const sizeOk = size && Math.abs(size[0] - wmm) <= 1 && Math.abs(size[1] - hmm) <= 1;
    const dims = !size ? 'size unknown'
      : sizeOk ? `${wmm} × ${hmm} mm`
      : `${size.map((v) => +v.toFixed(1)).join(' × ')} mm`;

    const pages = await pageCount(dest);
    const pagesOk = pages === fit.count;
    // A frame that hides its overflow prints clipped rather than paginating,
    // so the page count stays right while content silently disappears.
    const spills = fit.pages.filter((p) => p.overflow > 0.5);
    const pass = sizeOk && pagesOk && spills.length === 0;

    const detail = fit.count === 1
      ? `內容約 ${fit.pages[0].used} mm`
      : `${fit.count} 張，最滿 ${Math.max(...fit.pages.map((p) => p.used))} mm`;

    console.log(
      `${pass ? '✓' : '✗'} ${label.padEnd(12)} ${out.padEnd(30)} ` +
      `${String(kb).padStart(5)} KB   ${dims}   ${pages} 頁   ${detail}`,
    );
    if (!sizeOk) {
      console.error(`   ⚠️  期待 ${wmm} × ${hmm} mm。檢查 @page 那一行還在不在。`);
    }
    if (!pagesOk) {
      console.error(`   ⚠️  ${fit.count} 個 ${root} 卻印出 ${pages} 頁 —— 有內容溢到多出來的紙上。`);
      console.error('       改法：刪文案（最有效），或把兩份 <style> 的 gap / font-size 一起再縮一點。');
    }
    // 逐張報告：多頁目標（簡報）要講出是第幾張，單頁目標（海報）講「第 1 張」
    // 只是噪音。索引取自 fit.pages 的原始位置，不是 spills 的位置。
    for (const p of spills) {
      const where = fit.count > 1 ? `第 ${fit.pages.indexOf(p) + 1} 張` : '';
      console.error(
        `   ⚠️  ${where}超出邊界 ${p.overflow} mm，會被裁掉：.${p.worst}  「${p.text}」`,
      );
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
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = only.length
  ? TARGETS.filter((t) => only.includes(t.kind) || only.some((o) => t.src.includes(o)))
  : TARGETS;

if (targets.length === 0) {
  console.error(`沒有符合的目標：${only.join(' ')}`);
  console.error(`可用的：poster · deck · ${TARGETS.map((t) => t.src).join(' · ')}`);
  process.exit(1);
}

await checkDrift(targets);

let allOk = true;
for (const t of targets) allOk = (await render(t)) && allOk;

console.log(
  allOk
    ? '\n全部尺寸正確、頁數正確、沒有內容被裁掉，可以直接送印／上傳。'
    : '\n有目標沒過 —— 送印前先修好。',
);
process.exit(allOk ? 0 : 1);
