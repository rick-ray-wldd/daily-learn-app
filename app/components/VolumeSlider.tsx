/**
 * 音量滑桿——手刻的，因為沒有別的選擇。
 *
 * RN 核心的 `Slider` 早就移除（import 會直接丟 invariant），而
 * `@react-native-community/slider` 是原生模組：裝下去使用者就得重新 build，
 * 而這六天的迭代全部只能靠 OTA。所以這裡跟另外兩份 scrubber 一樣走 PanResponder。
 *
 * ⚠️ **它調的不是系統音量。** `player.volume`（expo-audio 57，可寫，0.0–1.0）是
 * app 內部的播放增益，實際聽到的大小是「系統音量 × 這個值」。而 `AudioStatus`
 * 只有 `mute`、**沒有 volume 欄位**——調過去的值讀不回來，所以 App.tsx 的 state
 * 是唯一真相；使用者用實體按鍵或控制中心改動系統音量，這條軌道完全不會動。
 * 這不是 bug，是這個 API 的形狀，UI 不該假裝自己知道系統音量在哪。
 *
 * 這是全 app 第三份 PanResponder 軌道（另兩份是 NowPlaying 與 TranscriptScreen 的
 * scrubber），照那兩份抄，但有四處**必須不同**，見下方 onStartShouldSetPanResponder、
 * onMoveShouldSetPanResponder、onPanResponderMove 與 ratioAtX 的註解。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, PanResponder, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { C, GLASS, SP } from '../lib/theme';

export interface VolumeSliderProps {
  /** 0–1。 */
  value: number;
  /** 拖曳過程中就會被呼叫（**刻意即時**，見 onPanResponderMove）。 */
  onChange: (value: number) => void;
  /** 放手時再呼叫一次；省略時只用 onChange。 */
  onCommit?: (value: number) => void;
  /** 軌道高度，預設 4。 */
  trackHeight?: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/** 拇指直徑。與 NowPlaying 的 13 對齊到偶數，置中的負 margin 才不會有半像素。 */
const THUMB = 12;
/** 小圖示的三根直條，由矮到高。寬度固定 3。 */
const GLYPH_BARS = [5, 8, 11];

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * 軌道兩側的音量圖示。畫在這支檔案裡而不是 Glyph.tsx——那支檔案這一輪唯讀。
 * 純 View、不依賴字型：'🔈' 這類字符在不同系統上會變成彩色 emoji，大小也飄。
 *
 * 弱／強**不用顏色區分**：這排圖示活在玻璃面板上，而玻璃底下是「底色 × 半透明
 * 填色 × 可能還有色暈」的變數，`C.faint` 的對比在那裡沒有保證（theme.ts 檔頭）。
 * 改成用「亮起幾根」來表達——這同時跟旁邊軌道的「填色 vs 凹槽」是同一套語言：
 * 亮 = `C.dim`，暗 = `GLASS.well`。
 */
function VolumeGlyph({ level }: { level: 'low' | 'high' }) {
  return (
    <View style={styles.glyph}>
      {GLYPH_BARS.map((h, i) => (
        <View
          key={h}
          style={[
            styles.glyphBar,
            { height: h },
            level === 'high' || i === 0 ? styles.glyphBarOn : styles.glyphBarOff,
          ]}
        />
      ))}
    </View>
  );
}

export default function VolumeSlider({
  value,
  onChange,
  onCommit,
  trackHeight = 4,
  accessibilityLabel = 'App 音量',
  style,
}: VolumeSliderProps) {
  const [dragging, setDragging] = useState(false);

  // PanResponder 只建立一次（重建會讓拖曳中途斷手），所以它看到的所有會變的值
  // 一律走 ref —— 直接閉包會永遠讀到第一次 render 的寬度與 callback。
  const barWidthRef = useRef(0);
  const valueRef = useRef(value);
  const scrubStartRef = useRef(0);
  const changeRef = useRef(onChange);
  const commitRef = useRef<(v: number) => void>(() => {});

  useEffect(() => {
    valueRef.current = value;
    changeRef.current = onChange;
    // onCommit 省略時就用 onChange：放手那一下永遠要有一個確定的終值送出去，
    // 否則最後一格移動若被系統吃掉，UI 與 player 會停在不同的數字上。
    commitRef.current = onCommit ?? onChange;
  });

  const ratioAtX = (x: number) => {
    const w = barWidthRef.current;
    // 寬度還沒量到就回**現在的值**，不是 0：回 0 會在第一幀直接把音量歸零。
    // （scrubber 那兩份回 0 是安全的，因為它們的 0 是「回到開頭」而不是「靜音」。）
    if (w <= 0) return valueRef.current;
    return clamp01(x / w);
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        /**
         * **這是三份實作裡唯一活在捲動容器（首頁 MasonryList 的 ScrollView）裡的
         * 一份**，所以它在觸控按下的那一刻必須放手，只在手勢明顯偏水平時才接手。
         *
         * 另外兩份寫的是 `() => true`，**直接抄過來是壞的**：responder 一旦在
         * touch-down 就被拿走，React 的 responder 協商從此不會再問這個 view
         * `onMoveShouldSetResponder`（已經是 responder 時走的是
         * accumulateTwoPhaseDispatchesSingleSkipTarget，會跳過 responder 自己），
         * 底下那道「偏水平才接手」的守衛就成了死碼。後果是：手指落在這條 28px 高、
         * 與 hero 同寬的可按範圍上、想往上滑捲到「探索」時，onPanResponderGrant
         * 會立刻把音量設成落點比例——按在左側 15% 處，正在聽的內容當場近乎靜音，
         * 而接著捲動開始、iOS 取消觸控，terminate 也不會把它還回來。Android 上更糟：
         * onResponderGrant 預設回傳 true 當 blockNativeResponder，手指起始於音量條
         * 時整頁完全捲不動。
         *
         * 代價是**點一下不會設定音量，只能拖**。這是刻意換的：在捲動容器裡，
         * 「按下就是要調音量」與「按下只是想捲頁」在那一幀根本分不出來，而猜錯
         * 的那一邊會把使用者正在聽的東西弄靜音。
         */
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 4,
        // 接手之後就不放：底下的 ScrollView 不該在拖曳中途把手勢搶回去。
        onPanResponderTerminationRequest: () => false,
        // grant 現在發生在「已經水平移動幾 px」之後，不是按下的瞬間。這裡記的
        // locationX 因此是**接手當下**的指尖位置，而 PanResponder 在 grant 會把
        // gestureState.dx 歸零、x0 重設成當下重心（PanResponder.js:459-462），
        // 所以底下 `scrubStart + dx` 不會把接手前那段位移重複算一次。
        onPanResponderGrant: (e) => {
          setDragging(true);
          scrubStartRef.current = e.nativeEvent.locationX;
          changeRef.current(ratioAtX(scrubStartRef.current));
        },
        onPanResponderMove: (_e, gesture) => {
          /**
           * 拖曳中**就送值出去**，這一點跟 scrubber 剛好相反：scrubber 每一個中途
           * 位置都可能觸發一次要錢的 Whisper 窗口，所以刻意等放手；音量沒有這個
           * 成本，而拖的時候聽不到音量在變才是壞掉。
           *
           * 座標用「按下的點 + dx」而不是移動中的 locationX：後者是相對於當下被
           * 命中的子 view，手指滑出軌道時會突然跳掉。
           */
          changeRef.current(ratioAtX(scrubStartRef.current + gesture.dx));
        },
        onPanResponderRelease: (_e, gesture) => {
          setDragging(false);
          commitRef.current(ratioAtX(scrubStartRef.current + gesture.dx));
        },
        // 被系統打斷（來電、手勢衝突）：停在最後送出的值就好。這裡不像 scrubber
        // 需要「放棄這次拖曳」——中途的值早就一路生效了，沒有東西要回滾。
        onPanResponderTerminate: () => setDragging(false),
      }),
    // 只讀 ref，不需要（也不可以）重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onBarLayout = (e: LayoutChangeEvent) => {
    barWidthRef.current = e.nativeEvent.layout.width;
  };

  const pct = clamp01(value);
  const pctText: `${number}%` = `${pct * 100}%`;

  return (
    // accessible 把整排收成一個 VoiceOver 元素：圖示與軌道各自被讀一次沒有意義，
    // 使用者要的是「音量 40%」這一句話。
    <View
      style={[styles.root, style]}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}
    >
      <VolumeGlyph level="low" />

      <View style={styles.barTouch} onLayout={onBarLayout} {...responder.panHandlers}>
        {/* 軌道是**凹**的所以用 GLASS.well；玻璃（凸的）用白色低 alpha，兩者不能互換。
            填色用 C.primary：音量是中性 chrome。這裡絕對不能用綠色——綠色的意思是
            「學習者動手了」，拿去畫音量會讓那個訊號變成裝飾。 */}
        <View style={[styles.track, { height: trackHeight, borderRadius: trackHeight / 2 }]}>
          <View style={[styles.fill, { width: pctText }]} />
        </View>
        {/* pointerEvents none 是必要的：拇指若吃得到觸控，從拇指上按下時 grant 的
            locationX 會變成「相對於拇指」，一按就跳到最左邊。 */}
        <View
          pointerEvents="none"
          style={[styles.thumb, dragging && styles.thumbActive, { left: pctText }]}
        />
      </View>

      <VolumeGlyph level="high" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flexDirection: 'row', alignItems: 'center', gap: SP(3) },

  // 軌道只有 4px 高，但可按範圍要有 28：手指的接觸面比視覺元素大得多，
  // 照著視覺高度做出來的滑桿會「按不太到」。
  barTouch: { flex: 1, height: 28, justifyContent: 'center' },
  track: { overflow: 'hidden', backgroundColor: GLASS.well },
  fill: { height: '100%', backgroundColor: C.primary },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: C.text,
    marginLeft: -THUMB / 2,
  },
  // 只動 transform，走 native driver 的同一套屬性，不會觸發 layout。
  thumbActive: { transform: [{ scale: 1.4 }] },

  glyph: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  glyphBar: { width: 3, borderRadius: 1.5 },
  glyphBarOn: { backgroundColor: C.dim },
  glyphBarOff: { backgroundColor: GLASS.well },
});
