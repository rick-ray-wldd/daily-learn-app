#!/usr/bin/env node
/**
 * build-icons.mjs — 從設計稿產出 Expo 需要的全部 icon 檔。
 *
 * 為什麼存在：app/assets/ 底下原本是 Expo 範本 icon（上面印著設計參考線）。
 * 設計稿是 ChatGPT 產的四張 PNG，其中三張帶 wordmark、一張把假圓角矩形與投影
 * 烤進了點陣圖。iOS 會自己套圓角遮罩，素材再帶一層圓角就會圓角疊圓角、露出灰邊；
 * 投影烤進去在深色桌布上會變成一塊髒污。所以不能直接拿任何一張去當 icon，
 * 必須從素材裡「切出純立方體 mark」再重新排版。
 *
 * 代價與取捨都寫在對應的常數旁邊。所有幾何數字都是本腳本自己量的，
 * 不是硬編的——硬編的只有「量出來應該長這樣」的斷言，量錯就當場失敗。
 *
 * 用法：
 *   node design/build-icons.mjs            # 產生 + 驗證
 *   node design/build-icons.mjs --verify   # 只驗證現有產出，不覆寫
 *
 * 相依：macOS 內建 sips（驗證用）+ python3 + Pillow（像素處理用）。
 *       不新增任何 npm 相依（app/ 的 14 個上限不動，這支腳本也不在 app/ 底下）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
// 兩個 env override 純粹是測試接縫：用來證明底下那些斷言真的會炸，
// 而不是寫好看的。正常使用不要設。
//   ECHO_ICON_SRC=<別的素材> ECHO_ICON_OUT=/tmp/x node design/build-icons.mjs
const SRC = process.env.ECHO_ICON_SRC || join(ROOT, "img", "icon", "echo-lockup-square.png");
const OUT_DIR = process.env.ECHO_ICON_OUT || join(ROOT, "app", "assets");

/** 產生與驗證**必須共用同一條路徑規則**，否則驗證器會對 `dir` 覆寫過的 target
 *  回報「不存在」——一個看起來像失敗、其實是護欄自己找錯地方的假警報。 */
const outPath = (t) => join(t.dir || OUT_DIR, t.name);
const VERIFY_ONLY = process.argv.includes("--verify");

/* ------------------------------------------------------------------ *
 * 1. 來源與幾何
 * ------------------------------------------------------------------ */

/**
 * 來源選 echo-lockup-square.png（原 "(4)"）而不是那張已經排版成 app icon 樣子的
 * echo-mark-card-mock.png（原 "(1)"），理由三個，重要性由高到低：
 *
 *  a) (1) 把白色圓角卡片（958×959、圓角 r≈196.5px）與往下的 drop shadow 烤進了點陣圖。
 *     那個圓角是普通圓弧（superellipse n≈2.05, r/邊長=0.205），iOS 的遮罩是 squircle
 *     （r/邊長≈0.2237），兩者疊起來邊緣會露出灰色。裁得夠緊確實切得掉，但那是
 *     「依賴裁切精度」的前提；(4) 根本沒有容器，不需要這個前提。
 *  b) (4) 的立方體解析度最高（719×821，比 (1) 的 664×745 大 8–10%），縮到 1024 畫布
 *     時是降採樣不是放大。
 *  c) (4) 的 ink 最深最均勻、背景乾淨（(2) 四邊各有 1px 灰框）。
 *
 * (4) 底下有 "Echo" wordmark，中間隔了 28 列純背景 —— 本腳本靠列掃描自動切開，
 * 只取上半的立方體。四張素材的 cube 長寬比彼此差 1.8–7%（是四次獨立 render，
 * 不是同一份縮放），所以絕對不能混用；本腳本只讀這一張。
 */
const EXPECTED = {
  // 立方體 bbox（右/下為 exclusive）。量錯 = 素材被換過或被重新壓過，必須當場失敗。
  cube: { left: 268, top: 153, right: 987, bottom: 974 },
  canvas: { w: 1254, h: 1254 },
  tolerance: 2, // ±2px：threshold 在 60..200 之間結果只差 ±1px，邊緣極銳利
};

/**
 * 裁切時往外留的 padding。上/左/右 都有 150px 以上的純背景，但**下方只有 28 列**
 * 就撞到 wordmark，所以上限是 28。取 24 留 4px 餘裕。
 * 留 padding 的原因：緊貼 bbox 裁切會讓 Lanczos 縮放在邊緣 ringing。
 */
const PAD = 24;

/**
 * 光學置中權重。立方體最頂端（y=153）只有 20px 寬——那是喇叭障板的上頂點，
 * 是個尖角，視覺量體幾乎是零。照 bbox 幾何置中，看起來會偏低；
 * 照 ink 質心置中（質心比 bbox 中心低約 10px）又會過度補償，因為質心算的是面積不是視覺重量。
 * 取 0.5 折衷。改這個數字就能整體上下微調；腳本會把兩種中心都印出來讓你自己判斷。
 */
const OPTICAL_WEIGHT = 0.5;

/**
 * alpha 邊緣羽化半徑（px，作用在 source 解析度上）。
 * 素材被過度銳化，有 1px ringing（實測橫切 y=700：254→222→41→0→14→9，
 * 暗側有比本體更黑的 undershoot、亮側有比背景更亮的 overshoot）。
 * levels 正規化會把 undershoot/overshoot 夾掉，羽化再把剩下的「脆邊」磨掉一點。
 * 0 = 不羽化。>1 會讓小尺寸（favicon）糊掉。
 */
const FEATHER = 0.4;

/**
 * alpha 地板（0–255）。低於此值的 alpha 一律歸零。
 * 理由見 python worker 4g 段：素材背景有 252–254 的擴散雜訊。
 */
const ALPHA_FLOOR = 6;

const INK_HEX = "000000"; // 正規化後的 mark 顏色。素材原本是 #090909（中性灰黑，無可見色偏）
const BG_HEX = "FFFFFF"; // 不透明輸出的底色

// iOS 18+ 變體的色票。深色版刻意沿用 app/lib/theme.ts 的中性色而不是純黑白：
// 純黑底在深色桌布上會變成一個看不見邊界的洞，帶一點藍綠偏移的 #14191B 才有形狀。
const DARK_BG_HEX = "14191B";  // theme.ts 的 ink
const DARK_INK_HEX = "F3F6F4"; // theme.ts 的 paper
// 著色版必須嚴格中性（R=G=B）：系統會用使用者選的色相重上色，任何色偏都會打架。
const TINT_BG_HEX = "0B0B0B";
const TINT_INK_HEX = "E8E8E8";
// 版面用的 mark：用 theme.ts 的 ink 而不是純黑，才跟海報／簡報的文字同一個黑。
const PRINT_INK_HEX = "14191B";

/* ------------------------------------------------------------------ *
 * 2. 產出清單
 * ------------------------------------------------------------------ */

/**
 * markFrac = 立方體 bbox 的**高**佔畫布的比例（高 821 > 寬 719，所以高是長邊，
 * 用長邊定尺寸才保證整個 bbox 進得了目標框）。
 * 對應的寬度比例 = markFrac × 0.876。
 */
const TARGETS = [
  {
    name: "icon.png",
    size: 1024,
    markFrac: 0.78,
    alpha: false,
    bg: BG_HEX,
    // iOS 硬規則：1024×1024、**不能有 alpha**、**不能自己畫圓角**（系統套遮罩）、
    // 不能把投影烤進去。0.78 落在合理的 76–82% 區間：高 799px、寬 700px，
    // 四邊至少留 112px 呼吸空間，且等角立方體的 bbox 四角本來就是空的，
    // 不會被 squircle 遮罩切到。
    note: "iOS / 通用 app icon：滿版、不透明、無圓角、無投影",
  },
  {
    name: "android-icon-foreground.png",
    size: 1024,
    markFrac: 0.62,
    alpha: true,
    bg: null,
    // Android 自適應圖示會裁切外圍，只保證中央 66%（676px）可見。
    // 0.62 → 高 635px、寬 556px，bbox 完整落在 676px 安全區內。
    // 注意安全區嚴格說是**直徑** 66% 的圓；bbox 對角線 (635,556) 超過 676，
    // 但立方體的 bbox 四角無 ink，實際圖形不會被圓形遮罩切到。
    note: "Android adaptive icon 前景層：透明底，mark 收在中央 66% 安全區",
  },
  {
    name: "android-icon-background.png",
    size: 1024,
    markFrac: null, // 純色，不放 mark
    alpha: false,
    bg: BG_HEX,
    note: "Android adaptive icon 背景層：純色",
  },
  {
    name: "android-icon-monochrome.png",
    size: 1024,
    markFrac: 0.62,
    alpha: true,
    bg: null,
    // Android 13+ themed icon：系統只看 alpha 通道，用主題色重畫。
    // 幾何必須跟前景層一致，否則切換主題圖示時 mark 會跳動。
    // 因此本檔與 foreground 逐位元組相同——這是刻意的，不是漏寫。
    note: "Android 13+ themed icon：單色剪影（系統依 alpha 上色）",
  },
  {
    name: "icon-dark.png",
    size: 1024,
    markFrac: 0.78,
    alpha: false,
    bg: DARK_BG_HEX,
    ink: DARK_INK_HEX,
    // iOS 18+ 的深色變體。**不是把亮版反相**：反相會得到純白底變純黑底，
    // 在深色桌布上是一塊死黑。這裡改用產品自己的色票——底是 theme.ts 的
    // ink（#14191B，帶一點藍綠偏移的近黑），mark 是 paper（#F3F6F4）。
    // 與海報、簡報同一組中性色，所以它看起來是「選過的」而不是「預設的」。
    note: "iOS 18+ dark variant：深底淺 mark，用產品自己的中性色",
  },
  {
    name: "icon-tinted.png",
    size: 1024,
    markFrac: 0.78,
    alpha: false,
    bg: TINT_BG_HEX,
    ink: TINT_INK_HEX,
    // iOS 18+ 的著色變體。系統會**用使用者選的色相重新上色**，只看亮度，
    // 所以這張必須是嚴格中性灰——放任何色偏進去都會與使用者選的色打架。
    // 深底淺 mark：著色模式下亮的部分才會吃到顏色，mark 是主體所以它要亮。
    note: "iOS 18+ tinted variant：嚴格灰階，深底淺 mark（系統只讀亮度）",
  },
  {
    name: "echo-mark-print.png",
    dir: HERE,
    size: 512,
    markFrac: 0.96,
    alpha: true,
    bg: null,
    ink: PRINT_INK_HEX,
    // 海報與簡報用。**必須透明底**：那兩份的紙色是 #F3F6F4，把不透明的 icon.png
    // 放上去會出現一個白方塊。緊裁到 0.96 是因為版面自己會給留白，資產再留一圈
    // 會讓它在視覺上比指定的尺寸小一號。512px 夠用：簡報首頁 30mm @300dpi = 354px。
    note: "版面用 mark：透明底、緊裁、theme ink 色",
  },
  {
    name: "favicon.png",
    size: 48,
    markFrac: 0.78,
    alpha: false,
    bg: BG_HEX,
    // 直接從 source 解析度一次降到 48px（Lanczos），不要先做 1024 再降——
    // 兩段降採樣會多吃一次插值誤差。
    note: "Web favicon",
  },
  {
    name: "splash-icon.png",
    size: 1024,
    markFrac: 0.46,
    alpha: true,
    bg: null,
    // splash 的 mark 要小、留白要多，因為它顯示在整個螢幕中央而不是一個小方格裡。
    // 透明底 → 由 app.json 的 splash backgroundColor 決定底色。
    // ⚠️ 目前 app/app.json 的 plugins 陣列裡沒有 expo-splash-screen，
    //    也沒有 splash 設定區塊 —— 這個檔案現在其實沒有被任何設定引用。
    note: "Splash 用 mark：較小、留白較多、透明底",
  },
];

/* ------------------------------------------------------------------ *
 * 3. 前置檢查
 * ------------------------------------------------------------------ */

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

function which(bin) {
  try {
    return execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function preflight() {
  log("── 前置檢查 ──────────────────────────────────────────────");

  if (!existsSync(SRC)) fail(`找不到來源設計稿：${SRC}`);
  log(`  來源      ${SRC}`);

  const sips = which("sips");
  if (!sips) fail("找不到 sips（macOS 內建）。驗證步驟需要它。");
  log(`  sips      ${sips}`);

  const py = which("python3");
  if (!py) fail("找不到 python3。");
  log(`  python3   ${py}`);

  // Pillow 檢查。沒有 Pillow 就不做：本腳本需要 luminance keying（把白背景轉成
  // alpha、但**保留**被 ink 包圍的白色 counter）、levels 正規化、Lanczos 重採樣。
  // sips 三樣都做不到（它只能 crop / resize / pad）。與其塞一段沒被跑過的
  // sips 退路假裝有涵蓋，不如在這裡大聲失敗。
  let pil;
  try {
    pil = execFileSync(py, ["-c", "import PIL; print(PIL.__version__)"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    fail(
      "python3 有，但 Pillow (PIL) 沒裝。\n" +
        "  本腳本的像素處理（luminance keying + levels 正規化 + Lanczos）需要 Pillow。\n" +
        "  sips 只能 crop/resize/pad，做不到 keying，沒有可用的降級路徑。\n" +
        "  安裝：python3 -m pip install --user Pillow",
    );
  }
  log(`  Pillow    ${pil}`);
  log("");
}

/* ------------------------------------------------------------------ *
 * 4. 像素處理（委派給 python3 + Pillow）
 * ------------------------------------------------------------------ */

const PY_WORKER = String.raw`
import json, sys
from PIL import Image, ImageFilter

cfg = json.loads(sys.stdin.read())

INK_T   = 128   # ink 判定門檻（luminance）。素材邊緣極銳利，60..200 之間結果只差 +-1px
BG_T    = 200   # 「這像素算背景」的下限，用來驗證 padding 圈是乾淨的
GAP_MIN = 8     # 判定為「圖形之間的空白帶」所需的最少連續空列數

src = Image.open(cfg["src"])
if src.mode != "L":
    # mark 是中性灰黑（G 比 R 高 0.15、比 B 高 0.2，8-bit 下無可見色偏），
    # 轉 L 不損失資訊。convert("L") 用 ITU-R 601-2：0.299R + 0.587G + 0.114B
    src = src.convert("L")
W, H = src.size
px = src.load()

report = {"src_size": [W, H]}

# ---- 4a. 列掃描：把立方體從底下的 wordmark 切開 -------------------------
# 不能用「取最大連通元件」——4x 降採樣後這個 mark 有 11 塊 >=50px 的連通元件
# （喇叭的同心圓環被白環切開、E/C/H 三個面各自獨立）。改用整列有無 ink 來分帶。
row_has_ink = [False] * H
for y in range(H):
    for x in range(W):
        if px[x, y] < INK_T:
            row_has_ink[y] = True
            break

bands = []
y = 0
while y < H:
    if row_has_ink[y]:
        s = y
        while y < H and row_has_ink[y]:
            y += 1
        bands.append((s, y))
    else:
        y += 1

# 合併掉小於 GAP_MIN 的空隙（同一個圖形內部的水平空白，例如喇叭盆與障板之間）
merged = []
for b in bands:
    if merged and b[0] - merged[-1][1] < GAP_MIN:
        merged[-1] = (merged[-1][0], b[1])
    else:
        merged.append(list(b) if False else (b[0], b[1]))
merged = [list(b) for b in merged]

if len(merged) < 1:
    print(json.dumps({"error": "來源圖裡找不到任何 ink"})); sys.exit(1)
report["bands"] = merged
cube_band = merged[0]          # 最上面那一帶 = 立方體
report["wordmark_bands"] = merged[1:]

# ---- 4b. 立方體 bbox 與 ink 質心 ---------------------------------------
left, right, top, bottom = W, -1, cube_band[0], cube_band[1] - 1
wsum = 0.0; wx = 0.0; wy = 0.0
for y in range(cube_band[0], cube_band[1]):
    for x in range(W):
        v = px[x, y]
        if v < INK_T:
            if x < left:  left = x
            if x > right: right = x
            # 質心用 ink 覆蓋率加權（255-v），比二值化更貼近視覺重量
            w = 255.0 - v
            wsum += w; wx += w * x; wy += w * y
if right < 0:
    print(json.dumps({"error": "立方體帶裡沒有 ink"})); sys.exit(1)

bbox = [left, top, right + 1, bottom + 1]   # 右/下 exclusive
bw = bbox[2] - bbox[0]; bh = bbox[3] - bbox[1]
cx_ink = wx / wsum; cy_ink = wy / wsum
cx_box = bbox[0] + bw / 2.0; cy_box = bbox[1] + bh / 2.0
report["cube_bbox"] = bbox
report["cube_size"] = [bw, bh]
report["cube_aspect"] = round(bw / bh, 4)
report["bbox_center"] = [round(cx_box, 2), round(cy_box, 2)]
report["ink_centroid"] = [round(cx_ink, 2), round(cy_ink, 2)]
report["optical_delta"] = [round(cx_ink - cx_box, 2), round(cy_ink - cy_box, 2)]

# ---- 4c. 斷言：量到的幾何要跟預期一致 -----------------------------------
exp = cfg["expected"]["cube"]; tol = cfg["expected"]["tolerance"]
for k, got, want in (("left", bbox[0], exp["left"]), ("top", bbox[1], exp["top"]),
                     ("right", bbox[2], exp["right"]), ("bottom", bbox[3], exp["bottom"])):
    if abs(got - want) > tol:
        print(json.dumps({"error": "立方體 bbox." + k + " 量到 " + str(got) +
                          "，預期 " + str(want) + " (+-" + str(tol) + ")。素材被換過了？",
                          "report": report})); sys.exit(1)

# ---- 4d. 軟邊界（含抗鋸齒尾巴）-----------------------------------------
# ink bbox 用 lum<128 量，那是「實心」的範圍；但邊緣抗鋸齒會拖出 1–2px 的灰尾巴
# （實測立方體底部 y=974 有 lum=171，剛好落在 ink bbox 之外）。
# 這條尾巴是圖形的一部分，不是雜訊 —— 所以 padding 乾淨度要對「軟邊界」檢查，
# 不是對 ink bbox 檢查，否則會誤判成「裁到 wordmark」。
# ink bbox 仍然是定尺寸與斷言的依據（差 1–2px，對 821px 的高度無感）。
SOFT_MARGIN = 8
sl, st = max(0, bbox[0] - SOFT_MARGIN), max(0, bbox[1] - SOFT_MARGIN)
sr, sb_ = min(W, bbox[2] + SOFT_MARGIN), min(H, bbox[3] + SOFT_MARGIN)
soft = [sr, sb_, sl, st]   # l,t,r,b，先放成反向的極端值再往外撐
for y in range(st, sb_):
    for x in range(sl, sr):
        if px[x, y] < BG_T:
            if x < soft[0]: soft[0] = x
            if y < soft[1]: soft[1] = y
            if x + 1 > soft[2]: soft[2] = x + 1
            if y + 1 > soft[3]: soft[3] = y + 1
report["soft_bbox"] = soft
report["soft_margin_used"] = [bbox[0] - soft[0], bbox[1] - soft[1],
                              soft[2] - bbox[2], soft[3] - bbox[3]]
if min(report["soft_margin_used"]) < 0 or max(report["soft_margin_used"]) >= SOFT_MARGIN:
    print(json.dumps({"error": "抗鋸齒尾巴超過 " + str(SOFT_MARGIN) + "px：" +
                      str(report["soft_margin_used"]) + "。素材的邊緣特性跟預期不同。",
                      "report": report})); sys.exit(1)

# ---- 4e. 帶 padding 裁切，並驗證 padding 圈是純背景 ----------------------
# padding 存在的理由：緊貼邊界裁切會讓 Lanczos 在邊緣 ringing。
# 下方只有 28 列純背景就撞到 wordmark，所以 pad 的上限由那裡決定。
pad = cfg["pad"]
cl, ct = bbox[0] - pad, bbox[1] - pad
cr, cb = bbox[2] + pad, bbox[3] + pad
if cl < 0 or ct < 0 or cr > W or cb > H:
    print(json.dumps({"error": "padding " + str(pad) + "px 超出畫布", "report": report})); sys.exit(1)

worst = 255; worst_at = None
for y in range(ct, cb):
    in_v = soft[1] <= y < soft[3]
    for x in range(cl, cr):
        if in_v and soft[0] <= x < soft[2]:
            continue                      # 軟邊界內部跳過
        v = px[x, y]
        if v < worst:
            worst, worst_at = v, [x, y]
report["pad_ring_min_lum"] = worst
report["pad_ring_min_at"] = worst_at
if worst < BG_T:
    print(json.dumps({"error": "padding 圈不是純背景（最暗 lum=" + str(worst) +
                      " @ " + str(worst_at) + "）。裁太寬，把 wordmark 或別的東西吃進來了。",
                      "report": report})); sys.exit(1)

crop = src.crop((cl, ct, cr, cb))
CW, CH = crop.size

# ---- 4f. levels 正規化：ink -> 0、背景 -> 255 ---------------------------
# 為什麼要做：素材的 ink 是 #090909、背景是 #FEFEFE，兩端都不是純值。
# 不正規化的話 icon.png 的底會是 254 而不是純白，而且 alpha 永遠到不了 0/255。
# 順帶把過度銳化造成的 undershoot(<9) / overshoot(>254) 夾掉。
hist = crop.histogram()
ink_lvl = max(range(0, 41), key=lambda v: hist[v])       # 暗端眾數，預期 9
bg_lvl  = max(range(200, 256), key=lambda v: hist[v])    # 亮端眾數，預期 254
report["levels"] = {"ink": ink_lvl, "bg": bg_lvl}
if bg_lvl - ink_lvl < 128:
    print(json.dumps({"error": "對比不足：ink=" + str(ink_lvl) + " bg=" + str(bg_lvl),
                      "report": report})); sys.exit(1)
span = float(bg_lvl - ink_lvl)
lut = [max(0, min(255, int(round((v - ink_lvl) * 255.0 / span)))) for v in range(256)]
norm = crop.point(lut)

# ---- 4g. 主素材：ink 上色 + alpha keying -------------------------------
# 關鍵：alpha = 255 - luminance，**不是**「白色 -> 透明」的全域門檻。
# 這個 mark 的白色 counter（喇叭同心圓環之間、E/C/H 的字腔）共 115,834px，
# 值同樣是 254，被 ink 四面包圍。用 alpha = 255 - lum 時它們也會變透明——
# 那是對的：這是線稿，counter 透明才會讓底層顏色透出來，疊在白底上結果與原稿等價。
alpha = norm.point(lambda v: 255 - v)

# alpha 地板：素材背景不是死平的（252–254 的擴散雜訊），正規化後會變成整片 alpha 1–2。
# 那等於在透明區留下一個「裁切矩形的鬼影」——肉眼看不到，但它讓本該乾淨的剪影
# 帶著一塊矩形雜訊，也讓 PNG 白白變大。alpha < FLOOR 一律歸零。
# FLOOR=6 對應 lum>249，那是純背景；mark 的中間調只佔 3.49%，不會被吃到。
floor = cfg["alphaFloor"]
if floor > 0:
    alpha = alpha.point(lambda v: 0 if v < floor else v)

if cfg["feather"] > 0:
    alpha = alpha.filter(ImageFilter.GaussianBlur(cfg["feather"]))
    # 羽化會把邊緣往外糊出 alpha 1–2 的一圈，再掃一次地板保持透明區真的是 0
    if floor > 0:
        alpha = alpha.point(lambda v: 0 if v < floor else v)
ink = tuple(int(cfg["ink"][i:i+2], 16) for i in (0, 2, 4))
master = Image.new("RGBA", (CW, CH), ink + (0,))
master.putalpha(alpha)

# bbox 在 crop 座標系裡的位置
b_in = (pad, pad, pad + bw, pad + bh)

# ---- 4h. 逐一產出 -------------------------------------------------------
outs = []
for t in cfg["targets"]:
    S = t["size"]
    bg = None
    if t["bg"]:
        bg = tuple(int(t["bg"][i:i+2], 16) for i in (0, 2, 4))

    # 逐 target 覆寫 ink（iOS 18 的 dark / tinted 變體要反過來：淺 mark 深底）
    t_ink = ink
    if t.get("ink"):
        t_ink = tuple(int(t["ink"][i:i+2], 16) for i in (0, 2, 4))

    if t["markFrac"] is None:
        canvas = Image.new("RGB", (S, S), bg)
        canvas.save(t["path"], optimize=True)
        outs.append({"name": t["name"], "size": [S, S], "mode": "RGB",
                     "mark_frac": None, "mark_box": None})
        continue

    # 用長邊（高）定尺寸，保證整個 bbox 進得了目標框
    target_h = S * t["markFrac"]
    s = target_h / float(bh)
    nw, nh = max(1, int(round(CW * s))), max(1, int(round(CH * s)))
    scaled = master.resize((nw, nh), Image.LANCZOS)

    # bbox 在縮放後 crop 裡的位置與中心
    sb = (b_in[0] * s, b_in[1] * s, b_in[2] * s, b_in[3] * s)
    sb_cx = (sb[0] + sb[2]) / 2.0
    sb_cy = (sb[1] + sb[3]) / 2.0

    # 光學置中：把 bbox 中心放在畫布中心，再往 ink 質心的**反**方向修正
    # OPTICAL_WEIGHT 倍。質心在下 => 整個 mark 往上移。
    ow = cfg["opticalWeight"]
    tgt_cx = S / 2.0 - ow * (cx_ink - cx_box) * s
    tgt_cy = S / 2.0 - ow * (cy_ink - cy_box) * s
    ox = int(round(tgt_cx - sb_cx))
    oy = int(round(tgt_cy - sb_cy))

    if t["alpha"]:
        canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        canvas.alpha_composite(scaled, (ox, oy))
        canvas.save(t["path"], optimize=True)
        mode = "RGBA"
    else:
        canvas = Image.new("RGB", (S, S), bg)
        canvas.paste(Image.new("RGB", scaled.size, t_ink), (ox, oy), scaled)
        canvas.save(t["path"], optimize=True)
        mode = "RGB"

    mb = [ox + sb[0], oy + sb[1], ox + sb[2], oy + sb[3]]
    outs.append({
        "name": t["name"], "size": [S, S], "mode": mode,
        "mark_box": [round(v, 1) for v in mb],
        "mark_frac": [round((mb[2] - mb[0]) / S, 4), round((mb[3] - mb[1]) / S, 4)],
        "scale": round(s, 4),
    })

report["outputs"] = outs
print(json.dumps(report))
`;

function generate() {
  mkdirSync(OUT_DIR, { recursive: true });

  const cfg = {
    src: SRC,
    pad: PAD,
    feather: FEATHER,
    alphaFloor: ALPHA_FLOOR,
    ink: INK_HEX,
    opticalWeight: OPTICAL_WEIGHT,
    expected: EXPECTED,
    // dir 可逐 target 覆寫：品牌資產（海報／簡報用）不該混進 app/assets。
    targets: TARGETS.map((t) => ({ ...t, path: outPath(t) })),
  };

  const workerPath = join(tmpdir(), "echo-build-icons-worker.py");
  writeFileSync(workerPath, PY_WORKER);

  let out;
  try {
    out = execFileSync("python3", [workerPath], {
      input: JSON.stringify(cfg),
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
  } catch (e) {
    const stdout = (e.stdout || "").trim();
    if (stdout.startsWith("{")) {
      const r = JSON.parse(stdout);
      fail(`像素處理失敗：${r.error}`);
    }
    fail(`python worker 掛了：\n${e.stderr || e.message}`);
  }

  const r = JSON.parse(out.trim());
  if (r.error) fail(`像素處理失敗：${r.error}`);
  return r;
}

/* ------------------------------------------------------------------ *
 * 5. 驗證（用 sips 讀回真實檔案，不信任 python 自己的說法）
 * ------------------------------------------------------------------ */

function sipsProps(path) {
  const raw = execFileSync(
    "sips",
    ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", "-g", "format", path],
    { encoding: "utf8" },
  );
  const g = (k) => {
    const m = raw.match(new RegExp(`\\s${k}:\\s*(\\S+)`));
    return m ? m[1] : null;
  };
  return {
    w: Number(g("pixelWidth")),
    h: Number(g("pixelHeight")),
    hasAlpha: g("hasAlpha"),
    format: g("format"),
  };
}

/**
 * icon.png 專屬檢查：iOS 的 app icon 一定是滿版矩形，系統自己套圓角遮罩。
 * 如果四個角落不是背景色，代表素材裡有烤進去的圓角（角落被削掉 → 露出別的顏色）
 * 或投影。這一項在這裡失敗，比在 App Store Connect 被退件便宜太多。
 */
function checkOpaqueEdges(path, expectHex) {
  const py = `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
w, h = im.size
pts = {"TL": (2, 2), "TR": (w - 3, 2), "BL": (2, h - 3), "BR": (w - 3, h - 3),
       "T": (w // 2, 2), "B": (w // 2, h - 3), "L": (2, h // 2), "R": (w - 3, h // 2)}
print(";".join(k + "=" + "%02X%02X%02X" % im.getpixel(v) for k, v in pts.items()))
`;
  const outRaw = execFileSync("python3", ["-c", py, path], { encoding: "utf8" }).trim();
  const bad = outRaw
    .split(";")
    .map((s) => s.split("="))
    .filter(([, hex]) => hex.toUpperCase() !== expectHex.toUpperCase());
  return { samples: outRaw, bad };
}

/**
 * 透明輸出專屬檢查：alpha>0 的範圍必須貼合 mark 本身。
 *
 * 素材背景不是死平的（252–254 的擴散雜訊），正規化後整片會變成 alpha 1–2，
 * 在透明區留下一個「裁切矩形」形狀的鬼影 —— 那在 Android themed icon 被主題色
 * 重畫時會是一塊矩形髒污。ALPHA_FLOOR 負責清掉它，這裡負責證明清掉了。
 *
 * 判準只看**範圍**不看微弱像素的數量：降採樣後的真實邊緣本來就會產生一堆
 * alpha 1–5 的像素，那是正確的抗鋸齒，不是雜訊。鬼影的特徵是「範圍遠大於 mark」。
 */
function alphaExtent(path) {
  const py = `
import sys
from PIL import Image
im = Image.open(sys.argv[1])
a = im.getchannel("A")
print(str(a.getbbox()) + "|" + str(sum(a.histogram()[1:6])))
`;
  const raw = execFileSync("python3", ["-c", py, path], { encoding: "utf8" }).trim();
  const [bboxStr, faint] = raw.split("|");
  const nums = bboxStr.replace(/[()]/g, "").split(",").map((s) => Number(s.trim()));
  return { bbox: nums, faintCount: Number(faint) };
}

function verify(reportOutputs) {
  log("── 驗證（sips -g，讀的是真實檔案）─────────────────────────");
  log(
    "  " +
      "檔名".padEnd(30) +
      "尺寸".padEnd(14) +
      "hasAlpha".padEnd(10) +
      "mark 佔比 (w×h)".padEnd(20) +
      "sha256[:8]",
  );

  let ok = true;
  for (const t of TARGETS) {
    const p = outPath(t);
    if (!existsSync(p)) {
      log(`  ${t.name.padEnd(30)}✗ 不存在`);
      ok = false;
      continue;
    }
    const s = sipsProps(p);
    const want = { w: t.size, h: t.size, hasAlpha: t.alpha ? "yes" : "no" };
    const sizeOk = s.w === want.w && s.h === want.h;
    const alphaOk = s.hasAlpha === want.hasAlpha;
    const fmtOk = s.format === "png";

    const ro = (reportOutputs || []).find((o) => o.name === t.name);
    const frac = ro && ro.mark_frac ? `${(ro.mark_frac[0] * 100).toFixed(1)}% × ${(ro.mark_frac[1] * 100).toFixed(1)}%` : "—";
    const sha = createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 8);

    const flag = sizeOk && alphaOk && fmtOk ? "✓" : "✗";
    log(
      `  ${flag} ${t.name.padEnd(28)}${`${s.w}×${s.h}`.padEnd(14)}${String(s.hasAlpha).padEnd(10)}${frac.padEnd(20)}${sha}`,
    );
    if (!sizeOk) { log(`      ✗ 尺寸應為 ${want.w}×${want.h}`); ok = false; }
    if (!alphaOk) {
      log(`      ✗ hasAlpha 應為 ${want.hasAlpha}，實際 ${s.hasAlpha}`);
      if (t.name === "icon.png") log("        （iOS app icon 帶 alpha 會被 App Store 退件）");
      ok = false;
    }
    if (!fmtOk) { log(`      ✗ format 應為 png，實際 ${s.format}`); ok = false; }

    // markFrac 區間檢查
    if (ro && ro.mark_frac) {
      const [fw, fh] = ro.mark_frac;
      if (t.name === "icon.png" && (fh < 0.76 || fh > 0.82)) {
        log(`      ✗ icon mark 高度佔比 ${(fh * 100).toFixed(1)}% 不在 76–82%`); ok = false;
      }
      if (t.name.startsWith("android-icon-f") || t.name.startsWith("android-icon-m")) {
        if (fw > 0.66 || fh > 0.66) {
          log(`      ✗ 超出 Android 66% 安全區（${(fw * 100).toFixed(1)}% × ${(fh * 100).toFixed(1)}%）`); ok = false;
        }
      }
    }
  }

  // 透明輸出：alpha 範圍必須貼合 mark，不能有裁切矩形的鬼影
  const GHOST_TOL = 6; // px，容許羽化外溢
  for (const t of TARGETS.filter((x) => x.alpha)) {
    const p = outPath(t);
    if (!existsSync(p)) continue;
    const ro = (reportOutputs || []).find((o) => o.name === t.name);
    if (!ro || !ro.mark_box) continue;
    const { bbox, faintCount } = alphaExtent(p);
    const slack = [
      ro.mark_box[0] - bbox[0],
      ro.mark_box[1] - bbox[1],
      bbox[2] - ro.mark_box[2],
      bbox[3] - ro.mark_box[3],
    ].map((v) => Math.round(v));
    const worst = Math.max(...slack);
    if (worst > GHOST_TOL) {
      log(`  ✗ ${t.name}：alpha 範圍比 mark 外溢 ${JSON.stringify(slack)} px（上限 ${GHOST_TOL}）`);
      log("    → 裁切矩形的背景雜訊變成鬼影，調高 ALPHA_FLOOR");
      ok = false;
    } else {
      log(`  ✓ ${t.name}：alpha 貼合 mark，外溢 ${worst}px ≤ ${GHOST_TOL}（邊緣抗鋸齒 ${faintCount} px，正常）`);
    }
  }

  // icon.png 的邊緣檢查
  const iconPath = join(OUT_DIR, "icon.png");
  if (existsSync(iconPath)) {
    const e = checkOpaqueEdges(iconPath, BG_HEX);
    if (e.bad.length) {
      log(`\n  ✗ icon.png 邊緣不是純 #${BG_HEX}：${e.samples}`);
      log("    → 素材裡有烤進去的圓角或投影，或裁切範圍不對");
      ok = false;
    } else {
      log(`\n  ✓ icon.png 四角 + 四邊中點皆為 #${BG_HEX}（無烤進去的圓角／投影）`);
    }
  }

  // foreground / monochrome 幾何一致性
  const fg = join(OUT_DIR, "android-icon-foreground.png");
  const mono = join(OUT_DIR, "android-icon-monochrome.png");
  if (existsSync(fg) && existsSync(mono)) {
    const a = createHash("sha256").update(readFileSync(fg)).digest("hex");
    const b = createHash("sha256").update(readFileSync(mono)).digest("hex");
    log(
      a === b
        ? "  ✓ foreground / monochrome 逐位元組相同（刻意：兩層幾何必須一致，否則切換主題圖示時 mark 會跳動）"
        : "  ! foreground / monochrome 內容不同 —— 確認這是刻意的",
    );
  }

  log("");
  return ok;
}

/* ------------------------------------------------------------------ *
 * 6. main
 * ------------------------------------------------------------------ */

preflight();

let report = null;
if (VERIFY_ONLY) {
  log("── --verify：只驗證，不重新產生 ──────────────────────────\n");
} else {
  log("── 量測來源（不是硬編，是掃出來的）────────────────────────");
  report = generate();
  const b = report.cube_bbox;
  log(`  畫布            ${report.src_size[0]}×${report.src_size[1]}`);
  log(`  ink 水平帶      ${JSON.stringify(report.bands)}  ← 第一帶=立方體，其餘=wordmark`);
  log(`  立方體 bbox     ${b[0]},${b[1]} – ${b[2]},${b[3]}  (${report.cube_size[0]}×${report.cube_size[1]}, aspect ${report.cube_aspect})`);
  log(`  bbox 中心       ${report.bbox_center[0]}, ${report.bbox_center[1]}`);
  log(`  ink 質心        ${report.ink_centroid[0]}, ${report.ink_centroid[1]}   Δ=${report.optical_delta[0]}, ${report.optical_delta[1]}`);
  log(`  光學置中權重    ${OPTICAL_WEIGHT}（0=照 bbox，1=照質心）`);
  log(`  抗鋸齒尾巴      左${report.soft_margin_used[0]} 上${report.soft_margin_used[1]} 右${report.soft_margin_used[2]} 下${report.soft_margin_used[3]} px（ink bbox 之外的灰邊，屬於圖形）`);
  log(`  padding 圈最暗  lum=${report.pad_ring_min_lum} @ ${JSON.stringify(report.pad_ring_min_at)}（>=200 才算乾淨）`);
  log(`  levels          ink ${report.levels.ink} → 0 ；bg ${report.levels.bg} → 255`);
  log(`  羽化            ${FEATHER}px ；alpha 地板 ${ALPHA_FLOOR}\n`);

  log("── 產出 ──────────────────────────────────────────────────");
  for (const o of report.outputs) {
    const t = TARGETS.find((x) => x.name === o.name);
    log(`  ${o.name.padEnd(30)}${o.mode.padEnd(6)}${(o.mark_frac ? `mark 高 ${(o.mark_frac[1] * 100).toFixed(1)}%` : "純色").padEnd(18)}${t.note}`);
  }
  log("");
}

const ok = verify(report && report.outputs);
if (!ok) fail("驗證未通過 —— 上面標 ✗ 的項目要修到對，不要就這樣進 build。");

log("✓ 全部通過。");
log("");
log("尚未處理（需要人做決定，不在本腳本範圍）：");
// （原本這裡提示 adaptiveIcon.backgroundColor 還是 #E6F4FE。已於 e0290d8 改成
//   #FFFFFF，提示留著就變成假訊息，所以拿掉。）
log(`    但 backgroundImage 是純 #${BG_HEX}。有 backgroundImage 時它會蓋掉 backgroundColor，`);
log("    不影響成品，但兩個值不一致，建議把 backgroundColor 也改成 #FFFFFF。");
log("  · app.json 沒有 expo-splash-screen plugin，也沒有 splash 設定區塊 —— splash-icon.png");
log("    目前不被任何設定引用。要用得先補設定。");
