/**
 * 用 View 畫出來的圖示，取代原本直接寫在按鈕裡的文字符號（'▶'、'❚❚'、'⌄'）。
 *
 * 為什麼不用文字符號：它們是**字型的字**，不同機器、不同字重下大小與基線都會飄，
 * 而且垂直置中永遠差一點——那正是介面看起來「僵硬、像半成品」的來源。用 View 畫
 * 的形狀由我們自己控制像素。
 *
 * 專案刻意不裝 icon 套件（@expo/vector-icons 會多帶幾 MB 字型進 bundle，而我們
 * 全部只需要六個形狀）。
 */
import { StyleSheet, Text, View } from 'react-native';

import { C, TYPE } from '../lib/theme';

/** 實心三角形。RN 的 border trick：三個邊透明，剩下那邊就是三角形。 */
export function PlayIcon({ size = 22, color = C.text }: { size?: number; color?: string }) {
  return (
    <View
      style={{
        width: 0,
        height: 0,
        borderStyle: 'solid',
        borderTopWidth: size * 0.5,
        borderBottomWidth: size * 0.5,
        borderLeftWidth: size * 0.86,
        borderRightWidth: 0,
        borderTopColor: 'transparent',
        borderBottomColor: 'transparent',
        borderRightColor: 'transparent',
        borderLeftColor: color,
        // 三角形的視覺重心偏左，往右推一點才會落在圓形按鈕的正中間。
        marginLeft: size * 0.14,
      }}
    />
  );
}

export function PauseIcon({ size = 20, color = C.text }: { size?: number; color?: string }) {
  const bar = { width: size * 0.3, height: size, borderRadius: size * 0.1, backgroundColor: color };
  return (
    <View style={{ flexDirection: 'row', gap: size * 0.22 }}>
      <View style={bar} />
      <View style={bar} />
    </View>
  );
}

/**
 * 環形箭頭 + 中間的秒數，就是 Podcasts / Overcast 的跳轉鍵。
 *
 * 環用文字符號（↺ / ↻）是這裡唯一的例外：純 View 畫不出帶箭頭的圓弧，而這兩個
 * 字符在 iOS/Android 系統字型裡都存在且形狀穩定。數字疊在正中間，不靠字型排版。
 */
export function SkipIcon({
  seconds,
  direction,
  size = 30,
  color = C.text,
}: {
  seconds: number;
  direction: 'back' | 'forward';
  size?: number;
  color?: string;
}) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: size, lineHeight: size * 1.06, color }}>
        {direction === 'back' ? '↺' : '↻'}
      </Text>
      <Text
        style={[
          styles.skipNum,
          { color, fontSize: size * 0.32, lineHeight: size * 0.32 },
        ]}
      >
        {seconds}
      </Text>
    </View>
  );
}

/** V 形。旋轉一個只留兩邊框的方塊——比字型的 '⌄' 銳利、粗細可控。 */
export function Chevron({
  direction = 'down',
  size = 10,
  color = C.dim,
  weight = 2,
}: {
  direction?: 'up' | 'down';
  size?: number;
  color?: string;
  weight?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRightWidth: weight,
        borderBottomWidth: weight,
        borderRightColor: color,
        borderBottomColor: color,
        transform: [{ rotate: direction === 'down' ? '45deg' : '225deg' }],
        // 旋轉後形狀的視覺中心會偏，補回來
        marginTop: direction === 'down' ? -size * 0.3 : size * 0.3,
      }}
    />
  );
}

/** 三條長短不一的橫線 = 逐字稿。 */
export function TranscriptIcon({ size = 14, color = C.dim }: { size?: number; color?: string }) {
  const bar = (w: string) => ({
    width: w as unknown as number,
    height: Math.max(1.5, size * 0.11),
    borderRadius: 2,
    backgroundColor: color,
  });
  return (
    <View style={{ width: size, gap: size * 0.22 }}>
      <View style={bar('100%')} />
      <View style={bar('72%')} />
      <View style={bar('88%')} />
    </View>
  );
}

const styles = StyleSheet.create({
  skipNum: {
    ...TYPE.mono,
    position: 'absolute',
    fontWeight: '700', // 要壓過 TYPE.mono 的 600，所以放在展開之後
    textAlign: 'center',
  },
});
