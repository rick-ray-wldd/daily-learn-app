/**
 * PracticeScreen — 每日練習（mvp-spec.md P0「Daily session」）。
 *
 * Queue = 所有 pending captures（selected → strong → weak → saved）＋ 到期的 SRS
 * 複習項目。排序就是證據強度由強到弱：練不完時該先拿到的是他真的卡住的地方。
 * 每張卡的流程（signal-design.md §3：把雜訊過濾變成複習的第一步）：
 *   a. 重聽 context 窗口（1x / 0.7x，到 context_end 自動停）——**永遠可按**
 *   b. 確認：「真的沒聽懂」→ confirmed／「只是分心」→ dismissed（雜訊標註）
 *   c. 逐字稿**漸進式揭露**（線索 → 首字母 → 全文）→ 先問「你覺得卡在哪」→ 才展開
 *      Claude 診斷卡（無 key 時降級）
 *   d. 跟讀錄音（expo-audio recorder），可與原音對照
 *   e. 評分 再來一次/記住了/太簡單 → 簡化 SM-2 → 下一張
 *
 * 版面上的一條原則：**這張卡的主角是那一句話**，其餘全部是它的附屬。所以句子、
 * 重聽鍵、來歷小標三者黏在同一塊玻璃上，中間不插區塊標題（原本重聽鍵被放在
 * 「重聽這段」這個標題底下，跟句子隔了一整個區塊，讀起來像兩件不相干的事）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';

import {
  addPracticeRecord,
  findEpisodeById,
  getCapture,
  getCaptures,
  getPracticeLog,
  getSrsItem,
  getSrsItems,
  initStore,
  subscribe,
  updateCapture,
  upsertSrsItem,
} from '../lib/store';
import {
  DIAGNOSIS_LABELS_ZH,
  diagnoseCapture,
  isDiagnosisConfigured,
} from '../lib/diagnose';
import {
  canTranscribe,
  ensureTranscript,
  preloadTranscript,
  sentencesInWindow,
  WindowSentences,
} from '../lib/transcript';
import {
  gradeSrsItem,
  isDue,
  isDueTomorrow,
  newSrsItem,
  SrsGrade,
  toDateStr,
  todayStr,
} from '../lib/srs';
import { computeStreak, computeWeaknessStats } from '../lib/stats';
import { syncDailyReminder } from '../lib/notifications';
import {
  checkMirrorAssets,
  deriveMirrorPaths,
  MIRROR_ELIGIBLE_STRENGTHS,
} from '../lib/mirrorAudio';
import { Capture, CaptureStrength } from '../lib/types';
import Glass from '../components/Glass';
import Gradient from '../components/Gradient';
import { PauseIcon, PlayIcon } from '../components/Glyph';
import { C as THEME, GLASS, R, RAMP, SP, TYPE } from '../lib/theme';

interface QueueItem {
  capture: Capture;
  mode: 'new' | 'review';
}

type TranscriptPhase =
  | { phase: 'none' } // no OpenAI key and no RSS transcript
  | { phase: 'loading' }
  | { phase: 'failed'; reason: string }
  | { phase: 'ready'; sentences: WindowSentences | null };

/**
 * 逐字稿的三段揭露。原本這裡只有一個 boolean（全遮／全開），於是六張卡在揭露前
 * 長得一模一樣——一整片「點我顯示逐字稿」，學習者無從判斷該不該再聽一次。
 *
 *   clue  只給**前一句**當線索，目標句以真實字長排出來的骨架遮著
 *   hint  骨架換成「首字母 + 點」，字數與長度都還在，但仍要自己補完
 *   full  全文（同時才觸發 Claude 診斷——診斷是答案，不該比題目早出現）
 *
 * 為什麼線索是前一句而不是後一句：聽力理解是往前推進的，前一句是他**已經聽懂**
 * 的那一句，拿它當支點才叫線索；後一句等於先看結局。`sentences.after` 因此留到
 * full 才出現。
 */
type RevealStage = 'clue' | 'hint' | 'full';

/**
 * Mirror 三層音訊階梯的素材狀態。
 *
 *   ① Mirror·分塊  塊內原速 + thought group 邊界停頓   ← 教學價值最高
 *   ② Mirror·慢速  原生慢速（**不是** setPlaybackRate 時間伸縮）
 *   ③ 原音         真實速度                            ← 驗收
 *
 * 為什麼不拿 `setPlaybackRate(0.7)` 冒充第二級：時間伸縮把所有音段等比拉長，
 * 但真實的慢速 speech 是母音與停頓變長、子音幾乎不變。等比拉長會毀掉 tense/lax
 * 母音的時長線索、抹開塞音爆破（偵測詞界最強的線索之一）、把 F0 輪廓拉長成假語調。
 * 而且**弱讀還是弱讀**——"wanna" 放慢仍是 "wanna"，學習者要的是邊界，拉長不會
 * 生出邊界。所以 ① ② 必須是離線預生成的檔案，查不到就整個區塊不顯示。
 *
 * 'none' 與 'idle' 都代表「沒有階梯可走」，但要分開：'idle' 是還沒查（或這張卡
 * 根本不合格），'none' 是查過確定沒有。兩者的畫面一樣，分開只是為了讀 log 時
 * 分得出「沒打網路」與「打了沒有」。
 */
type MirrorState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'none' }
  | { status: 'ready'; chunkedUrl: string; slowUrl: string };

/**
 * 揭露全文之後、診斷卡之前，學習者自己給的答案（noticing）。
 *
 * ⚠️ 只活在 component state，**不寫回 `Capture`**：types.ts 沒有這個欄位，
 * 而 migration 006 連現有欄位都還沒上線（`selection_text` 實測回 42703）。
 * 偷加一個欄位會讓「寫進去了」變成一句假話。這是已知的資料流失，記在 ADR-0022
 * 的 follow-up，不是靜靜補一欄。
 */
type NoticeAnswer =
  | { kind: 'phrase'; text: string }
  | { kind: 'segmentation' }
  | { kind: 'skip' };

/**
 * 「他圈的」與「我們判斷的」比對用的正規化。大小寫、標點、多餘空白都不算差異——
 * 他圈 "wanna go" 而診斷寫 "Wanna go," 是同一處，判成「不同處」會讓對照列
 * 每張卡都在挑他毛病。
 */
function normalizeNotice(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * 兩段文字指的是不是**同一處**。
 *
 * 🔴 **必須以「詞」為單位比，不准用裸的 `a.includes(b)`。** 字元層的包含關係在英文
 * 句子裡到處都是假陽性：`'gonna'.includes('on')`、`'they'.includes('the')`、
 * `'stop'.includes('to')` 全是 true。他只點了一個 "on"、我們判斷的是 "gonna"，
 * 裸 includes 會回他一句「同一處」——那是在告訴他「你跟我們看法一致」，而他指的
 * 根本是別的地方。
 *
 * 為什麼這一格不能將就：這個 app 唯一的資產就是「學習者自己指出來的斷點」，而
 * 「他圈的 vs 我們猜的」一致率是診斷延後**唯一要產出的那個數字**。偏差還剛好偏向
 * 「同意」——那正是延後診斷要消滅的錨定效應，只是換個地方發生而已。
 *
 * 判準：一方的整串詞是另一方的**連續子序列**（"wanna" ⊂ "wanna go" 算同一處，
 * "on" ⊄ "gonna"）。這也保留了原本要的寬鬆度：大小寫與標點在 `normalizeNotice`
 * 就磨掉了，"Wanna go," 與 "wanna go" 仍然是同一處。
 */
function sameNoticeSpan(a: string, b: string): boolean {
  // filter(Boolean)：normalizeNotice 的標點換空白會留下頭尾空白（"hey," → "hey "），
  // 不濾掉會多出一個空字串 token，讓比對整個錯位。
  const wa = a.split(' ').filter(Boolean);
  const wb = b.split(' ').filter(Boolean);
  if (wa.length === 0 || wb.length === 0) return false;
  return containsWordRun(wa, wb) || containsWordRun(wb, wa);
}

/** `haystack` 裡有沒有一段**連續**的詞剛好等於 `needle`。 */
function containsWordRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * 排序權重。**三態不能再用二分法**：`selected`（親手圈出）是最強的一級，
 * 用 `a.strength === 'strong' ? -1 : 1` 會把它跟 weak 掃進同一個 else，
 * 最有把握的那張卡反而排到最後面。
 *
 * `saved` 排最後不是「比較不重要」，是**證據等級最低**：另外三級背後都有一次
 * 真的發生過的倒帶，它只有一次點擊。十分鐘的 session 若只練得完前幾張，該先
 * 拿到的是他真的卡住的地方，而不是他順手收藏的詞。
 */
const STRENGTH_RANK: Record<CaptureStrength, number> = {
  selected: 0,
  strong: 1,
  weak: 2,
  saved: 3,
};

/**
 * 徽章文案。selected 不寫星等——它不是「更強的猜測」，是學習者自己講的。
 * `saved` 同理**更不能給星等**：★ 是倒帶強度的刻度，而它連一次倒帶都沒有，
 * 給它半顆星等於宣稱「這裡有一個很弱的理解斷點」——那是一句假話。它的來歷是
 * 「他自己說想學」，所以文案講的是那個動作。
 */
const STRENGTH_LABEL: Record<CaptureStrength, string> = {
  selected: '✍ 親手圈出',
  strong: '★★★ 強訊號',
  weak: '★ 弱訊號',
  saved: '＋ 你標記想學',
};

/**
 * 徽章文字。**strength 不足以決定它**：segmentation 也是 'selected'，但「親手圈出」
 * 描述的是一個他明講自己做不到的動作（他說的是「我切不出這裡有幾個字」）。同一張
 * 卡上這行字與下方的「你說這裡切不出有幾個字」會當場互相打臉。
 */
function strengthBadge(capture: Capture): string {
  if (capture.selection_kind === 'segmentation') return '✍ 你指了這一句';
  return STRENGTH_LABEL[capture.strength];
}

/**
 * 完成畫面的計數桶。**三個，不是兩個**：「弱訊號」在這個 app 裡有精確意義
 * （＝倒帶了一次，見 STRENGTH_LABEL.weak 與 signalOrigin），把 'saved' 用
 * `isStrongSignal(...) ? 強 : 弱` 掃進去，等於在完成畫面與 practice log 裡
 * 宣稱一批從沒發生過的倒帶——與 confirm rate 那一格是同一個錯誤，只是換成
 * helper 拼字。用 switch + never 而不是第三個 boolean helper：新增一級 strength
 * 時，這裡會在編譯期爆掉，而不是靜靜掉進某個桶。
 */
type SignalBucket = 'strong' | 'weak' | 'saved';

function signalBucket(strength: CaptureStrength): SignalBucket {
  switch (strength) {
    case 'selected':
    case 'strong':
      return 'strong';
    case 'weak':
      return 'weak';
    case 'saved':
      return 'saved';
    default: {
      const never: never = strength;
      return never;
    }
  }
}

/**
 * 「他不只是滑過去」——徽章配色走這條線。
 *
 * 白名單，不是 `!== 'weak'`：舊寫法讓每一級新來源預設變成強訊號，`saved` 一加
 * 進 union 就會靜靜地被算成強訊號、拿到綠底徽章，而它是四級裡最弱的一級。
 * 委派給 `signalBucket` 而不是自己再列一次值：分組只能有一份，兩份遲早會分岔。
 */
function isStrongSignal(strength: CaptureStrength): boolean {
  return signalBucket(strength) === 'strong';
}

/**
 * 倒帶偵測出來的兩級。**confirm rate 唯一合法的母體。**
 *
 * 白名單不是風格：這一格量的是「倒帶偵測準不準」，任何不伴隨倒帶的來源進來都會
 * 把它變成「使用者多常用某個功能」。上一輪用 `!== 'selected'` 打補丁，這一輪
 * 'saved' 就原封不動漏了進來——而且它比 'selected' 更嚴重，連倒帶都沒有。
 */
function isRewindSignal(strength: CaptureStrength): boolean {
  return strength === 'weak' || strength === 'strong';
}

/** 真的有理解斷點的三級。'saved' 是「我想學這個詞」，不是「我這裡沒聽懂」。 */
function isDifficultySignal(strength: CaptureStrength): boolean {
  return strength === 'weak' || strength === 'strong' || strength === 'selected';
}

/**
 * 這張卡的來歷：「你在這裡做了什麼」。
 *
 * ⚠️ 為什麼不是一個精確的次數：`ReplayEvent` **從不落地**（只活在 App.tsx 的
 * useState，冷啟動就歸零），`Capture` 也沒有計數欄位——唯一持久化的來歷就是
 * `strength` 這一個字。硬寫「你重聽了 3 次」等於編造，而這個 app 的整個論點
 * 就是「這些數字是真的」，第一個假數字出現在這裡最傷。
 *
 * 所以 weak 給確定的 1（引擎把 3 秒內連續往回找段落的那串倒帶算**同一個**訊號，
 * 不加碼也不升級），strong 只講它憑什麼是 strong、不猜次數。
 * TODO(下一輪)：`Capture` 加 `replay_count` + migration 007，這裡就能回真實次數。
 */
function signalOrigin(capture: Capture): string {
  switch (capture.strength) {
    case 'selected':
      // ⚠️ 'selected' 有**兩種**來歷，strength 一個欄位分不出來。segmentation 的
      // 前提正好是「他指不出是哪幾個字」，照印「親手圈出了聽不懂的字」等於在卡片
      // 上宣稱一個他剛剛才明說自己做不到的動作——而且下面幾行就印著他真正說的
      // 那句話（「你說這裡切不出有幾個字」），一張卡自己打自己。
      return capture.selection_kind === 'segmentation'
        ? '你在這裡重聽之後，指著這一句說「我聽不出這裡有幾個字」'
        : '你在這裡重聽之後，親手圈出了聽不懂的字';
    case 'strong':
      return '你在這裡重聽了 2 次以上，或重聽後放慢／打開了逐字稿';
    case 'weak':
      return '你在這裡重聽了 1 次';
    case 'saved':
      // 明講「沒有重聽紀錄」，因為這張卡與其他三種的來歷是質的不同，
      // 而含糊其辭會讓它讀起來像一次比較弱的重聽。
      return '你在逐字稿裡點了這個詞，說想學它——這裡沒有重聽紀錄';
    default: {
      // 窮盡檢查。原本的 `default:` 是全 app 唯一會產出**假陳述**的洞：新增一級
      // 就靜靜掉進「你在這裡重聽了 1 次」，在卡片上印一次從沒發生的倒帶。
      // 有 default 的 switch TypeScript 不會抱怨，所以改成 never 讓下一級在
      // 編譯期就爆掉。
      const never: never = capture.strength;
      return never;
    }
  }
}

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.floor(totalSeconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

/**
 * ADR-0011 的一天上限：五張強訊號 ≈ 十分鐘。
 *
 * ⚠️ 這裡只借它的**格數**，沒有實作上限本身（真正的 N=5 分流與完成判定要同時動
 * `lib/types.ts` 與 App.tsx 的 badge 孿生邏輯，那是別人的檔案）。所以佇列超過五張
 * 時進度條不會說謊：五格右邊直接標出溢出的張數，旁邊那行「第 N / M 張」仍是全貌。
 */
const SESSION_SEGMENTS = 5;

/** 分段進度條。一格 = 一張卡，比一條連續的長條更容易一眼數出「還剩幾張」。 */
function SessionProgress({ done, total }: { done: number; total: number }) {
  const cells = Math.min(Math.max(total, 1), SESSION_SEGMENTS);
  const overflow = Math.max(0, total - SESSION_SEGMENTS);
  return (
    <View style={styles.progressRow}>
      {Array.from({ length: cells }, (_, i) => (
        <View
          key={i}
          style={[
            styles.progressCell,
            // 同色相三段濃度（RAMP）：走過的、正在走的、還沒走的講的是同一件事
            // 走到多遠，換色相會讓它讀起來像三種不同的東西。
            i < done
              ? styles.progressCellDone
              : i === done
                ? styles.progressCellNow
                : null,
          ]}
        />
      ))}
      {overflow > 0 && <Text style={styles.progressOverflow}>+{overflow}</Text>}
    </View>
  );
}

/** 骨架每個字元約佔的寬度（focusText 17px 的經驗值）。 */
const MASK_CHAR_W = 7.5;
/** 骨架最多排幾個字：再長就把卡片推到整頁都是灰條，反而看不出句子的形狀。 */
const MAX_MASK_WORDS = 44;

/**
 * 遮住的句子。**遮罩帶著原句的形狀**——每個字一根依真實字長的橫條。
 *
 * 這是「六張卡不會長得一模一樣」的來源：學習者看得到句子有多長、哪個字特別長、
 * 節奏是什麼，卻讀不到內容。均勻的一整塊灰底做不到這件事，而形狀正好是聽力
 * 重建句子時真正用得上的線索。
 */
function MaskedSentence({ text, stage }: { text: string; stage: 'shape' | 'hint' }) {
  const words = useMemo(
    () => text.split(/\s+/).filter(Boolean).slice(0, MAX_MASK_WORDS),
    [text],
  );
  if (stage === 'hint') {
    // 首字母 + 點：字數、字長、開頭都給了，剩下的仍要自己補——這一級的用途是
    // 「我快想起來了」，不是「告訴我答案」。
    return (
      <Text style={styles.hintText}>
        {words
          .map((w) => w.charAt(0) + '·'.repeat(Math.max(0, w.length - 1)))
          .join(' ')}
      </Text>
    );
  }
  return (
    <View style={styles.maskRow}>
      {words.map((w, i) => (
        <View
          key={i}
          style={[styles.maskWord, { width: Math.min(w.length, 14) * MASK_CHAR_W + SP(2) }]}
        />
      ))}
    </View>
  );
}

/**
 * 這次 app 存活期間，已經為了補出題欄位重新診斷過的 capture id。
 *
 * 存在的理由：一筆診斷寫下去就是終局——`onReveal` 看到 `diagnosis` 就直接 return，
 * 全 app 沒有第二個 `diagnoseCapture` 呼叫點。所以在 Edge Function 開始生成
 * `gloss_zh` / `distractors_zh` 之前寫下的那些**舊格式**診斷，永遠等不到那兩欄，
 * 那張卡就永遠出不了題。而且補不了：整個 app 對 `captures` 只有 upsert、沒有任何
 * `.select(`，在 Postgres 端 backfill 完全到不了裝置，下一次本機 upsert 還會把
 * backfill 的那列蓋回去。唯一走得通的路是**在裝置上重跑一次診斷**。
 *
 * 用 module-level Set 而不是 store：這是「這次 app 啟動期間試過了」的暫時狀態，
 * 不值得多一個 AsyncStorage key。它的職責只有一個——擋住無限重試：模型這次也可能
 * 回一筆沒有 gloss 的診斷（非 vocab、或品質不夠被 server 擋下），沒有這個 Set，
 * 同一張卡每次揭露都會再花一次 API 呼叫。
 */
const reDiagnosed = new Set<string>();

/**
 * 這張卡要不要（重新）診斷。
 *   - 沒有 diagnosis：本來就要診斷。
 *   - 有 diagnosis 但 type 是 vocab 卻缺 `gloss_zh`：舊格式，值得補一次。
 *   - 有 diagnosis 且不是 vocab：**不重試**。出題本來就只做 vocab
 *     （`functions/diagnose/index.ts` 的 `pickQuizFields`），重試只是白花錢。
 */
function needsDiagnosis(capture: Capture): boolean {
  const d = capture.diagnosis;
  if (!d) return true;
  if (d.type !== 'vocab' || d.gloss_zh) return false;
  return !reDiagnosed.has(capture.id);
}

/** Restore the app-wide playback audio mode (recording off). */
function restorePlaybackMode(): Promise<void> {
  return setAudioModeAsync({
    playsInSilentMode: true,
    interruptionMode: 'doNotMix',
    shouldPlayInBackground: true,
    allowsRecording: false,
  });
}

export default function PracticeScreen() {
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [step, setStep] = useState<'confirm' | 'practice'>('confirm');
  const [fresh, setFresh] = useState<QueueItem[]>([]); // 今天剛抓的 pending（搶先練）
  const [freshExpanded, setFreshExpanded] = useState(false);

  // Session stats
  const [practicedStrong, setPracticedStrong] = useState(0);
  const [practicedWeak, setPracticedWeak] = useState(0);
  // 第三格：他標記想學的詞。獨立計數是因為前兩格都在講**倒帶**（見 signalBucket），
  // 而這一格背後一次倒帶都沒有。
  const [practicedSaved, setPracticedSaved] = useState(0);
  const [dismissed, setDismissed] = useState(0);
  const sessionStartRef = useRef(Date.now());
  const recordedSessionRef = useRef(false);

  // Per-card state
  const [transcript, setTranscript] = useState<TranscriptPhase>({
    phase: 'none',
  });
  const [reveal, setReveal] = useState<RevealStage>('clue');
  const [diagnosing, setDiagnosing] = useState(false);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [stopAt, setStopAt] = useState<number | null>(null);
  /** Mirror 素材（① 分塊／② 慢速）。查不到 → 整個階梯區塊不顯示。 */
  const [mirror, setMirror] = useState<MirrorState>({ status: 'idle' });
  /** Mirror 是完整短檔（沒有 stopAt），大圓鍵的播放/停止狀態要另外記。 */
  const [mirrorPlaying, setMirrorPlaying] = useState(false);
  /** 他自己的 noticing 答案。null = 還沒回答 → 診斷卡按住不放。 */
  const [noticed, setNoticed] = useState<NoticeAnswer | null>(null);
  /** noticing 面板裡被點亮的 token index（保持連續的一段）。 */
  const [noticeTokens, setNoticeTokens] = useState<number[]>([]);

  // Re-render on any store change so we always show live capture data
  // (diagnosis written back async, strength upgrades, ...).
  const [, setStoreVersion] = useState(0);
  useEffect(() => subscribe(() => setStoreVersion((v) => v + 1)), []);

  // Dedicated practice player (separate from the main podcast player).
  const player = useAudioPlayer(null, { updateInterval: 250 });
  const playerStatus = useAudioPlayerStatus(player);
  const loadedSourceRef = useRef<string | null>(null);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);

  // Build the queue once（日切）: 正式佇列 = **昨天以前**的 pending（strong 排前）
  // + **昨天以前**確認過卻沒評分的孤兒卡 + 今日到期 SRS 複習；
  // 今天產生的（pending 與 confirmed 都算）獨立成 fresh（搶先練）。
  //
  // 孤兒卡也要過日切是 ADR-0011 的要求（同一天產生的 capture 屬於**不計入完成度**
  // 的搶先練層）。改版前這一桶只能靠「按了『真的沒聽懂』後中途離開」產生，一個
  // session 頂多一兩筆，混進今日正式佇列看不出來；框選（status 天生就是
  // 'confirmed'）把它變成可批量產生的主要路徑——通勤路上圈 12 個片語，今日正式
  // 佇列就是 12 張全流程練習卡，session 直接衝破十分鐘承諾，練到第 6 張放棄還會
  // 記成未完成。ADR-0011 寫下來就是為了防止「訊號最多的那天完成率最低」。
  //
  // ⚠️ 已知債（本輪不解）：strength 'saved' 讓這個量級再放大一個數量級。框選要
  // 長按拖曳選字，TermSheet 的「＋ 加入練習」只要**一次點擊**——一集點 20 個詞
  // 就是隔天 20 張全流程卡。本輪只靠 STRENGTH_RANK（saved = 3，排最後）讓它們沉
  // 到佇列尾，沒有實作上限：真正的 N=5 分流要同時動這裡與 App.tsx 的孿生 badge
  // 邏輯，單邊改會重演「徽章說有 3 張、點進去是空的」，那是獨立的一輪。
  //
  // ⚠️ App.tsx 的 computeBadge 是這套規則的孿生實作，但它的 orphanConfirmed 還沒有
  // 這道日切（那支檔案這一輪不屬於本代理）。在它補上之前，徽章會把今天框的字算成
  // 「待練」而這裡不會——數字仍對得上使用者在搶先練區塊看到的張數，但與「正式
  // 佇列」的定義有落差。下方空佇列畫面的標題已為此改寫。
  useEffect(() => {
    let cancelled = false;
    void initStore().then(() => {
      if (cancelled) return;
      const today = todayStr(); // 裝置當地日界線
      const byPriority = (a: Capture, b: Capture) => {
        const d = STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength];
        return d !== 0 ? d : a.created_at.localeCompare(b.created_at);
      };
      const allCaptures = getCaptures();
      const pendingAll = allCaptures.filter((c) => c.status === 'pending');
      // confirmed 且無對應 SRS item = 孤兒卡：mode 'new'、跳過 confirm 步
      // 直接 practice（見卡片切換 effect 的 setStep）。
      const srsIds = new Set(getSrsItems().map((i) => i.capture_id));
      const orphanConfirmed = allCaptures.filter(
        (c) => c.status === 'confirmed' && !srsIds.has(c.id),
      );
      // created_at 是 ISO(UTC)，new Date() 轉當地時區後取 YYYY-MM-DD。
      // 兩個判準刻意都寫死比較日字串而不是 `!isToday`：裝置時鐘偏快時會出現
      // 未來日期的 capture，讓它落在兩桶之外（原本的行為）比灌進今天的正式佇列安全。
      const carriedOver = (c: Capture) => toDateStr(new Date(c.created_at)) < today;
      const madeToday = (c: Capture) => toDateStr(new Date(c.created_at)) === today;
      const official = [
        ...pendingAll.filter(carriedOver),
        ...orphanConfirmed.filter(carriedOver),
      ].sort(byPriority);
      const freshToday = [
        ...pendingAll.filter(madeToday),
        ...orphanConfirmed.filter(madeToday),
      ].sort(byPriority);
      const pendingIds = new Set(pendingAll.map((c) => c.id)); // 排除「還在 pending」的所有 capture，避免重複入列
      const reviews = getSrsItems()
        .filter((i) => isDue(i) && !pendingIds.has(i.capture_id))
        .map((i) => getCapture(i.capture_id))
        .filter(
          (c): c is Capture =>
            Boolean(c) &&
            (c!.status === 'practiced' || c!.status === 'confirmed'),
        );
      setQueue([
        ...official.map((c) => ({ capture: c, mode: 'new' as const })),
        ...reviews.map((c) => ({ capture: c, mode: 'review' as const })),
      ]);
      setFresh(freshToday.map((c) => ({ capture: c, mode: 'new' as const })));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = queue && index < queue.length ? queue[index] : null;
  const liveCapture = current
    ? getCapture(current.capture.id) ?? current.capture
    : null;

  // Auto-stop playback at context_end.
  useEffect(() => {
    if (
      stopAt !== null &&
      playerStatus.playing &&
      (playerStatus.currentTime ?? 0) >= stopAt
    ) {
      player.pause();
      setStopAt(null);
    }
  }, [playerStatus.currentTime, playerStatus.playing, stopAt, player]);

  // Reset per-card state + kick off transcript loading when the card changes.
  useEffect(() => {
    // review 卡與孤兒 confirmed 卡都跳過 confirm 步。框選來的 capture 建立時
    // status 就是 'confirmed'（他親手圈字，等於已經回答過「真的沒聽懂嗎」），
    // 所以也走這條線——再問一次既是侮辱，也會讓 confirm rate 這個指標失去意義。
    //
    // 'saved' 同樣天生 confirmed，跳過也是對的：他根本沒有理解斷點，「這段是真的
    // 沒聽懂嗎」對他沒有意義。代價是它永遠不貢獻 confirm rate——那正好與上方
    // rewindWeakness 的白名單一致，兩者必須同時成立這個指標才自洽。
    setStep(
      current?.mode === 'review' || current?.capture.status === 'confirmed'
        ? 'practice'
        : 'confirm',
    );
    setReveal('clue');
    setDiagnosing(false);
    setRecordingUri(null);
    setRecordError(null);
    setStopAt(null);
    // 🔴 Mirror 與 noticing 的四個 state 一定要跟著換卡歸零。漏掉 `mirror` 最兇：
    // 上一張卡的 chunkedUrl/slowUrl 會留在畫面上，按下去播出一句「聽起來很合理
    // 但根本是別句」的音檔——沒有錯誤訊息、沒有紅字，是這個畫面上最難被發現的
    // 一種錯。`noticed` 殘留則會讓下一張卡的診斷卡在他還沒判斷前就展開，那正好
    // 是這一輪要消滅的錨定。
    setMirror({ status: 'idle' });
    setMirrorPlaying(false);
    setNoticed(null);
    setNoticeTokens([]);
    player.pause();

    if (!current) return;
    const ep = findEpisodeById(current.capture.episode_id);
    if (!ep) {
      setTranscript({ phase: 'none' });
      return;
    }
    if (!canTranscribe(ep)) {
      setTranscript({ phase: 'none' });
      return;
    }
    let cancelled = false;
    setTranscript({ phase: 'loading' });
    (async () => {
      await preloadTranscript(ep.id);
      const result = await ensureTranscript(ep);
      if (cancelled) return;
      if (!result) {
        setTranscript({ phase: 'none' });
        return;
      }
      if (result.status === 'failed') {
        setTranscript({ phase: 'failed', reason: result.reason });
        return;
      }
      const sentences = sentencesInWindow(
        ep.id,
        current.capture.window_start,
        current.capture.window_end,
      );
      setTranscript({ phase: 'ready', sentences });
      const text = sentences?.inWindow.map((s) => s.text).join(' ') ?? '';
      const live = getCapture(current.capture.id);
      if (text && live && !live.transcript_text) {
        updateCapture(current.capture.id, { transcript_text: text });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, queue]);

  /**
   * Mirror 素材查詢。**刻意是獨立的一支 effect，不塞進上面的逐字稿 effect。**
   *
   * 那支有兩個 early return（`!ep` / `!canTranscribe(ep)`），塞進去會被它們吃掉：
   * 有 vtt 但沒設 OpenAI key 的示範集正好走那條線，而那正是唯一可能有 Mirror
   * 素材的一集。而且逐字稿 effect 已經扛著網路轉錄，再多一個責任只是把風險面
   * 擴大。
   */
  useEffect(() => {
    setMirror({ status: 'idle' });
    const cap = current?.capture;
    if (!cap) return;
    // 白名單（不是 `!== 'weak'`）：只有 selected / saved 的 window 對齊 VTT cue
    // 邊界，離線預生成才算得出檔名。倒帶來的窗口是 T−15 的任意浮點、還會被合併
    // 收窄，永遠對不上——理由完整寫在 lib/mirrorAudio.ts 的檔頭。
    if (!MIRROR_ELIGIBLE_STRENGTHS.includes(cap.strength as never)) return;
    const ep = findEpisodeById(cap.episode_id);
    const paths = deriveMirrorPaths({
      transcriptUrl: ep?.transcriptUrl,
      windowStart: cap.window_start,
    });
    if (!paths) return; // 推不出路徑就當成沒有素材，連網路都不打
    let cancelled = false;
    setMirror({ status: 'checking' });
    void checkMirrorAssets(paths).then((r) => {
      if (cancelled) return;
      setMirror(
        r === 'ready'
          ? { status: 'ready', chunkedUrl: paths.chunkedUrl, slowUrl: paths.slowUrl }
          : { status: 'none' },
      );
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, queue]);

  // Record the daily session summary once everything is done.
  useEffect(() => {
    if (!queue || queue.length === 0 || index < queue.length) return;
    if (recordedSessionRef.current) return;
    recordedSessionRef.current = true;
    addPracticeRecord({
      date: todayStr(),
      // 「再來一次」會把同一張卡 push 回佇列尾 → 以去重後的卡數為準，
      // 避免 items_total 被 again 灌水。
      items_total: new Set(queue.map((q) => q.capture.id)).size,
      // 練了就是練了：saved 也算進完成度（streak 與 completion_rate 都吃這個欄位，
      // 只練 saved 的一天不該被記成沒練）。但它**不進 weak_count**——那一格的
      // 定義是「倒帶了一次」。
      items_completed: practicedStrong + practicedWeak + practicedSaved,
      strong_count: practicedStrong,
      weak_count: practicedWeak,
      saved_count: practicedSaved,
      dismissed_count: dismissed,
      created_at: new Date().toISOString(),
    });
    void syncDailyReminder(); // 練完立即刷新明早通知文案（此時 pending 通常歸零）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, queue]);

  const playSegment = async (rate: number) => {
    setMirrorPlaying(false); // 換來源就離開 Mirror 模式，大圓鍵的狀態才不會卡住
    if (!liveCapture) return;
    const ep = findEpisodeById(liveCapture.episode_id);
    if (!ep) return;
    try {
      if (loadedSourceRef.current !== ep.audioUrl) {
        player.replace({ uri: ep.audioUrl });
        loadedSourceRef.current = ep.audioUrl;
      }
      player.setPlaybackRate(rate, 'high');
      await player.seekTo(liveCapture.context_start);
      setStopAt(liveCapture.context_end);
      player.play();
    } catch (err) {
      console.warn('[practice] playSegment failed:', err);
    }
  };

  const stopPlayback = () => {
    setMirrorPlaying(false);
    player.pause();
    setStopAt(null);
  };

  /**
   * Mirror 的播放：照抄 `playRecording` 而不是 `playSegment`——素材是一個完整的
   * 短檔（就是那一句），所以從 0 播、播完就完，沒有 `stopAt` 要守。
   */
  const playMirror = async (url: string) => {
    if (!url) return;
    try {
      if (loadedSourceRef.current !== url) {
        player.replace({ uri: url });
        loadedSourceRef.current = url;
      }
      // 🔴 一定要明寫 1：setPlaybackRate 黏在 player 實例上、**不隨來源重設**。
      // 不寫就會繼承上一次的 0.7×，把離線生成的原生慢速再時間伸縮一次——正好是
      // 這條階梯存在的理由（MirrorState 檔頭）所要消滅的那種失真。
      player.setPlaybackRate(1, 'high');
      setStopAt(null);
      setMirrorPlaying(true);
      await player.seekTo(0);
      player.play();
    } catch (err) {
      console.warn('[practice] playMirror failed:', err);
      setMirrorPlaying(false);
    }
  };

  const startRecording = async () => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setRecordError('需要麥克風權限才能跟讀，請到系統設定開啟。');
        return;
      }
      setRecordError(null);
      stopPlayback();
      await setAudioModeAsync({
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
        allowsRecording: true,
      });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecordingUri(null);
    } catch (err) {
      console.warn('[practice] startRecording failed:', err);
      setRecordError('錄音啟動失敗，再試一次。');
      void restorePlaybackMode();
    }
  };

  const stopRecording = async () => {
    try {
      await recorder.stop();
      setRecordingUri(recorder.uri);
    } catch (err) {
      console.warn('[practice] stopRecording failed:', err);
    } finally {
      void restorePlaybackMode();
    }
  };

  const playRecording = async () => {
    setMirrorPlaying(false);
    if (!recordingUri) return;
    try {
      if (loadedSourceRef.current !== recordingUri) {
        player.replace({ uri: recordingUri });
        loadedSourceRef.current = recordingUri;
      }
      player.setPlaybackRate(1, 'high');
      setStopAt(null);
      await player.seekTo(0);
      player.play();
    } catch (err) {
      console.warn('[practice] playRecording failed:', err);
    }
  };

  const advance = () => {
    stopPlayback();
    setIndex((i) => i + 1);
  };

  const onConfirm = () => {
    if (!liveCapture) return;
    updateCapture(liveCapture.id, { status: 'confirmed' });
    setStep('practice');
  };

  const onDismiss = () => {
    if (!liveCapture) return;
    // Dismissals are logged too — free labeled noise data (§3).
    updateCapture(liveCapture.id, { status: 'dismissed' });
    setDismissed((n) => n + 1);
    advance();
  };

  /** 全文揭露 = 診斷的觸發點：答案不該比題目早出現。 */
  const onReveal = () => {
    setReveal('full');
    if (!liveCapture || !needsDiagnosis(liveCapture) || !isDiagnosisConfigured()) {
      return;
    }
    if (transcript.phase !== 'ready' || !transcript.sentences) return;
    const sentence = transcript.sentences.inWindow
      .map((s) => s.text)
      .join(' ');
    if (!sentence) return;
    const context = [
      transcript.sentences.before?.text,
      transcript.sentences.after?.text,
    ]
      .filter(Boolean)
      .join(' … ');
    setDiagnosing(true);
    // 補診斷一張卡最多試一次（見 `reDiagnosed`）。**在發出請求時就記**，不是在
    // 回來之後——失敗也算試過，否則失敗會變成每次揭露都重打一次。
    reDiagnosed.add(liveCapture.id);
    const hadDiagnosis = Boolean(liveCapture.diagnosis);
    // 'saved' 的卡也照樣診斷（那是他要的學習內容），但寫回的 diagnosis **不會**
    // 回頭影響標註：`lib/annotate.ts:weakTypesFromCaptures` 已加上 strength
    // 白名單擋掉 saved。否則「app 標的詞 → 他收藏 → 影響 app 之後標什麼」會閉環
    // 成模型餵自己，正是 annotate.ts 檔頭禁止的推測→證據方向。
    void diagnoseCapture({ sentence, context }).then((d) => {
      setDiagnosing(false);
      if (!d) return;
      // 已經有診斷時，**只有真的補到出題欄位才覆寫**。同一句話每次診斷挑的
      // focus_phrase 都可能不同（實測：同一句先後給出 "pharmacology, pharmacologic
      // substance" 與 "spike adrenaline"），拿一筆一樣出不了題的新診斷去換掉他
      // 已經讀過的那一筆，只是把畫面上的內容換掉、什麼也沒換到。
      if (hadDiagnosis && !d.gloss_zh) return;
      updateCapture(liveCapture.id, { diagnosis: d });
    });
  };

  /**
   * noticing 面板的 token 點選。**只允許一段連續的字**，因為聽力的斷點是連續的
   * 一段聲音；准他東點一個西點一個，收到的是「這幾個字我都不太熟」，那與
   * 「我卡在這裡」不是同一件事。
   *
   * 規則：空 → 只選它；與現有區間相鄰 → 併入；正好是區間端點 → 收回一格
   * （這就是「取消」）；其餘 → 重設成只選它（跳著點＝改變主意，不是擴張）。
   */
  const toggleNoticeToken = (i: number) => {
    setNoticeTokens((prev) => {
      if (prev.length === 0) return [i];
      const min = prev[0];
      const max = prev[prev.length - 1];
      if (i === min - 1) return [i, ...prev];
      if (i === max + 1) return [...prev, i];
      if (i === min) return prev.slice(1);
      if (i === max) return prev.slice(0, -1);
      return [i];
    });
  };

  const onGrade = (grade: SrsGrade) => {
    if (!liveCapture || !current) return;
    const item = getSrsItem(liveCapture.id) ?? newSrsItem(liveCapture.id);
    upsertSrsItem(gradeSrsItem(item, grade));
    updateCapture(liveCapture.id, { status: 'practiced' });
    if (grade === 'again') {
      // 今天再來：把這張卡排回今天佇列的最後。
      setQueue((q) =>
        q ? [...q, { capture: liveCapture, mode: 'review' }] : q,
      );
    } else {
      // 分三格，不是「強訊號 ? A : B」。'selected' 進強訊號那一格（它是最強的
      // 一級，掉進 weak 會把「他親手圈出來的難點」記成一次可能的分心）；'saved'
      // 自成一格（它連一次倒帶都沒有，記進弱訊號就是在完成畫面上捏造倒帶）。
      const bucket = signalBucket(liveCapture.strength);
      if (bucket === 'strong') setPracticedStrong((n) => n + 1);
      else if (bucket === 'weak') setPracticedWeak((n) => n + 1);
      else setPracticedSaved((n) => n + 1);
    }
    advance();
  };

  // 搶先練（founder dogfood）：整批替換 queue，讓第二筆 practice record
  // 的 items_total / 耗時乾淨；只會從空佇列或完成畫面觸發。
  const startFresh = () => {
    if (fresh.length === 0) return;
    setQueue(fresh);
    setIndex(0);
    setPracticedStrong(0);
    setPracticedWeak(0);
    setPracticedSaved(0);
    setDismissed(0);
    recordedSessionRef.current = false; // 搶先練結束時再記一筆當日 record（streak 計算已對同日多筆去重）
    sessionStartRef.current = Date.now();
    setFresh([]);
    setFreshExpanded(false);
  };

  // Streak + 弱點統計（storeVersion 訂閱保證任何 store 變動後重算）。
  const streak = computeStreak(getPracticeLog());
  /**
   * 「累計捕捉 N 個難點」與難點分佈：**只算真的有理解斷點的三級**。
   *
   * 框選含在裡面是誠實的（他倒帶過、也指了位置），但 `saved` 不是難點——那是他
   * 在讀逐字稿時看上的一個詞。放進來會讓「累計捕捉」變成「累計收藏」，而這個
   * 數字正是拿去對外講「我們接住了多少真實斷點」的那一個。
   */
  const weakness = computeWeaknessStats(
    getCaptures().filter((c) => isDifficultySignal(c.strength)),
  );
  /**
   * 確認率**只能**用倒帶偵測出來的兩級算，所以要第二份統計。
   *
   * 不伴隨倒帶的來源天生 `status: 'confirmed'`（ADR-0017），進分母的同時也進分子：
   * 倒帶 10 次、滑掉 5、確認 5 = 50%，接著圈 20 個片語就變成 83%。畫面上寫的是
   * 「滑掉的是誤報」，宣稱的是**倒帶偵測有多準**，實際量到的卻是使用者有多常用
   * 那個功能。ADR-0017 的 Consequences 已經預告要分開統計，這裡就是那個分開。
   *
   * ⚠️ 上一輪這裡寫的是 `!== 'selected'`——黑名單。於是 `saved` 一加進 union 就
   * 原封不動漏了回來，而且比 'selected' 更嚴重：它連倒帶都沒有，卻會同時灌進
   * 分子與分母。改成白名單，下一級新來源預設被排除，要納入得有人明確寫上去。
   * 濾在呼叫端而不是改 `lib/stats.ts`：那支檔案這一輪不屬於本代理。
   */
  const rewindWeakness = computeWeaknessStats(
    getCaptures().filter((c) => isRewindSignal(c.strength)),
  );

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  const renderFreshBlock = () =>
    fresh.length > 0 ? (
      // 綠暈：搶先練整塊講的都是「學習者現在就要動手」。
      <Glass radius={R.lg} bloom="accent" style={styles.freshBox}>
        <Pressable style={styles.freshHeader} onPress={() => setFreshExpanded((v) => !v)}>
          <Text style={styles.freshTitle}>⚡ 搶先練（{fresh.length}）</Text>
          <Text style={styles.freshChevron}>{freshExpanded ? '▾' : '▸'}</Text>
        </Pressable>
        {freshExpanded && (
          <View style={styles.freshBody}>
            <Text style={styles.freshHint}>
              這些是今天剛抓到的難點。正式節奏是明天早上練（隔夜複習效果更好）；等不及也可以現在清。
            </Text>
            <Pressable
              onPress={startFresh}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            >
              <Text style={styles.primaryBtnText}>開始搶先練 {fresh.length} 張</Text>
            </Pressable>
          </View>
        )}
      </Glass>
    ) : null;

  const renderStatsCard = () =>
    weakness.totalCaptures > 0 ? (
      // 統計是陳述事實、不是誰在動手也不是誰在猜 → 沒有色暈可用，就不放。
      <Glass radius={R.lg} style={styles.statsBox}>
        <Text style={styles.statLine}>
          {weakness.topType ? (
            <>
              你的難點 <Text style={styles.statNum}>{weakness.topType.pct}%</Text> 是
              {DIAGNOSIS_LABELS_ZH[weakness.topType.type]}
            </>
          ) : (
            '累積更多診斷後，這裡會顯示你的難點分佈'
          )}
        </Text>
        <Text style={styles.statLine}>
          累計捕捉 <Text style={styles.statNum}>{weakness.totalCaptures}</Text> 個難點
        </Text>
        {rewindWeakness.confirmRate !== null && (
          <Text style={styles.statLine}>
            倒帶確認率{' '}
            <Text style={styles.statNum}>
              {Math.round(rewindWeakness.confirmRate * 100)}%
            </Text>
            {/* 括號裡要逐一點名排除了誰：這行字是這個數字唯一的定義，只寫
                「框選不計入」而漏掉標記想學，讀的人會以為分母是全部的 capture。 */}
            （滑掉的是誤報；框選與標記想學不計入）
          </Text>
        )}
      </Glass>
    ) : null;

  if (!queue) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={C.accent} />
        <Text style={styles.dimText}>載入練習佇列…</Text>
      </View>
    );
  }

  if (queue.length === 0) {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.centeredScroll}>
        <Text style={styles.bigEmoji}>🎧</Text>
        {/* 搶先練還有東西時不能說「沒有待練項目」：首頁徽章正把那幾張算成待練
            （見上方佇列建構的 ⚠️），兩句話會當場打架。 */}
        <Text style={styles.title}>
          {fresh.length > 0 ? '今天的正式練習已清空' : '目前沒有待練項目'}
        </Text>
        {streak > 0 && <Text style={styles.dimText}>🔥 連續練習 {streak} 天</Text>}
        {renderStatsCard()}
        {renderFreshBlock()}
        <Text style={styles.dimText}>
          去「播放器」聽 podcast，按 ↺15 —— 每一次重聽都會被接住，
          {'\n'}明天早上回來清掉它們。
        </Text>
      </ScrollView>
    );
  }

  if (!current || !liveCapture) {
    // Done screen
    const dueTomorrow = getSrsItems().filter((i) => isDueTomorrow(i)).length;
    const sessionMin = Math.max(
      1,
      Math.round((Date.now() - sessionStartRef.current) / 60000),
    );
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.centeredScroll}>
        <Text style={styles.bigEmoji}>✅</Text>
        <Text style={styles.title}>今日練習完成</Text>
        <Glass radius={R.lg} style={styles.statsBox}>
          {/* 括號裡三格分開列：前兩格是倒帶訊號的兩級，「標記想學」不是訊號，
              併進弱訊號會讓這行字宣稱一批沒發生過的倒帶。沒有就不列——0 那一格
              對他沒有意義，只會讓這行變長。 */}
          <Text style={styles.statLine}>
            練了{' '}
            <Text style={styles.statNum}>
              {practicedStrong + practicedWeak + practicedSaved}
            </Text>{' '}
            句（強訊號 {practicedStrong}・弱訊號 {practicedWeak}
            {practicedSaved > 0 ? `・標記想學 ${practicedSaved}` : ''}）
          </Text>
          <Text style={styles.statLine}>
            滑掉分心誤報 <Text style={styles.statNum}>{dismissed}</Text> 個
          </Text>
          <Text style={styles.statLine}>
            明日到期複習 <Text style={styles.statNum}>{dueTomorrow}</Text> 張
          </Text>
          <Text style={styles.statLine}>本次耗時約 {sessionMin} 分鐘</Text>
          <Text style={styles.statLine}>
            連續練習 <Text style={styles.statNum}>{streak}</Text> 天
          </Text>
        </Glass>
        {renderStatsCard()}
        {renderFreshBlock()}
        <Text style={styles.dimText}>繼續聽，明天見。</Text>
      </ScrollView>
    );
  }

  const episode = findEpisodeById(liveCapture.episode_id);
  // Mirror 是完整短檔、沒有 stopAt，所以大圓鍵的「正在播」要多認一個來源。
  // 刻意**不**把 playRecording 也納進來：那會改到既有行為（放自己的錄音時大圓鍵
  // 目前不變成停止鍵），是另一輪的事。
  const isPlaying = playerStatus.playing && (stopAt !== null || mirrorPlaying);
  const sentences = transcript.phase === 'ready' ? transcript.sentences : null;
  // 目標句：窗口內所有 segment 併成一句。空字串代表「窗口沒對到句子」，
  // 後面每個用到它的地方都先擋一次（RSS 來的時間戳偶爾對不上）。
  const focus = sentences?.inWindow.map((s) => s.text).join(' ').trim() ?? '';
  const clue = sentences?.before?.text.trim() ?? '';
  /** noticing 面板的可點 token。focus 已經 trim 過，所以不會切出空字串。 */
  const noticeWords = focus === '' ? [] : focus.split(/\s+/);
  /** Mirror 階梯只在 practice 步驟出現——① ② 洩漏詞界，等同提示。 */
  const mirrorLadder = mirror.status === 'ready' && step === 'practice';

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.scrollContent}
    >
      {/* Card header：分段進度條 + 徽章 */}
      <View style={styles.cardHeader}>
        <Text style={styles.progress}>
          第 {Math.min(index + 1, queue.length)} / {queue.length} 張
        </Text>
        <View style={styles.badges}>
          {streak > 0 && (
            <View style={[styles.chip, styles.chipNeutral]}>
              <Text style={styles.chipTextDim}>🔥 {streak} 天</Text>
            </View>
          )}
          {current.mode === 'review' && (
            <View style={[styles.chip, styles.chipNeutral]}>
              <Text style={styles.chipTextReview}>複習</Text>
            </View>
          )}
          <View
            style={[
              styles.chip,
              isStrongSignal(liveCapture.strength)
                ? styles.chipStrong
                : styles.chipNeutral,
            ]}
          >
            <Text
              style={
                isStrongSignal(liveCapture.strength)
                  ? styles.chipTextStrong
                  : styles.chipTextDim
              }
            >
              {strengthBadge(liveCapture)}
            </Text>
          </View>
        </View>
      </View>
      <SessionProgress done={Math.min(index, queue.length)} total={queue.length} />

      <Text style={styles.episodeTitle} numberOfLines={2}>
        {episode ? episode.title : '（未知單集）'}
      </Text>

      {/**
       * 這一句 —— 整張卡的主角。
       *
       * 句子 → 重聽鍵 → 來歷小標三者黏在同一塊玻璃上，中間不插區塊標題。原本重聽鍵
       * 被關在「重聽這段」這個標題底下、跟句子隔了一整個區塊，於是「看著這句、按一下、
       * 再聽一次」這個迴圈讀起來像兩件不相干的事。韓文打字練習 app 全部是這個排法：
       * 要練的那一行，喇叭就在它正下方。
       *
       * 兩個 step 都 render（65d8e9b 的修正，不要退回去）：confirm 步驟沒有聲音可聽
       * 就等於要人憑幾天前的記憶下判斷，實測 9 張被滑掉 7 張、confirm rate 0%。
       *
       * 綠暈：這塊面板從頭到尾講的都是「學習者動手了」——他重聽過、他等一下要再按。
       */}
      <Glass radius={R.xl} bloom="accent" bloomCorner="topRight" style={styles.sentenceCard}>
        {/* 全畫面唯一的一道漸層（每畫面最多一個）。兩端都是材質 token、不帶語意，
            只把「光是從上緣打進來的」這件事講出來，讓大面板不會平得像色塊。 */}
        <Gradient
          from={GLASS.fillStrong}
          to={GLASS.fill}
          bands={12}
          style={StyleSheet.absoluteFill}
        />

        <View style={styles.sentenceHead}>
          <Text style={styles.sectionTitle}>這一句</Text>
          <Text style={styles.windowText}>
            {formatTime(liveCapture.window_start)} – {formatTime(liveCapture.window_end)}
          </Text>
        </View>

        {transcript.phase === 'loading' && (
          <View style={styles.rowCenter}>
            <ActivityIndicator color={C.accent} size="small" />
            <Text style={styles.dimLine}>
              {'  '}轉錄中…（每集只轉一次，第一次要下載音檔）
            </Text>
          </View>
        )}
        {transcript.phase === 'failed' && (
          <Text style={styles.dimLine}>轉錄失敗：{transcript.reason}</Text>
        )}
        {transcript.phase === 'none' && (
          <Text style={styles.dimLine}>
            此集還沒有逐字稿（設定 OpenAI key 後自動補）——先用耳朵練，下面的重聽鍵一樣可以按。
          </Text>
        )}

        {transcript.phase === 'ready' && (
          <>
            {/* 線索：**前一句**。他已經聽懂的那一句才有支點的作用；
                後一句（sentences.after）留到全文揭露，先給等於先看結局。 */}
            {clue !== '' && (
              <View style={styles.clueWrap}>
                <Text style={styles.clueText} numberOfLines={3}>
                  {clue}
                </Text>
              </View>
            )}

            {focus === '' ? (
              <Text style={styles.dimLine}>（此窗口沒有對到句子）</Text>
            ) : reveal === 'full' ? (
              <Text style={styles.focusText}>{focus}</Text>
            ) : (
              <MaskedSentence text={focus} stage={reveal === 'hint' ? 'hint' : 'shape'} />
            )}

            {reveal === 'full' && sentences?.after && (
              <Text style={styles.clueText}>{sentences.after.text}</Text>
            )}
          </>
        )}

        {/**
         * 他自己指出來的東西。這是學習者給的答案、不是 app 的推測，所以不跟著
         * 遮罩走——遮的是「這句話是什麼」，而這幾個字是他早就講出口的。
         *
         * ⚠️ segmentation 例外：它的 selection_text 就是**整句**，照印等於在遮罩
         * 正下方把答案原文貼一次，clue/hint 兩級當場報廢。所以只印標籤——標籤
         * 本身已經把這張卡的來歷講完了（他說的是「這裡有幾個字我切不出來」，
         * 而不是某幾個字）。
         */}
        {liveCapture.selection_text ? (
          <View style={styles.selectionWrap}>
            <Text style={styles.selectionLabel}>
              {liveCapture.selection_kind === 'segmentation'
                ? '你說這裡切不出有幾個字'
                : liveCapture.strength === 'saved'
                  ? '你標記想學'
                  : '你圈的字'}
            </Text>
            {liveCapture.selection_kind !== 'segmentation' && (
              <Text style={styles.selectionText}>{liveCapture.selection_text}</Text>
            )}
          </View>
        ) : null}

        {/**
         * 重聽鍵：句子正下方。大的那顆是原速（綠＝學習者動手了，與播放器的
         * ↺15 同一個語意），慢速是次要選項，所以只是一顆玻璃膠囊。
         *
         * **Mirror 素材查不到時（今天必然如此）這一塊與改版前一個像素都不差**——
         * 那是這一輪的降級保證：階梯是加法，沒有素材就不存在，不顯示 disabled 的
         * 壞按鈕、也不顯示「素材載入失敗」（那是在跟他報告一件與他無關的事）。
         *
         * ③ 原音（大綠圓）兩個 step 都渲染、永遠可按（65d8e9b 的教訓：confirm 步驟
         * 抽掉聲音等於要人憑幾天前的記憶下判斷，實測 9 張滑掉 7 張、confirm rate 0%）。
         * ① ② 只在 practice 渲染：它們把句子切成塊、把邊界唸出來，等同提示，出現在
         * confirm 步驟就把聽力題變成閱讀題。
         */}
        <View style={styles.transport}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              isPlaying
                ? '停止重聽'
                : mirrorLadder
                  ? // 階梯的最後一級就是驗收，所以問句寫在這顆鍵上——既有的評分列
                    // 已經是三選一的量尺，再放一個問句面板就是兩把尺背靠背。
                    '原音重聽這一句 — 這次聽得出來嗎'
                  : '原速重聽這一句'
            }
            onPress={isPlaying ? stopPlayback : () => void playSegment(1)}
            style={({ pressed }) => [styles.playCircle, pressed && styles.pressed]}
          >
            {isPlaying ? (
              <PauseIcon size={18} color={C.accentInk} />
            ) : (
              <PlayIcon size={20} color={C.accentInk} />
            )}
          </Pressable>
          {mirrorLadder ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="分塊重聽：塊內原速、邊界停頓"
                onPress={() => void playMirror(mirror.chunkedUrl)}
                style={({ pressed }) => [styles.slowPill, pressed && styles.pressed]}
              >
                <PlayIcon size={11} color={C.text} />
                <Text style={styles.slowText}>① 分塊</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="原生慢速重聽"
                onPress={() => void playMirror(mirror.slowUrl)}
                style={({ pressed }) => [styles.slowPill, pressed && styles.pressed]}
              >
                <PlayIcon size={11} color={C.text} />
                <Text style={styles.slowText}>② 慢速</Text>
              </Pressable>
            </>
          ) : (
            // 沒有 Mirror 素材時 0.7× 是唯一的慢速，這條路徑不能刪。
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="慢速重聽這一句"
              onPress={() => void playSegment(0.7)}
              style={({ pressed }) => [styles.slowPill, pressed && styles.pressed]}
            >
              <PlayIcon size={11} color={C.text} />
              <Text style={styles.slowText}>0.7× 慢速</Text>
            </Pressable>
          )}
        </View>
        {/* 階梯的走法寫成一行字：三顆鍵擺在一起看不出先後，而先後正是它的教學價值。 */}
        {mirrorLadder && (
          <Text style={styles.ladderNote}>① 分塊 → ② 慢速 → ③ 原音（驗收）</Text>
        )}

        {/* 來歷：這張卡憑什麼在這裡。它不是系統排給你的功課，是你自己按出來的。 */}
        <View style={styles.originRow}>
          <Text style={styles.originMark}>↺</Text>
          <Text style={styles.originText}>{signalOrigin(liveCapture)}</Text>
        </View>

        {/* 揭露的下一級。confirm 步驟不給——先聽、先判斷，看了字就不是聽力題了。 */}
        {transcript.phase === 'ready' && focus !== '' && step === 'practice' && reveal !== 'full' && (
          <View style={styles.revealRow}>
            {reveal === 'clue' && (
              <Pressable
                onPress={() => setReveal('hint')}
                style={({ pressed }) => [styles.revealBtn, pressed && styles.pressed]}
              >
                <Text style={styles.revealBtnText}>再給一點提示</Text>
              </Pressable>
            )}
            <Pressable
              onPress={onReveal}
              style={({ pressed }) => [styles.revealBtn, pressed && styles.pressed]}
            >
              <Text style={styles.revealBtnText}>看逐字稿</Text>
            </Pressable>
          </View>
        )}
        {transcript.phase === 'ready' && focus !== '' && step === 'confirm' && (
          <Text style={styles.maskNote}>逐字稿在你回答下面那題之後才會開。</Text>
        )}
      </Glass>

      {step === 'confirm' ? (
        /* Step b — 確認（雜訊過濾＝第二次曝光；先聽過再判斷）。
           沒有色暈：這一步他還沒動手，只是被問。 */
        <Glass radius={R.lg} style={styles.section}>
          <Text style={styles.confirmPrompt}>
            聽完再決定。{'\n'}是真的沒聽懂，還是只是分心？
          </Text>
          <Pressable
            onPress={onConfirm}
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.primaryBtnText}>這段是真的沒聽懂</Text>
          </Pressable>
          <Pressable
            onPress={onDismiss}
            style={({ pressed }) => [styles.ghostBtn, pressed && styles.pressed]}
          >
            <Text style={styles.ghostBtnText}>只是分心，滑掉</Text>
          </Pressable>
        </Glass>
      ) : (
        <>
          {/**
           * Step c-1 — noticing：**診斷卡之前先讓他自己講**。
           *
           * 為什麼要延後診斷：診斷先出現的話，後續每一個反應都被它錨定，量到的
           * 是「他同意 app 的猜測」而不是他自己的 noticing——而這個 app 唯一的
           * 資產就是「學習者自己指出來的斷點」，被自家的猜測污染等於自斷來源。
           *
           * ⚠️ 延後的是**顯示**，不是抓取：`onReveal` 照舊在揭露當下就發診斷請求，
           * 他思考的這幾秒剛好蓋掉 round trip。（靠 `diagnosing` 的非同步延遲當
           * 延後一定失效——複習卡與二次進入的卡 `diagnosis` 早就在 store 裡，會在
           * 按下「看逐字稿」的同一幀整張出現。所以閘門必須是 `noticed`。）
           *
           * 沒有色暈：這一步他還沒動手，只是被問——與 confirm 那塊同一個道理。
           */}
          {step === 'practice' && reveal === 'full' && focus !== '' && noticed === null && (
            <Glass radius={R.lg} style={styles.section}>
              <Text style={styles.sectionTitle}>你覺得卡在哪？</Text>
              <View style={styles.noticeTokens}>
                {noticeWords.map((w, i) => {
                  const on = noticeTokens.includes(i);
                  return (
                    <Pressable
                      key={i}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      onPress={() => toggleNoticeToken(i)}
                      style={({ pressed }) => [
                        styles.noticeToken,
                        // 綠底＝他親手指的（與逐字稿裡的框選同一個語意色）。
                        on && styles.noticeTokenOn,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.focusText}>{w}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.row}>
                <Pressable
                  disabled={noticeTokens.length === 0}
                  onPress={() =>
                    setNoticed({
                      kind: 'phrase',
                      text: noticeTokens.map((i) => noticeWords[i]).join(' '),
                    })
                  }
                  style={({ pressed }) => [
                    styles.actionBtn,
                    noticeTokens.length === 0 && styles.disabledBtn,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.actionBtnText}>就是這幾個字</Text>
                </Pressable>
                {/* 「切不出有幾個字」不是「不知道」：那是詞界切分失敗（Field 2003），
                    是這個產品獨有的那一格資料，所以給它自己的按鈕而不是併進跳過。 */}
                <Pressable
                  onPress={() => setNoticed({ kind: 'segmentation' })}
                  style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.actionBtnText}>我切不出這裡有幾個字</Text>
                </Pressable>
                <Pressable
                  onPress={() => setNoticed({ kind: 'skip' })}
                  style={({ pressed }) => [
                    styles.ghostBtn,
                    styles.noticeSkip,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.ghostBtnText}>跳過</Text>
                </Pressable>
              </View>
            </Glass>
          )}

          {/* Step c-2 — 診斷卡。琥珀＝**app 在猜**：這張卡從頭到尾是推測，
              原本它用綠框（accentDark）是語意違規——綠色只屬於學習者的動作。
              多的那道 `noticed !== null` 閘就是上面那段延後的實作。 */}
          {reveal === 'full' && noticed !== null && (
            <>
              {liveCapture.diagnosis ? (
                <Glass
                  radius={R.lg}
                  bloom="highlight"
                  edge={false}
                  style={styles.diagnosisCard}
                >
                  <View style={styles.rowWrap}>
                    <View style={[styles.chip, styles.chipDiag]}>
                      <Text style={styles.chipTextDiag}>
                        {DIAGNOSIS_LABELS_ZH[liveCapture.diagnosis.type]}
                      </Text>
                    </View>
                    <Text style={styles.diagFocus}>
                      {liveCapture.diagnosis.focus_phrase}
                    </Text>
                  </View>

                  {/**
                   * 對照列：**他先講的**擺上面，app 的判斷擺下面。
                   *
                   * 兩者不一致時寫「先信你圈的」不是客套：他圈的是他當下真的
                   * 卡住的地方，診斷只是一次沒有聽覺輸入的文字推測。這一格
                   * 不一致本身就是資料（CONTEXT.md：selection_kind vs
                   * DiagnosisType 的落差是資料不是錯誤）。
                   *
                   * `skip` 不顯示對照列——他沒給答案，硬比就是替他捏造一個。
                   */}
                  {noticed?.kind === 'phrase' && (
                    <View style={styles.noticeCompare}>
                      <Text style={styles.noticedText}>你圈的：{noticed.text}</Text>
                      <Text style={styles.diagFocus}>
                        我們判斷：{liveCapture.diagnosis.focus_phrase}
                      </Text>
                      {(() => {
                        const a = normalizeNotice(noticed.text);
                        const b = normalizeNotice(liveCapture.diagnosis.focus_phrase);
                        // 以詞為單位比（見 sameNoticeSpan）——裸的 includes 會把
                        // 「他點了 on」與「我們判斷 gonna」判成同一處。
                        const same = sameNoticeSpan(a, b);
                        return (
                          <Text style={same ? styles.compareSame : styles.compareDiff}>
                            {same ? '同一處' : '不同處——先信你圈的'}
                          </Text>
                        );
                      })()}
                    </View>
                  )}
                  {noticed?.kind === 'segmentation' && (
                    <View style={styles.noticeCompare}>
                      <Text style={styles.noticedText}>你說：這裡切不出有幾個字</Text>
                      <Text style={styles.diagFocus}>
                        我們判斷：{liveCapture.diagnosis.focus_phrase}
                      </Text>
                    </View>
                  )}

                  <Text style={styles.diagText}>
                    {liveCapture.diagnosis.explanation_zh}
                  </Text>
                  <Text style={styles.diagTip}>
                    💡 {liveCapture.diagnosis.practice_tip_zh}
                  </Text>
                </Glass>
              ) : diagnosing ? (
                <View style={[styles.rowCenter, styles.diagnosisPending]}>
                  <ActivityIndicator color={C.amber} size="small" />
                  <Text style={styles.dimLine}>{'  '}Claude 診斷中…</Text>
                </View>
              ) : !isDiagnosisConfigured() ? (
                <Text style={[styles.dimLine, styles.diagnosisPending]}>
                  （未設定 Anthropic key，略過難點診斷）
                </Text>
              ) : null}
            </>
          )}

          {/* Step d — 跟讀 */}
          <Glass radius={R.lg} style={styles.section}>
            <Text style={styles.sectionTitle}>跟讀</Text>
            {recordError && <Text style={styles.errorText}>{recordError}</Text>}
            <View style={styles.row}>
              {recorderState.isRecording ? (
                <Pressable
                  onPress={() => void stopRecording()}
                  style={({ pressed }) => [styles.recordBtnActive, pressed && styles.pressed]}
                >
                  <Text style={styles.recordBtnActiveText}>
                    ⏹ 停止（{Math.round((recorderState.durationMillis ?? 0) / 1000)}s）
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => void startRecording()}
                  style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.actionBtnText}>
                    {recordingUri ? '🎙 重錄' : '🎙 開始跟讀'}
                  </Text>
                </Pressable>
              )}
              {recordingUri && !recorderState.isRecording && (
                <Pressable
                  onPress={() => void playRecording()}
                  style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.actionBtnText}>▶ 我的錄音</Text>
                </Pressable>
              )}
              {recordingUri && !recorderState.isRecording && (
                <Pressable
                  onPress={() => void playSegment(1)}
                  style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.actionBtnText}>▶ 原音對照</Text>
                </Pressable>
              )}
            </View>
          </Glass>

          {/* Step e — 評分 */}
          <Glass radius={R.lg} style={styles.section}>
            <Text style={styles.sectionTitle}>這句的掌握度</Text>
            <View style={styles.row}>
              <Pressable
                onPress={() => onGrade('again')}
                style={({ pressed }) => [styles.gradeAgain, pressed && styles.pressed]}
              >
                <Text style={styles.gradeAgainText}>再來一次</Text>
              </Pressable>
              <Pressable
                onPress={() => onGrade('good')}
                style={({ pressed }) => [styles.gradeGood, pressed && styles.pressed]}
              >
                <Text style={styles.gradeGoodText}>記住了</Text>
              </Pressable>
              <Pressable
                onPress={() => onGrade('easy')}
                style={({ pressed }) => [styles.gradeEasy, pressed && styles.pressed]}
              >
                <Text style={styles.gradeEasyText}>太簡單</Text>
              </Pressable>
            </View>
          </Glass>
        </>
      )}
    </ScrollView>
  );
}

/**
 * 色票以 `lib/theme.ts` 為準。
 *
 * 這裡本來自己抄了一份色碼，於是同一個 app 有兩套設計系統——而且已經漂移：
 * theme.ts 早就把 `dim` 從 #8A97A8 調亮成 #9FACBC（為了跟 `faint` 拉開距離），
 * 這份副本沒跟上，所以練習頁的次要文字整頁比其他畫面暗一階。
 *
 * 只留 theme 沒有的語意色（此檔專屬），其餘一律取用共用 token。
 */
const C = {
  ...THEME,
  /**
   * 破壞性／最低評分／錄音中。紅色目前沒有全域語意（theme.ts 的三條規則裡沒有它），
   * 所以維持此檔專屬——要提升成全域 token 之前，得先講清楚它代表什麼。
   */
  danger: '#EF4444',
  /** 舊名保留：琥珀的字色（= app 在猜）。 */
  amber: THEME.highlightInk,
};

/*
 * 這次一併刪掉的兩個本地 key：`card`（= THEME.surface，區塊底色改由 <Glass> 提供，
 * 沒有任何地方再用實色卡片）與 `accentDark`（#14532D，原本是診斷卡的綠框——那正是
 * §「琥珀＝app 在猜」要修掉的語意違規，改成琥珀之後它就沒有用途了）。留著一個沒人
 * 用的寫死色碼，下一個人只會拿它當「反正這裡可以寫色碼」的先例。
 */

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: { paddingBottom: SP(8) },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SP(3),
    paddingHorizontal: SP(6),
  },
  centeredScroll: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SP(3),
    paddingHorizontal: SP(6),
    paddingVertical: SP(6),
  },
  bigEmoji: { fontSize: 44 },
  title: { ...TYPE.title, fontSize: 20, lineHeight: 26, color: C.text },
  dimText: { ...TYPE.caption, fontSize: 13, lineHeight: 20, color: C.dim, textAlign: 'center' },
  /** 玻璃上的次要文字。**不能用 C.faint**：它的對比是對 bg/surface 實算的，
   *  玻璃底下是「底色 × 半透明填色 × 可能還有色暈」，會掉到 AA 以下。 */
  dimLine: { ...TYPE.caption, fontSize: 13, lineHeight: 20, color: C.dim },
  errorText: { ...TYPE.caption, fontSize: 13, color: C.danger, marginBottom: SP(2) },

  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SP(4),
  },
  progress: { ...TYPE.caption, fontSize: 13, color: C.dim },
  badges: { flexDirection: 'row', gap: SP(1.5) },

  /** 分段進度條：一格一張卡。 */
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP(1.5),
    marginTop: SP(2.5),
  },
  progressCell: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    // 軌道是凹的，所以用暗色而不是白色（玻璃是凸的才用白）。
    backgroundColor: GLASS.well,
  },
  progressCellDone: { backgroundColor: RAMP.accentFull },
  progressCellNow: { backgroundColor: RAMP.accentMid },
  /** 超過 ADR-0011 的五格上限時，誠實標出還有幾張，不假裝一天只有五張。 */
  progressOverflow: { ...TYPE.mono, color: C.dim, marginLeft: SP(1) },

  chip: {
    borderRadius: R.pill,
    paddingHorizontal: SP(2.5),
    paddingVertical: SP(1),
  },
  chipStrong: { backgroundColor: C.accentSurface },
  chipNeutral: { backgroundColor: GLASS.fillStrong },
  chipDiag: { backgroundColor: C.highlight },
  chipTextStrong: { ...TYPE.caption, fontSize: 11, fontWeight: '700', color: C.accent },
  chipTextDim: { ...TYPE.caption, fontSize: 11, fontWeight: '700', color: C.dim },
  /** 藍字＝中性 chrome：「複習」是排程狀態，不是誰動手也不是誰在猜。 */
  chipTextReview: { ...TYPE.caption, fontSize: 11, fontWeight: '700', color: C.primary },
  chipTextDiag: { ...TYPE.caption, fontSize: 11, fontWeight: '700', color: C.amber },

  episodeTitle: { ...TYPE.heading, fontSize: 16, color: C.text, marginTop: SP(3) },

  /** 主角卡：句子 + 重聽鍵 + 來歷，三者不分家。 */
  sentenceCard: { marginTop: SP(3.5), padding: SP(4.5), gap: SP(3) },
  sentenceHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  windowText: { ...TYPE.mono, color: C.dim },

  /** 線索（前一句）：左邊一條 hairline 說明「這不是要練的那句」。 */
  clueWrap: {
    borderLeftWidth: 2,
    borderLeftColor: GLASS.edge,
    paddingLeft: SP(2.5),
  },
  clueText: { ...TYPE.caption, fontSize: 14, lineHeight: 21, fontWeight: '400', color: C.dim },

  /** 遮罩：每個字一根依真實字長的橫條，句子的形狀留著、內容拿掉。 */
  maskRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SP(1.5), paddingVertical: SP(1) },
  maskWord: { height: 14, borderRadius: 7, backgroundColor: GLASS.well },
  /** 首字母提示。letterSpacing 撐開，點才不會擠成一條線。 */
  hintText: { ...TYPE.body, fontSize: 17, letterSpacing: 1.5, color: C.dim },
  focusText: { ...TYPE.body, fontSize: 17, fontWeight: '600', color: C.text },
  maskNote: { ...TYPE.caption, color: C.dim },

  /** 他親手圈的字：綠色半透明底＝學習者動手了，與琥珀（app 在猜）永不同時出現。 */
  selectionWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: SP(2),
    backgroundColor: C.accentSurface,
    borderRadius: R.sm,
    paddingHorizontal: SP(2.5),
    paddingVertical: SP(1.5),
  },
  selectionLabel: { ...TYPE.caption, color: C.dim },
  selectionText: { ...TYPE.heading, fontSize: 16, color: C.text },

  /** 重聽鍵，句子正下方。 */
  transport: { flexDirection: 'row', alignItems: 'center', gap: SP(3) },
  playCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    // 實色綠：綠色按鈕維持實色，玻璃只用在容器層（accentInk 的 9.7:1 是對實色算的）。
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slowPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP(1.5),
    height: 40,
    paddingHorizontal: SP(3.5),
    borderRadius: R.pill,
    backgroundColor: GLASS.fillStrong,
    borderWidth: 1,
    borderColor: GLASS.edge,
  },
  slowText: { ...TYPE.caption, fontSize: 13, color: C.text },
  /** 階梯的走法。C.dim（不是 faint）：這行字壓在玻璃上。 */
  ladderNote: { ...TYPE.caption, color: C.dim },

  originRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SP(1.5) },
  originMark: { ...TYPE.caption, fontSize: 14, color: C.accent },
  originText: { ...TYPE.caption, flex: 1, lineHeight: 18, fontWeight: '400', color: C.dim },

  revealRow: { flexDirection: 'row', gap: SP(2.5) },
  revealBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: SP(3),
    borderRadius: R.md,
    backgroundColor: GLASS.fillStrong,
    borderWidth: 1,
    borderColor: GLASS.edge,
  },
  revealBtnText: { ...TYPE.caption, fontSize: 14, color: C.text },

  /** 一般區塊。底色／外框／圓角都由 <Glass> 提供，這裡只留排版。 */
  section: { padding: SP(3.5), marginTop: SP(3.5) },
  sectionTitle: {
    ...TYPE.caption,
    fontWeight: '800',
    letterSpacing: 1,
    color: C.dim,
    marginBottom: SP(2.5),
  },
  row: { flexDirection: 'row', gap: SP(2.5), flexWrap: 'wrap' },
  rowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP(2),
    flexWrap: 'wrap',
  },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },

  confirmPrompt: {
    ...TYPE.body,
    fontSize: 17,
    fontWeight: '600',
    color: C.text,
    marginBottom: SP(4),
  },
  primaryBtn: {
    backgroundColor: C.accent,
    borderRadius: R.md,
    paddingVertical: SP(4),
    alignItems: 'center',
    marginBottom: SP(2.5),
  },
  primaryBtnText: { ...TYPE.heading, fontSize: 16, fontWeight: '800', color: C.accentInk },
  ghostBtn: {
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: GLASS.edge,
    paddingVertical: SP(3.5),
    alignItems: 'center',
  },
  ghostBtnText: { ...TYPE.heading, fontSize: 15, fontWeight: '600', color: C.dim },

  actionBtn: {
    backgroundColor: GLASS.fillStrong,
    borderWidth: 1,
    borderColor: GLASS.edge,
    borderRadius: R.sm,
    paddingHorizontal: SP(4),
    paddingVertical: SP(3),
  },
  actionBtnText: { ...TYPE.heading, fontSize: 15, color: C.text },
  /** 沒選字時的「就是這幾個字」。只調透明度，不換顏色——換色會多出一個語意。 */
  disabledBtn: { opacity: 0.5 },

  /* --- noticing（診斷延後的那一步） -------------------------------------- */

  /** 可點的字。行距與 focusText 一致，點亮後不會把整段推開。 */
  noticeTokens: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SP(1),
    marginBottom: SP(3),
  },
  noticeToken: {
    borderRadius: R.sm,
    paddingHorizontal: SP(1.5),
    paddingVertical: SP(0.5),
  },
  /** 綠底＝他親手指的，與逐字稿裡的框選同一個語意色（絕不與琥珀同時出現）。 */
  noticeTokenOn: { backgroundColor: C.accentSurface },
  /** ghostBtn 在一列裡沒有橫向內距會擠成一條，只補排版、不動顏色。 */
  noticeSkip: { paddingHorizontal: SP(4) },

  /** 診斷卡裡的對照列。 */
  noticeCompare: { gap: SP(1.5) },
  /** 他圈的字：綠底行內色塊，alignSelf 讓底色只包住文字而不是整行。 */
  noticedText: {
    ...TYPE.heading,
    fontSize: 15,
    color: C.text,
    alignSelf: 'flex-start',
    backgroundColor: C.accentSurface,
    borderRadius: R.sm,
    paddingHorizontal: SP(2),
    paddingVertical: SP(1),
  },
  compareSame: { ...TYPE.caption, color: C.dim },
  /** 不同處＝這是 app 自己在講自己的判斷可能沒踩中 → 琥珀。 */
  compareDiff: { ...TYPE.caption, color: C.amber },

  diagnosisCard: { marginTop: SP(3.5), padding: SP(3), gap: SP(2), borderWidth: 1, borderColor: C.highlight },
  diagnosisPending: { marginTop: SP(3.5) },
  /** 診斷指出來的那個詞是 **app 的猜測** → 琥珀。原本是綠的（= 學習者動手了），
   *  那讓「證據」與「推測」在同一個畫面上長得一樣。 */
  diagFocus: { ...TYPE.heading, fontSize: 15, fontWeight: '800', color: C.amber },
  diagText: { ...TYPE.body, fontSize: 14, lineHeight: 21, color: C.text },
  diagTip: { ...TYPE.caption, fontSize: 13, lineHeight: 19, fontWeight: '400', color: C.dim },

  /** 錄音中：紅字 + 紅框，不用紅底——15px 粗體壓在 #EF4444 上只有 3.1:1。 */
  recordBtnActive: {
    backgroundColor: GLASS.fillStrong,
    borderWidth: 1,
    borderColor: C.danger,
    borderRadius: R.sm,
    paddingHorizontal: SP(4),
    paddingVertical: SP(3),
  },
  recordBtnActiveText: { ...TYPE.heading, fontSize: 15, color: C.danger },

  gradeAgain: {
    flex: 1,
    backgroundColor: GLASS.fillStrong,
    borderWidth: 1,
    borderColor: GLASS.edge,
    borderRadius: R.md,
    paddingVertical: SP(4),
    alignItems: 'center',
  },
  /** 唯一的實色綠：「記住了」是這一步的主要動作。 */
  gradeGood: {
    flex: 1,
    backgroundColor: C.accent,
    borderRadius: R.md,
    paddingVertical: SP(4),
    alignItems: 'center',
  },
  gradeEasy: {
    flex: 1,
    backgroundColor: GLASS.fillStrong,
    borderWidth: 1,
    borderColor: GLASS.edge,
    borderRadius: R.md,
    paddingVertical: SP(4),
    alignItems: 'center',
  },
  gradeAgainText: { ...TYPE.heading, fontSize: 15, fontWeight: '800', color: C.danger },
  gradeGoodText: { ...TYPE.heading, fontSize: 15, fontWeight: '800', color: C.accentInk },
  gradeEasyText: { ...TYPE.heading, fontSize: 15, fontWeight: '800', color: C.primary },

  statsBox: { padding: SP(4), gap: SP(2), alignSelf: 'stretch' },
  statLine: { ...TYPE.body, fontSize: 14, lineHeight: 21, color: C.text },
  statNum: { color: C.accent, fontWeight: '800' },

  freshBox: { alignSelf: 'stretch' },
  freshHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: SP(3.5),
  },
  freshTitle: { ...TYPE.heading, fontSize: 15, color: C.text },
  freshChevron: { ...TYPE.caption, fontSize: 14, color: C.dim },
  freshBody: { paddingHorizontal: SP(3.5), paddingBottom: SP(3.5), gap: SP(3) },
  freshHint: { ...TYPE.caption, fontSize: 13, lineHeight: 20, fontWeight: '400', color: C.dim },

  pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
});
