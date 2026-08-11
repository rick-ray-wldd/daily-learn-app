/**
 * 純 JS 漸層：N 條絕對定位的橫（或直）條，各自填一個內插出來的實色。
 *
 * 為什麼不用 expo-linear-gradient：它是原生模組，裝下去使用者就必須重新 build，
 * 而這六天的迭代全部只能靠 OTA。深底（#0C1117）上條帶之間的亮度差極小，12~16
 * 條就已經看不出色帶——這個近似只在淺色大面積漸層上會露餡，而我們沒有那種面。
 *
 * 只支援 vertical / horizontal 兩個方向。**放射狀不做在這裡**：真正的 radial
 * 要靠同心圓疊層，數量級是 N² 個 View，而「面板背後一團色暈」的需求已經由
 * `Glass` 的 bloom（一顆低透明度的大圓）解掉了，兩份實作只會互相走鐘。
 */
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

export interface GradientProps {
  /** 起點色。接受 '#RGB' / '#RRGGBB' / 'rgb(r,g,b)' / 'rgba(r,g,b,a)'。 */
  from: string;
  /** 終點色，格式同上。 */
  to: string;
  /** 橫條數。深底上 12~16 就看不出色帶；預設 14。上限 24（再多只是白付出 View）。 */
  bands?: number;
  /** 'vertical' = 由上到下（預設）；'horizontal' = 由左到右。 */
  direction?: 'vertical' | 'horizontal';
  /** 通常要 position:'absolute' + 四邊 0 才有意義，由呼叫端決定。 */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const DEFAULT_BANDS = 14;
/** 再多也只是白付出 View：深底上的相鄰條帶亮度差早就低於一個 8-bit 階。 */
const MAX_BANDS = 24;
/** 兩條之間刻意重疊 0.5%：百分比高度在螢幕上會被取整，不重疊就會留下髮絲縫。 */
const OVERLAP_PCT = 0.5;

type Rgba = [number, number, number, number];

/** 看不懂的字串一律當全透明，**不 throw**——一個色碼打錯不該讓整個畫面白掉。 */
const TRANSPARENT: Rgba = [0, 0, 0, 0];

function parseColor(c: string): Rgba {
  const s = c.trim().toLowerCase();

  if (s.charAt(0) === '#') {
    const hex = s.slice(1);
    // #RGB / #RGBA：每個字元代表一個 byte 的兩位（'a' → 'aa'）。
    if (hex.length === 3 || hex.length === 4) {
      const v = hex.split('').map((ch) => parseInt(ch + ch, 16));
      if (v.some((n) => Number.isNaN(n))) return TRANSPARENT;
      return [v[0], v[1], v[2], v.length === 4 ? v[3] / 255 : 1];
    }
    if (hex.length === 6 || hex.length === 8) {
      const v: number[] = [];
      for (let i = 0; i < hex.length; i += 2) v.push(parseInt(hex.slice(i, i + 2), 16));
      if (v.some((n) => Number.isNaN(n))) return TRANSPARENT;
      return [v[0], v[1], v[2], v.length === 4 ? v[3] / 255 : 1];
    }
    return TRANSPARENT;
  }

  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return TRANSPARENT;
  const parts = m[1].split(',').map((p) => Number(p.trim()));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return TRANSPARENT;
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

/** alpha 也要一起內插：漸層最常見的用法是「有色 → 完全透明」，只插 RGB 會變成一片灰。 */
function mix(a: Rgba, b: Rgba, t: number): string {
  const ch = (i: 0 | 1 | 2): number => Math.round(a[i] + (b[i] - a[i]) * t);
  const alpha = Math.round((a[3] + (b[3] - a[3]) * t) * 1000) / 1000;
  return `rgba(${ch(0)}, ${ch(1)}, ${ch(2)}, ${alpha})`;
}

function GradientBase({
  from,
  to,
  bands,
  direction = 'vertical',
  style,
  testID,
}: GradientProps): React.ReactElement {
  // 條帶陣列算一次就好，而且元件本身要 React.memo：Practice 頁同時訂閱 store 與
  // 250ms 的播放狀態，每秒重繪 4 次；沒有這兩層，每一次都會重建整批 View 的樣式。
  const bandStyles = useMemo<ViewStyle[]>(() => {
    const n = Math.max(2, Math.min(MAX_BANDS, Math.round(bands ?? DEFAULT_BANDS)));
    const a = parseColor(from);
    const b = parseColor(to);
    const span: `${number}%` = `${100 / n + OVERLAP_PCT}%`;
    const out: ViewStyle[] = [];

    for (let i = 0; i < n; i += 1) {
      // 分母是 n-1：最後一條要**剛好**是終點色，用 n 的話漸層永遠差一階沒走完。
      const color = mix(a, b, i / (n - 1));
      const offset: `${number}%` = `${(i / n) * 100}%`;
      out.push(
        direction === 'horizontal'
          ? { position: 'absolute', top: 0, bottom: 0, left: offset, width: span, backgroundColor: color }
          : { position: 'absolute', left: 0, right: 0, top: offset, height: span, backgroundColor: color },
      );
    }
    return out;
  }, [from, to, bands, direction]);

  return (
    // 漸層永遠不吃觸控：它幾乎都疊在可按的卡片上，攔到手勢就等於那張卡壞了。
    <View pointerEvents="none" style={[styles.root, style]} testID={testID}>
      {bandStyles.map((s, i) => (
        <View key={i} style={s} />
      ))}
    </View>
  );
}

const Gradient = React.memo(GradientBase);

export default Gradient;

const styles = StyleSheet.create({
  // 最後一條會超出下緣（重疊那 0.5%），沒有 hidden 就會漏到外面。
  root: { overflow: 'hidden' },
});
