#!/usr/bin/env node
/**
 * 從 `img/icon/echo-lockup-vertical.png` 產出版面用的完整 logo（立方體 ＋ Echo 字標）。
 *
 *     node design/build-lockup.mjs
 *
 * ## 為什麼不塞進 build-icons.mjs
 *
 * 那一支的整條管線是為 **app icon** 寫的：它會把來源橫向掃描、把立方體從底下的
 * 字標**切開**、量 bbox 與質心、再拿去對 `EXPECTED` 驗證。完整 logo 要的正好相反
 * ——連字標一起留。硬塞進去會變成在那支腳本裡加一堆 `if (!isLockup)`，而它現在
 * 每一步都有意義。兩支各自單純，比一支有兩種模式好。
 *
 * ## 這支要處理的三件事（都是實測出來的，不是通則）
 *
 * 1. **四邊各有 1px 灰框**（median 226–230）。其他三張來源沒有，只有這一張有。
 *    不裁掉，透明化之後會在版面上留一圈看得見的灰線。
 * 2. **白色 counter 是圖形的一部分**：喇叭的同心圓環、E/C/H 的字腔，都是被 ink
 *    四面包圍的白。用「白 → 透明」的全域閾值會把它們一起挖掉，logo 會散開。
 *    所以 alpha 走 **luminance keying**（暗＝不透明），而不是背景色去背。
 * 3. **邊緣被過度銳化**，有 1px ringing（暗側 undershoot、亮側 overshoot）。
 *    keying 出來的 alpha 邊會有點脆，所以最後做一次 0.4px 的羽化。
 *
 * 產出 `design/echo-lockup-print.png`：透明底、緊裁、ink 用 theme 的 #14191B
 * （不是純黑——那才跟海報／簡報上的文字是同一個黑）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const SRC = join(ROOT, "img", "icon", "echo-lockup-vertical.png");
const OUT = join(HERE, "echo-lockup-print.png");

/** 與 build-icons.mjs 的 PRINT_INK_HEX 一致。兩邊都改才不會一深一淺。 */
const INK_HEX = "14191B";
/** 輸出邊長上限。版面最大用量是海報標題右側 ~40mm；@300dpi = 472px。 */
const MAX_EDGE = 700;
/** 緊裁後四周留的透明邊，單位是輸出像素。0 會讓羽化的最外圈被切掉。 */
const PAD = 2;
/** ink 判定門檻（luminance）。素材邊緣極銳利，60..200 之間結果只差 ±1px。 */
const INK_T = 128;
/** 邊框裁切量。實測這張四邊各 1px 灰框；多裁 1px 當安全邊。 */
const BORDER_CROP = 2;

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

if (!existsSync(SRC)) fail(`找不到來源：${SRC}`);

const PY = String.raw`
import json, sys
from PIL import Image, ImageFilter

cfg = json.loads(sys.stdin.read())
INK_T = cfg["inkT"]; PAD = cfg["pad"]; CROP = cfg["borderCrop"]; MAX_EDGE = cfg["maxEdge"]

im = Image.open(cfg["src"])
if im.mode != "L":
    im = im.convert("L")            # ITU-R 601-2；素材是中性灰黑，轉 L 不損失資訊
W0, H0 = im.size

# ── 1. 裁掉四邊的灰框 ────────────────────────────────────────────────
im = im.crop((CROP, CROP, W0 - CROP, H0 - CROP))
W, H = im.size
px = im.load()

# ── 2. 完整 ink 的 bbox（立方體 + 字標，**不切開**）─────────────────
left, top, right, bottom = W, H, -1, -1
for y in range(H):
    row = None
    for x in range(W):
        if px[x, y] < INK_T:
            if row is None: row = x
            right = max(right, x)
    if row is not None:
        left = min(left, row)
        if top == H: top = y
        top = min(top, y)
        bottom = max(bottom, y)
if bottom < 0:
    print(json.dumps({"error": "來源裡找不到任何 ink"})); sys.exit(1)

bw, bh = right - left + 1, bottom - top + 1

# ── 3. luminance keying：暗 = 不透明 ────────────────────────────────
# 不用「白 → 透明」：喇叭圓環與字腔是被 ink 包圍的白，全域閾值會把它們挖掉。
crop = im.crop((left - 0, top - 0, right + 1, bottom + 1))
alpha = crop.point(lambda v: 255 - v)          # 255 = 全黑 = 不透明
alpha = alpha.filter(ImageFilter.GaussianBlur(0.4))   # 邊緣 ringing 的羽化
alpha = alpha.point(lambda v: 0 if v < 6 else v)      # 掃掉背景殘留的微弱值

ink = tuple(int(cfg["ink"][i:i+2], 16) for i in (0, 2, 4))
solid = Image.new("RGBA", crop.size, ink + (0,))
solid.putalpha(alpha)

# ── 4. 縮到目標尺寸並補透明邊 ───────────────────────────────────────
scale = min(1.0, MAX_EDGE / max(bw, bh))
nw, nh = max(1, round(bw * scale)), max(1, round(bh * scale))
solid = solid.resize((nw, nh), Image.LANCZOS)

out = Image.new("RGBA", (nw + PAD * 2, nh + PAD * 2), (0, 0, 0, 0))
out.alpha_composite(solid, (PAD, PAD))
out.save(cfg["out"], optimize=True)

print(json.dumps({
    "src_size": [W0, H0],
    "ink_bbox": [left, top, right, bottom],
    "ink_size": [bw, bh],
    "aspect_w_over_h": round(bw / bh, 4),
    "out_size": list(out.size),
}))
`;

const workerPath = join(tmpdir(), "echo-build-lockup.py");
writeFileSync(workerPath, PY);

let raw;
try {
  raw = execFileSync("python3", [workerPath], {
    input: JSON.stringify({
      src: SRC,
      out: OUT,
      ink: INK_HEX,
      pad: PAD,
      inkT: INK_T,
      borderCrop: BORDER_CROP,
      maxEdge: MAX_EDGE,
    }),
    encoding: "utf8",
  });
} catch (e) {
  fail(`python worker 掛了：\n${e.stderr || e.message}`);
}

const r = JSON.parse(raw.trim());
if (r.error) fail(r.error);

// ── 驗證：讀回真實檔案，不信任 python 自己的說法 ─────────────────────
const sips = execFileSync(
  "sips",
  ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", OUT],
  { encoding: "utf8" },
);
const g = (k) => (sips.match(new RegExp(`${k}:\\s*(\\S+)`)) || [])[1];
const w = Number(g("pixelWidth"));
const h = Number(g("pixelHeight"));
const hasAlpha = g("hasAlpha");

console.log(`  來源      ${r.src_size[0]}×${r.src_size[1]}  （已裁掉四邊各 ${BORDER_CROP}px 灰框）`);
console.log(`  ink bbox  ${r.ink_size[0]}×${r.ink_size[1]}  比例 ${r.aspect_w_over_h}`);
console.log(`  輸出      ${w}×${h}  alpha=${hasAlpha}  ${Math.round(statSync(OUT).size / 1024)} KB`);

const ok = w === r.out_size[0] && h === r.out_size[1] && hasAlpha === "yes";
console.log(ok ? "\n✓ 通過。" : "\n✗ 輸出與預期不符。");
console.log(`\n版面用的寬高比：width : height = ${r.aspect_w_over_h} : 1`);
console.log("（CSS 要寫死這個比例；只給 contain 不給比例，會留出一圈看不見的邊。）");
process.exit(ok ? 0 : 1);
