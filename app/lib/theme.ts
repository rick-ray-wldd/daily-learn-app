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
import type { TextStyle } from 'react-native';

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
