/**
 * TermSheet — 逐字稿裡某個標注詞的解釋，從底部滑上來。
 *
 * 出現時機是「一邊聽一邊點了逐字稿裡的一個詞」，所以它必須讀起來像旁註、不像打斷：
 * 不問問題、不要決定。需要學習者判斷的 Confirm / Dismiss 一律留到隔天的 daily
 * session —— 聽的當下不打斷是產品底線（Snipd 的教訓）。
 *
 * 這裡顯示的是逐字稿標注，不是 capture 的 diagnosis：兩者共用同一組六類難點與
 * 中文標籤（`diagnosisLabel()`，不另外複製一份），但標注沒有 learning focus。
 *
 * 這裡唯一的例外是「＋ 加入練習」：它只有一個動作、沒有問題、沒有分支，按完
 * 面板不關、播放位置紋風不動（不 seek、不 pause、不建 replay event）。之所以
 * 值得破一次例，是因為「看完即丟」是 Involvement Load 裡保留率最低的條件——
 * 學習者點開解釋、關掉、然後什麼都沒留下。「詞還是句型」那一題是 evaluation，
 * 留到隔天的練習卡，聽的當下一題都不問。
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
import { diagnosisLabel } from '../lib/diagnose';
import { C, GLASS, R, SP, TYPE } from '../lib/theme';
import { DiagnosisType } from '../lib/types';
import { t, useLang } from '../lib/i18n';

/**
 * 六類各給一個色相。顏色本身就是重複模式的提示——連續幾天都點到同一個色相，
 * 學習者自己就會發現「我卡的是連音」，不必等我們寫報表告訴他。
 *
 * **分類色不從語意色借。** 舊版的 `vocab` 是 `#4ADE80`，跟 `C.accent` 一個位元
 * 都不差——而綠色在這個 app 裡是「學習者動手了」的化身（見 theme.ts 檔頭）。
 * 同一張紙上綠色 chip 與綠色「加入練習」鍵並排，那顆 chip 就讀起來像可以按的
 * 東西，而它只是一個標籤。所以整組改成**低彩度**（S≈32%、L≈72% 的同一族），
 * 並避開三個語意色相：綠 142°、琥珀 43°、藍 217°。彩度低到讀起來像標籤、不像
 * 按鈕，是這組色唯一要做到的事；區分六類靠色相，不靠飽和度。
 *
 * 對比度以 `C.surface`（chip 底是 tint 的 10% alpha，等於幾乎全是 surface）實算，
 * 全部 ≥ 7:1，遠高於 AA。
 *
 * TODO(theme): 這一組該搬進 `lib/theme.ts` 成為 `CATEGORY`（與 GLASS/BLOOM 同級
 * 的非語意色群），現在放在這裡只是因為 theme.ts 這一輪不屬於本檔案的 owner。
 * 搬家時連同這段「為什麼不借語意色」的理由一起搬，否則下一個人又會借。
 */
const TYPE_COLORS: Record<DiagnosisType, string> = {
  vocab: '#A1CECE',
  linking: '#A1A7CE',
  speed: '#CEB2A1',
  grammar: '#B9A1CE',
  accent: '#CEA1A7',
  culture: '#CEA1C1',
};

interface TermSheetProps {
  term: Term | null;
  /**
   * 這個詞能不能加入練習。呼叫端反查不到句子時傳 false —— 那時整顆按鈕**不出現**，
   * 而不是出現但按了沒反應。窗口重轉會讓 Whisper 的斷句挪動零點幾秒、segmentKey
   * 跟著改變，反查 miss 是正常情形，不是錯誤。
   */
  canSave: boolean;
  /** 已經加過了（含跨重啟：呼叫端查 store）。true 時按鈕變成不可按的「已加入」。 */
  saved: boolean;
  onSave: () => void;
  onClose: () => void;
}

export default function TermSheet({
  term,
  canSave,
  saved,
  onSave,
  onClose,
}: TermSheetProps) {
  // 訂閱語言：回傳值不用，作用是讓這個元件在切換語言時重繪，
  // 好讓底下的 t() 重新查表。
  useLang();
  // 關閉的瞬間 term 就變成 null，但 Modal 還要滑下去 ~300ms。留住最後一個 term，
  // 否則使用者會看著一張突然變空白的紙滑出畫面。
  const lastTerm = useRef<Term | null>(null);
  // 兩個旗標跟 term 同一批鎖住：它們是父層依 term 算出來的，term 一 null 它們
  // 也跟著垮，不一起留就會看到按鈕在滑出途中消失。
  const lastFlags = useRef({ canSave: false, saved: false });
  if (term) {
    lastTerm.current = term;
    lastFlags.current = { canSave, saved };
  }
  const shown = term ?? lastTerm.current;
  const flags = term ? { canSave, saved } : lastFlags.current;

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
          accessibilityLabel={t('term.a11y_close')}
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
                  {diagnosisLabel(shown.type)}
                </Text>
              </View>

              {/* 解釋通常兩三行；長解釋讓它自己捲，不要把底下那列按鈕推出畫面外。 */}
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollBody}
                showsVerticalScrollIndicator={false}
              >
                <Text style={styles.explanation}>{shown.explanation_zh}</Text>
              </ScrollView>
            </>
          )}

          <View style={styles.actions}>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={t('term.a11y_dismiss')}
            >
              <Text style={styles.dismissText}>{t('term.ok')}</Text>
            </Pressable>

            {/* 反查不到句子就整顆不出現：出現但按了沒反應，比沒有這顆更難理解。 */}
            {flags.canSave && (
              <Pressable
                // enabled 判斷用 live 的 `term`：面板正在滑出時不該還能觸發寫入。
                onPress={term && !saved ? onSave : undefined}
                disabled={flags.saved}
                style={({ pressed }) => [
                  styles.save,
                  flags.saved && styles.saveDone,
                  pressed && !flags.saved && styles.pressed,
                ]}
                accessibilityRole="button"
                accessibilityState={{ disabled: flags.saved }}
                accessibilityLabel={flags.saved ? t('term.added') : t('term.a11y_add')}
              >
                <Text style={[styles.saveText, flags.saved && styles.saveDoneText]}>
                  {flags.saved ? t('term.added_check') : t('term.add')}
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  // RN 0.86 只留下 `absoluteFill`（`absoluteFillObject` 已從型別與 runtime 移除）。
  // 展開的是一個 frozen 純物件，所以 spread 之後還能覆寫 backgroundColor。
  //
  // 遮罩走 `GLASS.scrim`（原本寫死 '#000000A6'）：純黑遮罩會把底下 `C.bg` 的
  // 深藍調洗成灰，面板滑上來的那 300ms 看得出整個畫面偏色。scrim 本來就是為
  // 「sheet 背後」定義的，用它才會跟 app 其餘的覆蓋層同一個溫度。
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: GLASS.scrim },

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

  // marginTop 從 `dismiss` 移上來：兩顆按鈕共用同一道與內文的距離，各自帶
  // marginTop 的話少了任何一顆就會塌掉。
  actions: { flexDirection: 'row', gap: SP(2), marginTop: SP(3) },
  dismiss: {
    flex: 1,
    backgroundColor: C.surfaceAlt,
    borderRadius: R.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  dismissText: { ...TYPE.body, color: C.text, fontSize: 16, fontWeight: '700' },
  /**
   * 實色綠：這一下是**學習者動手了**（theme.ts 的綠語意），不是 app 在猜。
   * 面板上方那顆彩色 chip 是六類難點的色相（app 的判斷），兩者刻意不同色系——
   * 同一張紙上「app 說什麼」與「我要做什麼」不能長得一樣。
   */
  save: {
    flex: 1,
    backgroundColor: C.accent,
    borderRadius: R.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  saveText: { ...TYPE.body, color: C.accentInk, fontSize: 16, fontWeight: '700' },
  /** 已加入：退成半透明綠底 + 綠字。仍然看得出「這件事成了」，但不再邀請你按。
   *  按完不關面板、不跳 Alert / Toast——這是播放中彈出的紙，任何蓋住畫面的回饋
   *  都是第二次打斷；而他點開這張紙是為了讀解釋，關掉他就讀不完。 */
  saveDone: { backgroundColor: C.accentSurface },
  saveDoneText: { color: C.accent },
  pressed: { opacity: 0.7 },
});
