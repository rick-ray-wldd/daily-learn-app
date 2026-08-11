/**
 * Design tokens — Apple-Podcasts-inspired dark player（深藍黑底、綠色重聽鍵、藍色進度）。
 *
 * **這個色盤只有一條規則：顏色帶語意，不准重用。**
 *
 *   綠（`accent`）    = 「學習者動手了」——Back-15s、replay event、signal strength。
 *   琥珀（`highlight`）= 「app 在猜」——annotation 標出來的難點詞。
 *   藍（`primary`）   = 中性 chrome——進度條 / scrubber，不代表任何語意。
 *
 * 為什麼要寫死這條規則：整個產品的論點是「每一次重聽都是訊號」，綠色就是那個訊號的
 * 視覺化身。把綠色拿去標難點詞，學習者會以為那個詞是可以按的重聽鍵；把琥珀拿去畫進度
 * 條，「這是 app 推測的、不一定對」就失去了唯一的視覺標記——而 annotation 猜錯是常態，
 * 它必須永遠看起來像個猜測。要加新顏色前，先問這個顏色代表哪個語意。
 *
 * Sole source of colour / radius / spacing / type. 元件不得自行寫死色碼。
 */
import type { TextStyle, ViewStyle } from 'react-native';

/**
 * Palette. 對比度標註以 WCAG relative luminance 實算，底色標在括號裡。
 *
 * 表面是四階（bg → surface → surfaceAlt → border），文字是三階（text → dim → faint）。
 * 文字那三階刻意「不等距」：`text` 遠遠亮過另外兩階，因為逐字稿的當前句必須一眼跳出來；
 * `dim` / `faint` 都是次要資訊，彼此只要能分辨即可。
 */
export const C = {
  /** 頁面底色。深藍黑，不是純黑——純黑在 OLED 上會讓卡片邊界消失。 */
  bg: '#0C1117',
  /** 抬起的卡片（播放器卡、事件列）。 */
  surface: '#161D26',
  /** 卡片上的卡片——逐字稿的「當前句」用這層把自己從清單裡撐出來。 */
  surfaceAlt: '#1E2A38',
  /** Hairline only（borderWidth: 1），不要拿它當填色。 */
  border: '#243244',

  /** 主文字 / 當前逐字稿句。16.1:1 on bg。 */
  text: '#E8EDF4',
  /** 次要文字：metadata、標籤、已播過的句子。8.2:1 on bg。
   *  比原本的 #8A97A8 亮一階，才拉得開與 `faint` 的距離。 */
  dim: '#9FACBC',
  /**
   * 最弱的一階——**還沒播到的逐字稿句**。
   *
   * 它不是「幾乎看不見的灰」：學習者會主動往下讀還沒播到的句子來預判內容，讀不動就
   * 等於沒有逐字稿。所以下限訂在 AA：5.1:1 on `bg`、4.6:1 on `surface`。
   */
  faint: '#7A8698',

  /** 綠 = 學習者動手了（Back-15s）。 */
  accent: '#4ADE80',
  /** 壓在 `accent` 上的深墨色。9.7:1 on accent。 */
  accentInk: '#06220F',
  /** 藍 = 中性 chrome（進度 / scrubber）。不帶語意。 */
  primary: '#3B82F6',

  /**
   * 琥珀 = app 的猜測（annotation）。
   *
   * 刻意用**半透明**而不是實色：同一個難點詞可能出現在當前句（底色 `surfaceAlt`）也可能
   * 出現在非當前句（底色 `bg`/`surface`），實色底會在其中一種情境下糊掉。半透明讓它自己
   * 跟著底色走，兩種情境都維持同樣的「淡淡一層」質感。
   */
  highlight: 'rgba(245, 158, 11, 0.22)',
  /** 難點詞本身的字色。7.6:1（highlight over bg）、5.8:1（highlight over surfaceAlt）。 */
  highlightInk: '#FBBF24',

  /**
   * 綠色的**半透明表面**＝學習者親手圈出來的那幾個字。
   *
   * 語意跟 `accent` 完全同一件事（學習者動手了），只是這裡要當行內底色用。
   * 半透明的理由與 `highlight` 一字不差：同一段選取可能落在 `bg`、`surface`
   * 或當前句的 `surfaceAlt` 上，實色底會在其中一種情境糊掉。
   *
   * ⚠️ 它與 `highlight`（琥珀＝app 在猜）**永遠不會同時出現在同一個字上**——
   * 選取模式一開，琥珀標註就先讓位。證據與推測疊在同一塊底色上，等於把產品
   * 唯一的分界線抹掉。
   */
  accentSurface: 'rgba(74, 222, 128, 0.18)',
};

/** Corner radii. `pill` 給膠囊按鈕與 badge（RN 沒有 `9999px` 這種寫法）。 */
export const R = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
};

/** 4pt spacing scale：`SP(3)` → 12。所有 margin/padding/gap 走這個，不寫裸數字。 */
export const SP = (n: number): number => n * 4;

/**
 * Type scale。刻意是**純物件**、不是 `StyleSheet.create` 的產物，呼叫端才能
 * `{ ...TYPE.body, color: C.text }` 展開後再覆寫。
 */
export const TYPE: {
  title: TextStyle;
  heading: TextStyle;
  body: TextStyle;
  caption: TextStyle;
  mono: TextStyle;
} = {
  /** 螢幕標題 / logo。 */
  title: { fontSize: 28, fontWeight: '800', lineHeight: 34, letterSpacing: 0.5 },
  /** 區塊標題、單集名。 */
  heading: { fontSize: 17, fontWeight: '700', lineHeight: 22, letterSpacing: 0.2 },
  /**
   * 逐字稿本文。lineHeight 給到 1.6×——難點詞的 `highlight` 是行內底色，行距太緊
   * 上下兩行的色塊會黏在一起，看起來像整段被選取。
   */
  body: { fontSize: 16, fontWeight: '400', lineHeight: 26 },
  /** metadata、狀態列、按鈕副標。 */
  caption: { fontSize: 12, fontWeight: '600', lineHeight: 16, letterSpacing: 0.2 },
  /**
   * 時間碼專用。等寬「數字」而非等寬字體：系統字配 tabular-nums，數字換位時
   * 寬度不變（`0:09` → `0:10` 不會抖），其餘字仍與整個 app 同一套字體。
   */
  mono: {
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 16,
    letterSpacing: 0.2,
    fontVariant: ['tabular-nums'],
  },
};

/* ------------------------------------------------------------------------- *
 * 材質層（GLASS / BLOOM / RAMP / ELEV）
 *
 * 下面四組刻意**不塞進 `C`**：`C` 的契約是「每個 key 是一個語意色」，材質不是
 * 語意，混進去就稀釋了整份檔案唯一的那條鐵律。
 *
 * **兩套邊框的分工（不寫死必然漂移）：**
 * `C.border`（不透明 #243244）只用在**非玻璃**的既有元件；`GLASS.edge` 只用在
 * 玻璃面板。同一個 View 上兩者不得並存——不透明 hairline 疊在半透明填色上會在
 * 邊緣多出一圈比面板還實的線，玻璃感當場消失。
 * 已知既有違規：`NowPlaying.tsx:296` / `TranscriptScreen.tsx:740` 拿 `C.border`
 * 當軌道**填色**用。新程式碼一律改用 `GLASS.well`，舊的不在本次改版範圍。
 *
 * ⚠️ `C.faint` 禁止出現在玻璃面板或 bloom 上：它的 5.1:1 / 4.6:1 是對 `bg`
 * 與 `surface` 實算的，玻璃底下是「底色 × 半透明填色 × 可能還有色暈」的變數，
 * 會掉到 AA 以下。玻璃上的次要文字一律 `C.dim`。
 * ------------------------------------------------------------------------- */

/**
 * 玻璃材質。**這裡沒有任何語意**——它只回答「這塊面板是什麼做的」，
 * 不回答「這塊面板在講什麼」。語意仍然只由 C 的色相決定。
 *
 * 為什麼是疊層而不是 expo-blur：真・毛玻璃是原生模組，裝下去使用者就得重新
 * build，而這六天只能靠 OTA 迭代。深底上「白色低 alpha 填色 + 上緣一條高光
 * hairline」在視覺上已經非常接近，缺的只有背景模糊——而我們的背景是純色。
 *
 * `sheen` 是整個材質的關鍵：少了那條 1px 上緣高光，剩下的就只是一張灰卡片。
 */
export const GLASS = {
  /** 面板底。一般卡片用這個。 */
  fill: 'rgba(255, 255, 255, 0.055)',
  /** 需要從一堆玻璃裡再抬高一階時（浮動動作列、sheet）。 */
  fillStrong: 'rgba(255, 255, 255, 0.085)',
  /** 外框 hairline（borderWidth: 1）。與 C.border 的分工見上面的檔頭註解。 */
  edge: 'rgba(255, 255, 255, 0.08)',
  /** 上緣 1px 高光。玻璃感的來源，不准省略。 */
  sheen: 'rgba(255, 255, 255, 0.14)',
  /** 凹槽：進度條／音量條的軌道。玻璃是凸的，軌道是凹的，用暗色而不是白色。 */
  well: 'rgba(0, 0, 0, 0.28)',
  /** 蓋在內容上的遮罩（sheet 背後）。 */
  scrim: 'rgba(8, 11, 16, 0.72)',
};

/**
 * 色暈：面板**背後**一顆低透明度的語意色圓形，做出 mesh gradient 的錯覺。
 *
 * ⚠️ **bloom 只能用該面板已經憑語意賺到的色相。**「這裡放個綠暈比較好看」
 * 就是這條鐵律破功的方式：綠色一旦出現在跟「學習者動手了」無關的地方，
 * 它就不再是那個訊號的化身，而整個產品的論點就是那個訊號。
 * 沒有語意可用的面板 = 不放 bloom，不是隨便挑一個。
 */
export const BLOOM = {
  /** 綠暈：這塊面板在講「學習者動手了」（重聽、框選、確認）。 */
  accent: 'rgba(74, 222, 128, 0.16)',
  /** 藍暈：中性 chrome（正在播放、進度）。 */
  primary: 'rgba(59, 130, 246, 0.18)',
  /** 琥珀暈：這塊面板在講「app 在猜」（診斷卡、標註）。 */
  highlight: 'rgba(245, 158, 11, 0.14)',
};

/**
 * 同一個語意的三段縱深。**色相不變、只變濃度**——因為「重聽 → 確認 → 掌握」
 * 三段講的是同一件事（學習者動手了）走到多遠，換色相會讓它讀起來像三種不同
 * 的東西，那正好是這個環要否認的。
 */
export const RAMP = {
  /** 最外圈：只是重聽過。 */
  accentWeak: 'rgba(74, 222, 128, 0.26)',
  /** 中段：學習者確認「真的沒聽懂」。 */
  accentMid: 'rgba(74, 222, 128, 0.62)',
  /** 走完全程：已進 SRS 且開始拉長間隔。 */
  accentFull: C.accent,
};

/**
 * 兩階陰影。全 app 本來只有 Artwork 一份配方，六個平行畫面各自發明陰影
 * 會讓「浮起來」這件事在每個畫面的高度都不一樣。
 */
export const ELEV: { card: ViewStyle; lifted: ViewStyle } = {
  /** 一般玻璃卡片。 */
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  /** 覆蓋層／大封面／浮動動作列。 */
  lifted: {
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 10,
  },
};
