/**
 * SelectionSheet —— 框完之後問一句：你圈的是「詞」還是「句型」。
 *
 * 只問這一題，而且只有兩個選項。使用者剛剛已經用兩次點擊親手指出難點了，這張紙
 * 若再問「這段是真的沒聽懂嗎」就是在懷疑他自己給的答案（那一題屬於倒帶來的
 * capture，不屬於這裡）。
 *
 * 這一欄與診斷的六類難點刻意分開：這裡收的是**使用者意圖**，診斷寫的是 **app 的
 * 判斷**。兩者不一致（他圈了一個詞、診斷認為難在連音）本身就是有價值的資料。
 *
 * ⚠️ 這張 sheet **不做任何寫入**，只回報使用者選了哪一類——寫入由呼叫端
 * （TranscriptScreen）透過 `lib/selection.ts` 的 commitSelection 執行。理由是
 * 選取的四個狀態全在 TranscriptScreen 手上，把寫入搬進來等於要把它們也搬進來。
 */
import { useRef } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { C, GLASS, R, SP, TYPE } from '../lib/theme';
import { SelectionKind, TranscriptSegment } from '../lib/types';
import { t, useLang } from '../lib/i18n';
import Glass from './Glass';

export interface SelectionDraft {
  episodeId: string;
  segment: TranscriptSegment;
  /** 框到的字，已 trim。 */
  text: string;
}

export interface SelectionSheetProps {
  /** 非 null = 開啟。 */
  draft: SelectionDraft | null;
  onCancel: () => void;
  onPick: (kind: SelectionKind) => void;
}

export default function SelectionSheet({
  draft,
  onCancel,
  onPick,
}: SelectionSheetProps) {
  // 訂閱語言：回傳值不用，作用是讓這個元件在切換語言時重繪，
  // 好讓底下的 t() 重新查表。
  useLang();
  // 關閉的瞬間 draft 就變成 null，但 Modal 還要滑下去 ~300ms。留住最後一個值，
  // 否則使用者會看著一張突然變空白的紙滑出畫面（與 TermSheet 同一個理由）。
  const lastDraft = useRef<SelectionDraft | null>(null);
  if (draft) lastDraft.current = draft;
  const shown = draft ?? lastDraft.current;

  return (
    // Modal 常駐在 tree 上、只切 visible —— 每次開啟都重建原生 view 會讓第一幀
    // 掉格，而這張紙是在播放中彈出的，任何卡頓都會被當成 app 打斷了聆聽。
    <Modal
      visible={draft !== null}
      animationType="slide"
      transparent
      onRequestClose={onCancel}
    >
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel={t('select.a11y_cancel')}
        />

        {/* 這張紙上發生的事是「學習者親手指認難點」，所以綠暈是它憑語意賺到的。 */}
        <Glass
          weight="thick"
          bloom="accent"
          bloomCorner="topRight"
          radius={R.xl}
          style={styles.sheet}
        >
          <View accessibilityViewIsModal>
            <View style={styles.grabber} />

            {shown && (
              <>
                {/* 他自己給的答案，是這張紙上最該被看見的東西。 */}
                <Text style={styles.selection} numberOfLines={2}>
                  {shown.text}
                </Text>

                {/* 整句只是提醒他框在哪裡，所以壓到次要層級（玻璃上不用 faint）。 */}
                <Text style={styles.sentence} numberOfLines={2}>
                  {shown.segment.text.trim()}
                </Text>
              </>
            )}

            <View style={styles.actions}>
              {/* 綠按鈕維持實色：accentInk 的 9.7:1 是對實色 accent 算的，
                  鋪在半透明玻璃上那個對比度就不再成立。 */}
              <Pressable
                onPress={() => onPick('vocab')}
                style={({ pressed }) => [styles.pick, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={t('select.a11y_word')}
              >
                <Text style={styles.pickText}>{t('select.word')}</Text>
              </Pressable>

              <Pressable
                onPress={() => onPick('grammar')}
                style={({ pressed }) => [styles.pick, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={t('select.a11y_pattern')}
              >
                <Text style={styles.pickText}>{t('select.pattern')}</Text>
              </Pressable>
            </View>

            <Pressable
              onPress={onCancel}
              style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={t('select.a11y_cancel')}
            >
              <Text style={styles.cancelText}>{t('select.cancel')}</Text>
            </Pressable>
          </View>
        </Glass>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  // RN 0.86 只留下 `absoluteFill`（`absoluteFillObject` 已從型別與 runtime 移除）。
  // 展開的是一個 frozen 純物件，所以 spread 之後還能覆寫 backgroundColor。
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: GLASS.scrim },

  sheet: {
    // 紙貼在螢幕底緣，下面兩個圓角只會露出背後的遮罩，看起來像沒對齊。
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    paddingHorizontal: SP(4),
    paddingTop: SP(2),
    // 專案沒裝 react-native-safe-area-context，直接補 iPhone home indicator 的
    // 34pt，讓「取消」不會壓在指示條上。
    paddingBottom: Platform.OS === 'ios' ? 34 : SP(3),
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: R.pill,
    // 玻璃是凸的，抓握條是凹的 —— 用 well 而不是白色高光。
    backgroundColor: GLASS.well,
    marginBottom: SP(3),
  },

  selection: {
    ...TYPE.title,
    color: C.text,
    alignSelf: 'flex-start',
    backgroundColor: C.accentSurface,
    borderRadius: R.sm,
    paddingHorizontal: SP(2),
    paddingVertical: SP(1),
    overflow: 'hidden', // iOS 上 Text 的圓角要靠這個才會裁
  },
  sentence: { ...TYPE.caption, color: C.dim, marginTop: SP(2), lineHeight: 18 },

  actions: { flexDirection: 'row', gap: SP(3), marginTop: SP(5) },
  pick: {
    flex: 1,
    backgroundColor: C.accent,
    borderRadius: R.md,
    paddingVertical: 16,
    alignItems: 'center',
  },
  pickText: { ...TYPE.body, color: C.accentInk, fontSize: 16, fontWeight: '700' },

  cancel: { marginTop: SP(3), paddingVertical: SP(2), alignItems: 'center' },
  cancelText: { ...TYPE.body, color: C.dim, fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
