/**
 * PracticeScreen — 每日練習（mvp-spec.md P0「Daily session」）。
 *
 * Queue = 所有 pending captures（selected → strong → weak → saved）＋ 到期的 SRS
 * 複習項目。排序就是證據強度由強到弱：練不完時該先拿到的是他真的卡住的地方。
 * 每張卡的流程（signal-design.md §3：把雜訊過濾變成複習的第一步）：
 *   a. 重聽 context 窗口（1x / 0.7x，到 context_end 自動停）——**永遠可按**
 *   b. 確認：「真的沒聽懂」→ confirmed／「只是分心」→ dismissed（雜訊標註）
 *   c. 逐字稿**漸進式揭露**（線索 → 首字母 → 全文）＋ Claude 診斷卡（無 key 時降級）
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
    player.pause();
    setStopAt(null);
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
    if (!liveCapture || liveCapture.diagnosis || !isDiagnosisConfigured()) {
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
    // 'saved' 的卡也照樣診斷（那是他要的學習內容），但寫回的 diagnosis **不會**
    // 回頭影響標註：`lib/annotate.ts:weakTypesFromCaptures` 已加上 strength
    // 白名單擋掉 saved。否則「app 標的詞 → 他收藏 → 影響 app 之後標什麼」會閉環
    // 成模型餵自己，正是 annotate.ts 檔頭禁止的推測→證據方向。
    void diagnoseCapture({ sentence, context }).then((d) => {
      setDiagnosing(false);
      if (d) updateCapture(liveCapture.id, { diagnosis: d });
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
  const isPlaying = playerStatus.playing && stopAt !== null;
  const sentences = transcript.phase === 'ready' ? transcript.sentences : null;
  // 目標句：窗口內所有 segment 併成一句。空字串代表「窗口沒對到句子」，
  // 後面每個用到它的地方都先擋一次（RSS 來的時間戳偶爾對不上）。
  const focus = sentences?.inWindow.map((s) => s.text).join(' ').trim() ?? '';
  const clue = sentences?.before?.text.trim() ?? '';

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

        {/* 重聽鍵：句子正下方。大的那顆是原速（綠＝學習者動手了，與播放器的
            ↺15 同一個語意），慢速是次要選項，所以只是一顆玻璃膠囊。 */}
        <View style={styles.transport}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? '停止重聽' : '原速重聽這一句'}
            onPress={isPlaying ? stopPlayback : () => void playSegment(1)}
            style={({ pressed }) => [styles.playCircle, pressed && styles.pressed]}
          >
            {isPlaying ? (
              <PauseIcon size={18} color={C.accentInk} />
            ) : (
              <PlayIcon size={20} color={C.accentInk} />
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="慢速重聽這一句"
            onPress={() => void playSegment(0.7)}
            style={({ pressed }) => [styles.slowPill, pressed && styles.pressed]}
          >
            <PlayIcon size={11} color={C.text} />
            <Text style={styles.slowText}>0.7× 慢速</Text>
          </Pressable>
        </View>

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
          {/* Step c — 診斷卡。琥珀＝**app 在猜**：這張卡從頭到尾是推測，
              原本它用綠框（accentDark）是語意違規——綠色只屬於學習者的動作。 */}
          {reveal === 'full' && (
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
