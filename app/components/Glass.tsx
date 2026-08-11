/**
 * 毛玻璃面板。全 app 的質感地基——每一塊「浮起來的東西」都該是這支元件。
 *
 * 為什麼不用 expo-blur / expo-glass-effect（SDK 57 兩者都有）：它們是原生模組，
 * 裝下去使用者就得重新 build，而這六天只能靠 OTA 迭代。這裡用三層疊出來：
 *
 *   底填（`GLASS.fill`）＋ 上緣 1px 高光（`GLASS.sheen`）＋ hairline 外框（`GLASS.edge`）
 *
 * 真・毛玻璃比這個多的只有「背景模糊」——而我們的背景是純色 `C.bg`，模糊純色
 * 等於沒模糊。**上緣那條 1px 高光才是玻璃感的來源**：它模擬光線打在面板上緣的
 * 折射，拿掉之後剩下的就只是一張半透明灰卡片。
 *
 * 這支元件**沒有語意**，它只回答「這塊面板是什麼做的」。面板在講什麼，由呼叫端
 * 傳的 `bloom`（色暈）決定，而 bloom 只能用那塊面板憑語意賺到的色相（見 theme.ts
 * 的 BLOOM 註解）。
 *
 * 刻意**不在內部畫漸層**：每個 Glass 只有 2~3 個 View，masonry 一屏幾十張卡才撐
 * 得住。需要漸層的地方由呼叫端自己塞一個 `<Gradient>` 子元素，並遵守「每畫面最多
 * 一個 Gradient」的上限。
 */
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';

import { BLOOM, C, ELEV, GLASS, R } from '../lib/theme';

export type BloomTone = 'accent' | 'primary' | 'highlight';
export type BloomCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | 'center';

export interface GlassProps {
  children?: React.ReactNode;
  /** 圓角，預設 R.lg。 */
  radius?: number;
  /** 'thin' → GLASS.fill（預設）；'thick' → GLASS.fillStrong。 */
  weight?: 'thin' | 'thick';
  /** 語意色暈。只能傳這塊面板憑語意賺到的色相；沒有就不要傳。 */
  bloom?: BloomTone;
  /** 色暈落點，預設 'topRight'。 */
  bloomCorner?: BloomCorner;
  /** 色暈直徑，預設 180。 */
  bloomSize?: number;
  /** 上緣 1px 高光。預設 true —— 關掉就只是灰卡片，只有在面板頂端被其他東西蓋住時才關。 */
  sheen?: boolean;
  /** 外框 hairline。預設 true。 */
  edge?: boolean;
  /** 陰影。預設 false（清單裡每張卡都投影只會讓畫面變髒）。 */
  elevated?: boolean;
  /** 內距捷徑；省略時不加內距。 */
  padding?: number;
  style?: StyleProp<ViewStyle>;
  onLayout?: (e: LayoutChangeEvent) => void;
  testID?: string;
}

const DEFAULT_BLOOM_SIZE = 180;
/**
 * 色暈往面板外推的比例。0.35 是調出來的：再小圓心會進到面板裡、變成一顆看得出
 * 邊界的球；再大就只剩一道弧線，「感覺得到但說不出哪裡有」的錯覺就沒了。
 */
const BLOOM_OVERHANG = 0.35;

function bloomLayout(corner: BloomCorner, size: number): ViewStyle {
  const off = -size * BLOOM_OVERHANG;
  const base: ViewStyle = {
    position: 'absolute',
    width: size,
    height: size,
    borderRadius: size / 2,
  };
  switch (corner) {
    case 'topLeft':
      return { ...base, top: off, left: off };
    case 'bottomLeft':
      return { ...base, bottom: off, left: off };
    case 'bottomRight':
      return { ...base, bottom: off, right: off };
    // 置中要用 50% + 負 margin，不能靠父層的 alignItems：父層的排版屬性是呼叫端
    // 給內容用的，色暈不該跟著內容一起被排。
    case 'center':
      return { ...base, top: '50%', left: '50%', marginTop: -size / 2, marginLeft: -size / 2 };
    case 'topRight':
    default:
      return { ...base, top: off, right: off };
  }
}

function GlassBase({
  children,
  radius = R.lg,
  weight = 'thin',
  bloom,
  bloomCorner = 'topRight',
  bloomSize = DEFAULT_BLOOM_SIZE,
  sheen = true,
  edge = true,
  elevated = false,
  padding,
  style,
  onLayout,
  testID,
}: GlassProps): React.ReactElement {
  const bloomStyle = useMemo<ViewStyle | null>(
    () => (bloom ? { ...bloomLayout(bloomCorner, bloomSize), backgroundColor: BLOOM[bloom] } : null),
    [bloom, bloomCorner, bloomSize],
  );

  const panel = (
    <View
      style={[
        styles.panel,
        {
          borderRadius: radius,
          backgroundColor: weight === 'thick' ? GLASS.fillStrong : GLASS.fill,
        },
        edge ? { borderWidth: 1, borderColor: GLASS.edge } : null,
        padding == null ? null : { padding },
        // 有外層投影時，面板要吃滿外層：flexGrow 而不是 flex:1——flex:1 會把
        // flexBasis 壓成 0，外層沒給高度時整塊會塌成 0。
        elevated ? styles.filled : null,
        elevated ? null : style,
      ]}
      onLayout={elevated ? undefined : onLayout}
      testID={elevated ? undefined : testID}
    >
      {/* 裝飾層永遠在內容底下、永遠不吃觸控。四個邊明寫 0，絕對定位就不會被
          呼叫端的 padding 推進去（Yoga 只有「沒給 inset」的絕對子層會吃到 padding）。 */}
      {bloomStyle ? <View pointerEvents="none" style={bloomStyle} /> : null}
      {sheen ? <View pointerEvents="none" style={styles.sheen} /> : null}
      {children}
    </View>
  );

  if (!elevated) return panel;

  // 陰影不能畫在 overflow:'hidden' 的 View 上（iOS 的 clipsToBounds 會把自己的
  // 陰影一起剪掉），所以照 Artwork.tsx 的老辦法：外層投影、內層裁切。
  // 外層要一個**不透明**底色，iOS 才畫得出便宜的 shadowPath；用 C.bg 是因為所有
  // elevated 的用法都浮在頁面底色上，0.055 白疊上去的結果與直接疊在頁面上一模一樣。
  return (
    <View
      style={[{ borderRadius: radius, backgroundColor: C.bg }, weight === 'thick' ? ELEV.lifted : ELEV.card, style]}
      onLayout={onLayout}
      testID={testID}
    >
      {panel}
    </View>
  );
}

const Glass = React.memo(GlassBase);

export default Glass;

const styles = StyleSheet.create({
  // overflow hidden 同時做兩件事：把溢出面板的色暈裁成圓角的形狀，
  // 以及讓呼叫端塞進來的 <Gradient> 不會在四角露出直角。
  panel: { overflow: 'hidden' },
  filled: { flexGrow: 1 },
  sheen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: GLASS.sheen,
  },
});
