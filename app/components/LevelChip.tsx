/**
 * 難度帶徽章 —— 五格量表 + 中文標籤。
 *
 * **量出來的與猜出來的必須看得出差別。** `measured: false`（只有節目類型當依據）
 * 時，格子改成空心描邊、標籤加 `~`。學習者照著等級挑材料，而一個瞎猜的等級被畫成
 * 跟量出來的一樣，會讓他挑錯——這個視覺差異不是裝飾，是誠實。
 */
import { StyleSheet, Text, View } from 'react-native';

import { LEVEL, LEVEL_UNKNOWN, R, SP, TYPE } from '../lib/theme';
import { LEVEL_LABEL_ZH, type LevelEstimate } from '../lib/level';

const SEGMENTS = 5;

interface LevelChipProps {
  /** null = 沒有任何依據。顯示「未評估」而不是猜一個。 */
  estimate: LevelEstimate | null;
  /** 卡片角落用的緊湊版：只有格子，不顯示文字。 */
  compact?: boolean;
}

export default function LevelChip({ estimate, compact }: LevelChipProps) {
  const tint = estimate ? LEVEL[estimate.level] : LEVEL_UNKNOWN;
  const filled = estimate?.level ?? 0;
  const measured = estimate?.measured ?? false;

  return (
    <View
      style={[
        styles.chip,
        { backgroundColor: tint.fill, borderColor: tint.edge },
        compact && styles.chipCompact,
      ]}
    >
      <View style={styles.meter}>
        {Array.from({ length: SEGMENTS }, (_, i) => {
          const on = i < filled;
          return (
            <View
              key={i}
              style={[
                styles.seg,
                on && { backgroundColor: tint.ink },
                // 猜的：亮起來的格子只描邊不填滿
                on && !measured && { backgroundColor: 'transparent', borderColor: tint.ink },
                !on && styles.segOff,
              ]}
            />
          );
        })}
      </View>
      {!compact && (
        <Text style={[styles.label, { color: tint.ink }]} numberOfLines={1}>
          {estimate ? `${measured ? '' : '~'}${LEVEL_LABEL_ZH[estimate.level]}` : '未評估'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP(1.5),
    paddingHorizontal: SP(2),
    paddingVertical: SP(1),
    borderRadius: R.pill,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  chipCompact: { paddingHorizontal: SP(1.5), paddingVertical: SP(0.75) },
  meter: { flexDirection: 'row', gap: 2 },
  /** 3×8 的細長格：橫著排像訊號強度，比圓點更容易一眼數出幾格。 */
  seg: { width: 3, height: 8, borderRadius: 1.5, borderWidth: 1, borderColor: 'transparent' },
  segOff: { backgroundColor: 'rgba(255,255,255,0.16)' },
  label: { ...TYPE.caption, fontSize: 11 },
});
