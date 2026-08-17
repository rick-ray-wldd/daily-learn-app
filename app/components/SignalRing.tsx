/**
 * 本週訊號環：重聽 → 確認 → 掌握，同一條漏斗的三段。
 *
 * **畫法是 48 根小條繞一圈，不是圓弧。** 純 View 畫任意角度的圓弧要靠半圓遮罩
 * 疊層旋轉，數學繁瑣又極容易在 0°/180°/360° 的邊界出錯；而 react-native-svg 是
 * 原生模組，裝下去使用者就得重新 build（這六天只能靠 OTA）。刻度環用同一組
 * transform 就表達得出比例，而且「分段」在視覺上比連續弧更明確——這個環要講的
 * 本來就是三個離散的階段。
 *
 * 三段**同色相、不同濃度**（RAMP）：「重聽 → 確認 → 掌握」講的是同一件事
 * （學習者動手了）走到多遠，換色相會讓它讀起來像三種不同的東西，那正好是這個
 * 環要否認的。
 *
 * 空環（rewinds === 0）畫成 `GLASS.well` 而不是灰色的假資料：這一週真的還沒有
 * 訊號，環就該看起來是空的凹槽，不該讓人以為「有一點點進度」。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';

import { C, GLASS, RAMP, TYPE } from '../lib/theme';
// centerLabel 的預設值用 t()：預設參數在**每次呼叫時**求值，所以呼叫端
// （HomeScreen，它有 useLang）重繪時就會拿到新語言，這裡不必自己訂閱。
import { t } from '../lib/i18n';

export interface SignalRingProps {
  /** 本週重聽段落數 = 環的分母。0 → 空環。 */
  rewinds: number;
  /** 其中已確認的（≤ rewinds）。 */
  confirmed: number;
  /** 其中已掌握的（≤ confirmed）。 */
  mastered: number;
  /** 直徑，預設 92。 */
  size?: number;
  /** 中央大字，預設 rewinds。 */
  centerValue?: number;
  /** 中央小字，預設 '重聽'。 */
  centerLabel?: string;
}

const TICKS = 48;
const TICK_W = 3;
const TICK_H = 9;

function SignalRingBase({
  rewinds,
  confirmed,
  mastered,
  size = 92,
  centerValue,
  centerLabel = t('signal.center'),
}: SignalRingProps): React.ReactElement {
  const tickStyles = useMemo<ViewStyle[]>(() => {
    const n = Math.max(0, Math.round(rewinds));
    // 夾住上界：漏斗是逐層過濾出來的，理論上不會倒掛，但一旦倒掛（資料損毀、
    // 呼叫端算錯）畫出來的環會比分母還滿，那是騙人的圖。
    const m = Math.max(0, Math.min(n, Math.round(confirmed)));
    const k = Math.max(0, Math.min(m, Math.round(mastered)));

    const fullTicks = n > 0 ? Math.round((TICKS * k) / n) : 0;
    const midTicks = n > 0 ? Math.round((TICKS * m) / n) : 0;

    const out: ViewStyle[] = [];
    for (let i = 0; i < TICKS; i += 1) {
      const color =
        n === 0
          ? GLASS.well
          : i < fullTicks
            ? RAMP.accentFull
            : i < midTicks
              ? RAMP.accentMid
              : RAMP.accentWeak;
      out.push({
        position: 'absolute',
        width: TICK_W,
        height: TICK_H,
        borderRadius: TICK_W / 2,
        backgroundColor: color,
        transform: [
          // 順序不能對調：RN 依陣列順序做矩陣相乘，所以 translateY 是沿著**已經
          // 轉過**的軸位移——先轉再推，小條才會落在圓周上並且自己朝向圓心。
          { rotate: `${(i * 360) / TICKS}deg` },
          { translateY: -(size / 2 - TICK_H / 2) },
        ],
      });
    }
    return out;
  }, [rewinds, confirmed, mastered, size]);

  return (
    <View style={[styles.root, { width: size, height: size }]}>
      {tickStyles.map((s, i) => (
        <View key={i} style={s} />
      ))}
      {/* 刻度是絕對定位、中央這塊在流內，所以它天生疊在上面，不需要 zIndex。 */}
      <View style={styles.center}>
        <Text style={styles.value}>{centerValue ?? rewinds}</Text>
        <Text style={styles.label}>{centerLabel}</Text>
      </View>
    </View>
  );
}

/** 首頁每 250ms 就會因為播放位置重繪一次；沒有 memo 的話這 48 根小條每秒重建 4 次。 */
const SignalRing = React.memo(SignalRingBase);

export default SignalRing;

const styles = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center' },
  value: { ...TYPE.title, color: C.text },
  // 玻璃面板上的次要文字一律 C.dim（C.faint 的對比只對 bg / surface 實算過）。
  label: { ...TYPE.caption, color: C.dim, fontWeight: '400' },
});
