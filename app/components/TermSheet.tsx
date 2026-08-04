/**
 * TermSheet — 逐字稿裡某個標注詞的解釋，從底部滑上來。
 *
 * 出現時機是「一邊聽一邊點了逐字稿裡的一個詞」，所以它必須讀起來像旁註、不像打斷：
 * 不問問題、不要決定、只有一顆「知道了」。需要學習者判斷的 Confirm / Dismiss 一律
 * 留到隔天的 daily session —— 聽的當下不打斷是產品底線（Snipd 的教訓）。
 *
 * 這裡顯示的是逐字稿標注，不是 capture 的 diagnosis：兩者共用同一組六類難點與
 * 中文標籤（`DIAGNOSIS_LABELS_ZH`，不另外複製一份），但標注沒有 learning focus，
 * 也不會產生 capture 或 SRS item。點開它不影響 replay event / signal strength。
 */
import { useRef } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Term } from '../lib/annotate';
import { DIAGNOSIS_LABELS_ZH } from '../lib/diagnose';
import { C, R, SP, TYPE } from '../lib/theme';
import { DiagnosisType } from '../lib/types';

/**
 * 六類各給一個色相。顏色本身就是重複模式的提示——連續幾天都點到藍色，
 * 學習者自己就會發現「我卡的是連音」，不必等我們寫報表告訴他。
 */
const TYPE_COLORS: Record<DiagnosisType, string> = {
  vocab: '#4ADE80',
  linking: '#60A5FA',
  speed: '#FBBF24',
  grammar: '#A78BFA',
  accent: '#F472B6',
  culture: '#2DD4BF',
};

interface TermSheetProps {
  term: Term | null;
  onClose: () => void;
}

export default function TermSheet({ term, onClose }: TermSheetProps) {
  // 關閉的瞬間 term 就變成 null，但 Modal 還要滑下去 ~300ms。留住最後一個 term，
  // 否則使用者會看著一張突然變空白的紙滑出畫面。
  const lastTerm = useRef<Term | null>(null);
  if (term) lastTerm.current = term;
  const shown = term ?? lastTerm.current;

  const tint = shown ? TYPE_COLORS[shown.type] : C.dim;

  return (
    // Modal 常駐在 tree 上、只切 visible —— 每次開啟都重建原生 view 會讓第一幀
    // 掉格，而這個面板是在播放中彈出的，任何卡頓都會被當成 app 打斷了聆聽。
    <Modal
      visible={term !== null}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="關閉解釋，回到播放"
        />

        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.grabber} />

          {shown && (
            <>
              <Text style={styles.term} selectable>
                {shown.term}
              </Text>

              <View
                style={[
                  styles.chip,
                  { backgroundColor: `${tint}1A`, borderColor: `${tint}55` },
                ]}
              >
                <Text style={[styles.chipText, { color: tint }]}>
                  {DIAGNOSIS_LABELS_ZH[shown.type]}
                </Text>
              </View>

              {/* 解釋通常兩三行；長解釋讓它自己捲，不要把「知道了」推出畫面外。 */}
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollBody}
                showsVerticalScrollIndicator={false}
              >
                <Text style={styles.explanation}>{shown.explanation_zh}</Text>
              </ScrollView>
            </>
          )}

          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="知道了，關閉解釋"
          >
            <Text style={styles.dismissText}>知道了</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  // RN 0.86 只留下 `absoluteFill`（`absoluteFillObject` 已從型別與 runtime 移除）。
  // 展開的是一個 frozen 純物件，所以 spread 之後還能覆寫 backgroundColor。
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: '#000000A6' },

  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: R.xl,
    borderTopRightRadius: R.xl,
    borderTopWidth: 1,
    borderColor: C.border,
    paddingHorizontal: SP(3),
    paddingTop: SP(2),
    // 專案沒裝 react-native-safe-area-context（package.json 已確認），所以直接補
    // iPhone home indicator 的 34pt，讓按鈕不會壓在指示條上。
    paddingBottom: Platform.OS === 'ios' ? 34 : SP(3),
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: R.pill,
    backgroundColor: C.border,
    marginBottom: SP(3),
  },

  term: { ...TYPE.title, color: C.text, fontSize: 28, lineHeight: 34 },
  chip: {
    alignSelf: 'flex-start',
    marginTop: SP(2),
    borderWidth: 1,
    borderRadius: R.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  chipText: { ...TYPE.caption, fontSize: 12, fontWeight: '700' },

  scroll: { maxHeight: 240, marginTop: SP(3) },
  scrollBody: { paddingBottom: SP(1) },
  // 中文在緊的行距下很難讀 —— 給它 1.7x 的行高，這是一段要「看懂」的字，
  // 不是標籤。
  explanation: { ...TYPE.body, color: C.text, fontSize: 16, lineHeight: 27 },

  dismiss: {
    marginTop: SP(3),
    backgroundColor: C.surfaceAlt,
    borderRadius: R.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  dismissText: { ...TYPE.body, color: C.text, fontSize: 16, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
