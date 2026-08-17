/**
 * 全螢幕逐字稿閱讀器（Apple Podcasts 的 transcript 視圖）。
 *
 * 為什麼是**全螢幕**而不是播放器下面的一塊面板：面板版排在所有播放控制之後，在
 * iPhone 上只分得到約三成高度，一次看得到五、六行。跟播捲動在那種視窗裡看起來
 * 不像「跟著唸」，而像「清單在抖」。逐字稿是這個 app 的閱讀模式，它需要整個畫面。
 *
 * 「現在唸到哪一句」靠三件事同時表達，缺一都不夠明顯（ADR-0015，不准拿掉）：
 *   1. 字級（21 vs 18）    —— 掃視時第一眼就會落在最大的那行
 *   2. 亮度（text vs dim） —— 其餘句子退成背景
 *   3. 左側的藍色標記      —— 位置的絕對指標，就算兩行字級接近也認得出來
 * 藍色是 theme.ts 定義的「中性 chrome＝進度」，用在這裡語意正確：它表達的是
 * 播放位置，不是「你動手了」（綠）也不是「app 在猜」（琥珀）。
 *
 * 播放控制留在底部，所以看逐字稿時不必退回播放器就能 ↺15、暫停、拖進度。
 *
 * ── 框選模式（ADR-0017）────────────────────────────────────────────────────
 * 這個畫面有兩種互斥的觸控語意，一次只能有一種生效：
 *
 *   idle    點一句 = 跳到那一句（今天的行為，一個字都沒改）。
 *   選取中  點一句 = 把「可框選的那一列」移過去；點一個字 = 框起點／終點。
 *
 * 互斥是硬性的，不是偏好：同一下觸控若既可能跳播放位置又可能開始框選，使用者
 * 每次圈字都會賭到播放器亂跳，而「跳回去重聽」正好是這個 app 唯一在乎的訊號——
 * 亂記一筆比少記一筆更傷。
 *
 * 框選**不是重聽**：它不 seek、不 pause、不送 isRewind，因此也踩不到 App.tsx
 * 的外部倒帶推斷（ADR-0016）。底部 transport 的 ↺15 在兩種模式下都活著，所以
 * 框選也吃不掉重聽訊號。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  GestureResponderEvent,
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import Glass from './Glass';
import Gradient from './Gradient';
import { Chevron, PauseIcon, PlayIcon, SkipIcon } from './Glyph';
import SelectionSheet, { SelectionDraft } from './SelectionSheet';
import {
  ensureAnnotations,
  getTerms,
  isAnnotationConfigured,
  segmentKey,
  subscribeAnnotations,
  Term,
} from '../lib/annotate';
import { Episode } from '../lib/episodes';
import { commitSelection, sliceSelection, Token, tokenize } from '../lib/selection';
import { isSupabaseConfigured } from '../lib/supabase';
import {
  ensureWindowFor,
  getSegments,
  isCovered,
  preloadTranscript,
  windowFailure,
} from '../lib/transcript';
import { C, GLASS, R, SP, TYPE } from '../lib/theme';
import { SelectionKind, TranscriptSegment } from '../lib/types';
import { t, useLang } from '../lib/i18n';

/** 展開時驅動轉錄的節流間隔。ensureWindowFor 自己會去重，這裡只是不要每 250ms 敲一次。 */
const ENSURE_INTERVAL_MS = 3000;
/** 使用者停手多久才恢復自動跟隨。 */
const FOLLOW_RESUME_MS = 6000;
/** 目前這句停在畫面上方約 4 成：上面留剛講完的當上下文，下面留最多待讀空間。 */
const FOLLOW_VIEW_POSITION = 0.4;
/** scrollToIndex 失敗後、等 FlatList 量完那批列再重試的間隔。 */
const SCROLL_RETRY_MS = 240;
/**
 * 只標註聽到的位置附近（往回 1 分鐘、往前 5 分鐘）。
 *
 * 窗口化轉錄時這件事是自然成立的——一次只多 10 分鐘的句子。但有現成逐字稿的單集
 * 是**整集一次到齊**（295 句），全丟給 ensureAnnotations 會立刻排出約 8 個批次，
 * 而配額是 40 次/天且標註不寫磁碟：開五次 app 就用完，之後靜靜地不再標註。
 * 何況使用者在第 2 分鐘時，第 30 分鐘的難詞標了也沒人看。
 */
const ANNOTATE_BEHIND_SEC = 60;
const ANNOTATE_AHEAD_SEC = 300;

const BACK_SECONDS = 15;
const FORWARD_SECONDS = 30;

/** 「已加入今天的練習」那顆膠囊停留多久。夠久到看得見，短到不用手動關。 */
const CONFIRM_PILL_MS = 1800;

/**
 * 列表下緣淡出用的起點色：`C.bg` 的**全透明**版本（補 alpha=00）。
 *
 * 這不是新顏色，是同一個 token 的透明端點——所以它不需要在 theme.ts 宣告語意。
 * 刻意不寫 `'transparent'`：Gradient 會把看不懂的字串當成 rgba(0,0,0,0)，於是
 * 中段會內插出比底色更暗的一圈，在深底上看得出來。
 */
const BG_CLEAR = `${C.bg}00`;

/** 身分恆定的空陣列：沒被鎖定的列每次 render 都拿同一個參考，memo 才擋得住。 */
const EMPTY_TOKENS: Token[] = [];
const EMPTY_SPANS: [number, number][] = [];

interface Props {
  episode: Episode;
  positionSec: number;
  durationSec: number;
  playing: boolean;
  onClose: () => void;
  onSeek: (toSec: number, isRewind: boolean) => void;
  onOpenTerm: (term: Term) => void;
  onTogglePlay: () => void;
  onBack15: () => void;
  onForward30: () => void;
}

type RowState = 'current' | 'past' | 'future';

/** 一句話切成「純文字」與「被標註的 term」兩種片段。 */
interface Part {
  text: string;
  term?: Term;
}

// ---------------------------------------------------------------------------
// 純函式
// ---------------------------------------------------------------------------

/**
 * Whisper 每個 10 分鐘窗口的 segment id 都從 0 重新編號，跨窗口一定撞號；
 * transcript.ts 真正拿來去重的鍵是 `start`，所以列表 key 也用 start。
 */
const rowKey = (s: TranscriptSegment) => s.start.toFixed(2);

/** 最後一個 `start <= t` 的句子索引；沒有回 -1。一集上千句，用二分搜尋。 */
function indexAt(segments: TranscriptSegment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** 數字也算 word char，免得 "AI" 之類的 term 咬進 "AI2" 中間。 */
const isWordChar = (ch: string | undefined) =>
  ch !== undefined && /[A-Za-z0-9]/.test(ch);

/**
 * 第一個「不在更長單字裡面」的出現位置。大小寫敏感——伺服器保證 term 的
 * 大小寫與原文一致，放寬只會把 "US" 配到 "us" 上。
 */
function findWholeWord(text: string, needle: string): number {
  if (!needle) return -1;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return -1;
    const before = at > 0 ? text[at - 1] : undefined;
    const after =
      at + needle.length < text.length ? text[at + needle.length] : undefined;
    if (!isWordChar(before) && !isWordChar(after)) return at;
    from = at + 1;
  }
}

/** 依 term 出現位置把一句話切成片段；沒有任何命中回 null（省掉巢狀 Text）。 */
function splitByTerms(text: string, terms: Term[]): Part[] | null {
  const hits: { start: number; end: number; term: Term }[] = [];
  for (const term of terms) {
    const at = findWholeWord(text, term.term);
    if (at >= 0) hits.push({ start: at, end: at + term.term.length, term });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.start - b.start);

  const parts: Part[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue; // 與前一個 term 重疊 → 先到先贏
    if (hit.start > cursor) parts.push({ text: text.slice(cursor, hit.start) });
    parts.push({ text: text.slice(hit.start, hit.end), term: hit.term });
    cursor = hit.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

/**
 * 整集的切詞結果，key = rowKey(segment)。只在 segments 或標註變動時重建一次，
 * 之後每個 row 直接拿現成的陣列——切詞若放在 renderItem 裡，捲動時每一格都要
 * 重跑一次字串搜尋。
 *
 * 查表用 `segmentKey` 而不是 `segment.id`：撞號會讓第一個窗口的 term 掛到第二個
 * 窗口的句子上（splitByTerms 只擋得掉文字對不上的，剛好用字相同的仍會畫錯）。
 */
function buildHighlightIndex(
  segments: TranscriptSegment[],
  terms: Map<number, Term[]>,
): Map<string, Part[]> {
  const out = new Map<string, Part[]>();
  if (terms.size === 0) return out;
  for (const seg of segments) {
    const list = terms.get(segmentKey(seg));
    if (!list || list.length === 0) continue;
    const parts = splitByTerms(seg.text, list);
    if (parts) out.set(rowKey(seg), parts);
  }
  return out;
}

/**
 * 把 `splitByTerms` 的片段陣列還原成「term 在原文裡的 offset 區間」。
 *
 * 為什麼要還原而不是重算：`parts` 串起來**就是**原文，逐段累加長度即可拿到
 * offset；重跑一次 `findWholeWord` 不但多花錢，還可能跟 `splitByTerms` 的
 * 「重疊先到先贏」規則得出不同結果，畫面上就會出現兩套不一致的琥珀。
 *
 * 只有被鎖定、切成 token 的那一列需要這個——token 的邊界與 term 的邊界不一致
 * （term 可能是片語，也可能只是單字的一部分），要靠區間重疊來判斷。
 */
function termSpans(parts: Part[] | undefined): [number, number][] {
  if (!parts) return EMPTY_SPANS;
  const out: [number, number][] = [];
  let at = 0;
  for (const p of parts) {
    if (p.term) out.push([at, at + p.text.length]);
    at += p.text.length;
  }
  return out;
}

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.floor(totalSeconds);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

/**
 * 每一個欄位都是**純量或身分恆定的 handler**，一個物件／陣列都不准放。
 *
 * 選取範圍刻意拆成 `selFrom` / `selTo` 兩個數字而不是 `{from,to}`：物件每次
 * render 都是新身分，memo 會全數失效——點一個字就會讓畫面上所有掛載的列重畫。
 */
interface RowProps {
  segment: TranscriptSegment;
  parts: Part[] | undefined;
  state: RowState;
  /** 這一列是被鎖定、可框選的那一列（全份逐字稿同時最多一列為 true）。 */
  selectable: boolean;
  /** 選取模式的全域開關：true 時 term 不可按、琥珀底讓位給選取的綠底。 */
  selecting: boolean;
  /** 這一列的選取範圍（token index，含頭含尾）；沒有選取 = -1。 */
  selFrom: number;
  selTo: number;
  onPressRow: (segment: TranscriptSegment) => void;
  onLongPressRow: (segment: TranscriptSegment) => void;
  onPressToken: (tokenIndex: number) => void;
  onOpenTerm: (term: Term) => void;
}

const SegmentRow = memo(function SegmentRow({
  segment,
  parts,
  state,
  selectable,
  selecting,
  selFrom,
  selTo,
  onPressRow,
  onLongPressRow,
  onPressToken,
  onOpenTerm,
}: RowProps) {
  const current = state === 'current';

  /**
   * **只有被鎖定的那一列切 token。**
   *
   * 一句話切完約 22 個可按的巢狀 `<Text>`，而 RN 的 `Text` 只要 `isPressable`
   * 就得走一整套 pressability 設定；整份逐字稿都這樣切，等於把每一列的成本乘上
   * 二十倍。限制在一列之內，其餘所有列繼續走 `NativeVirtualText` 的免費路徑，
   * 於是「閱讀」這條路徑的成本與加這個功能之前完全相同。
   */
  const tokens = useMemo(
    () => (selectable ? tokenize(segment.text) : EMPTY_TOKENS),
    [selectable, segment.text],
  );
  const spans = useMemo(() => (selectable ? termSpans(parts) : EMPTY_SPANS), [selectable, parts]);

  const pressTerm = (e: GestureResponderEvent, term: Term) => {
    // 點 term 到此為止——否則同一下也會被外層 Pressable 當成「跳到這句」，
    // 使用者只想看解釋卻被拖回句首。
    e.stopPropagation();
    onOpenTerm(term);
  };

  return (
    <Pressable
      // 被鎖定的那一列把 onPress／onLongPress 交出去（給 undefined 而不是空函式：
      // 空函式仍會掛上 responder），觸控全歸底下的 token。
      onPress={selectable ? undefined : () => onPressRow(segment)}
      onLongPress={selectable ? undefined : () => onLongPressRow(segment)}
      style={({ pressed }) => [
        styles.row,
        selectable && styles.rowLocked,
        pressed && styles.rowPressed,
      ]}
    >
      {/* 位置標記：只有當前句畫得出來，其餘句子留同寬的空位，免得整段文字左右跳。 */}
      <View style={[styles.marker, current && styles.markerOn]} />
      <Text
        style={
          current ? styles.lineCurrent : state === 'past' ? styles.linePast : styles.lineFuture
        }
      >
        {selectable
          ? tokens.map((t, i) => {
              const picked = selFrom >= 0 && i >= selFrom && i <= selTo;
              // 用 word 的長度（不含尾隨空白）去比對：token 尾巴的空白若算進來，
              // 會誤咬到下一個字上的 term，多畫出一條底線。
              const flagged = spans.some(
                ([s, e]) => t.start < e && t.start + t.word.length > s,
              );
              return (
                <Text
                  key={i}
                  onPress={() => onPressToken(i)}
                  // suppressHighlighting：少了它，iOS 每點一個字都會閃一下系統灰底。
                  suppressHighlighting
                  // 明寫 role：`isPressable` 的 Text 若沒指定，RN 會自動塞 'link'，
                  // 一句 22 個 link 會讓 VoiceOver 把一個句子碎成 22 次滑動。
                  accessibilityRole="text"
                  style={
                    picked
                      ? flagged
                        ? styles.tokenPickedTerm
                        : styles.tokenPicked
                      : flagged
                        ? styles.termQuiet
                        : undefined
                  }
                >
                  {t.text}
                </Text>
              );
            })
          : parts
            ? parts.map((p, i) =>
                p.term ? (
                  <Text
                    key={i}
                    // 選取模式下琥珀從「底色」降級成「底線」，並且不可按：
                    // 背景這個通道整條讓給學習者親手圈出來的綠底（見 termQuiet）。
                    style={
                      selecting ? styles.termQuiet : current ? styles.termCurrent : styles.term
                    }
                    onPress={selecting ? undefined : (e) => pressTerm(e, p.term as Term)}
                    suppressHighlighting
                  >
                    {p.text}
                  </Text>
                ) : (
                  p.text
                ),
              )
            : segment.text}
      </Text>
    </Pressable>
  );
});

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function TranscriptScreen({
  episode,
  positionSec,
  durationSec,
  playing,
  onClose,
  onSeek,
  onOpenTerm,
  onTogglePlay,
  onBack15,
  onForward30,
}: Props) {
  // 訂閱語言：切換時重繪，好讓 t() 重新查表。
  useLang();
  const [segments, setSegments] = useState<TranscriptSegment[]>(() =>
    getSegments(episode.id),
  );
  const [annotationRev, setAnnotationRev] = useState(0);
  const [following, setFollowing] = useState(true);
  const [hydratedId, setHydratedId] = useState<string | null>(null);
  const [scrubSec, setScrubSec] = useState<number | null>(null);
  // 暫停時沒有 positionSec 的更新來觸發重繪，轉錄失敗訊息得自己敲一下。
  const [, forceRender] = useState(0);

  // --- 框選（四個純量，刻意不包成物件）-------------------------------------
  //
  // `selMode` 是第五個、也是規格之外的那一個：規格假設唯一入口是長按（於是
  // 「選取模式開著」等同於「有一列被鎖定」），但這一版在標題列右邊多了一顆
  // 「框選」開關，按下去時還沒有任何一列被鎖定，而 tap-to-seek 必須**在那一刻
  // 就停用**——否則使用者按了開關、以為進入選取，點下第一句卻跳了播放位置。
  const [selMode, setSelMode] = useState(false);
  /** 被鎖定、可框選的那一列（rowKey）。null = 還沒挑句子。 */
  const [selRow, setSelRow] = useState<string | null>(null);
  /** 起點 token index，-1 = 尚未點頭。 */
  const [selAnchor, setSelAnchor] = useState(-1);
  /** 終點 token index，-1 = 只點了頭。 */
  const [selFocus, setSelFocus] = useState(-1);
  const [draft, setDraft] = useState<SelectionDraft | null>(null);
  /**
   * 確認膠囊的**內容**，不只是開關。兩條送出路徑講的是不同的事（「加入練習」
   * vs「這一句我切不出詞」），共用一句話會讓 segmentation 讀起來像沒生效——
   * 使用者按下的是一顆從沒見過的按鈕，最需要的就是回饋確認他按對了。
   */
  const [confirmed, setConfirmed] = useState<string | null>(null);

  const listRef = useRef<FlatList<TranscriptSegment>>(null);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrolledRef = useRef(-1);

  // 選取的三個值同時存在 ref 裡：傳給 row 的 handler 必須身分恆定（deps 為空），
  // 所以它們讀不到 state 的最新值；而每一次點擊的決策都要看「現在點到頭了沒」。
  const selectingRef = useRef(false);
  const anchorRef = useRef(-1);
  const focusRef = useRef(-1);

  // props 都經 ref 轉一手，讓傳給 row 的 handler 身分恆定 —— 否則 onSeek /
  // onOpenTerm 每次 re-render 換身分，memo 過的 row 全部白做。
  const positionRef = useRef(positionSec);
  const seekRef = useRef(onSeek);
  const openTermRef = useRef(onOpenTerm);
  useEffect(() => {
    positionRef.current = positionSec;
    seekRef.current = onSeek;
    openTermRef.current = onOpenTerm;
  });

  // 換集：句子換一批、跟隨狀態重置，並先把磁碟快取讀回來。
  //
  // 順序是有成本的：`preloadTranscript` 在 transcript.ts 的 cache 已經有這一集
  // 時會直接跳過，而 `ensureWindowFor` 一被呼叫就會建出那筆（空的）記錄。所以
  // 若讓轉錄 effect 先跑，上一次已經存進磁碟的窗口會被當成沒轉錄過，每次冷啟動
  // 都要重付一次 Whisper 的錢——快取等於白做。
  useEffect(() => {
    let alive = true;
    setSegments(getSegments(episode.id));
    setFollowing(true);
    lastScrolledRef.current = -1;
    void preloadTranscript(episode.id).then(() => {
      if (!alive) return;
      setSegments(getSegments(episode.id));
      setHydratedId(episode.id); // 放行轉錄 effect
    });
    return () => {
      alive = false;
    };
  }, [episode.id]);

  useEffect(() => subscribeAnnotations(() => setAnnotationRev((v) => v + 1)), []);

  useEffect(
    () => () => {
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  // --- 驅動轉錄（這個畫面掛著就等於使用者在看）-----------------------------
  useEffect(() => {
    if (hydratedId !== episode.id) return;
    let alive = true;

    const run = () => {
      void ensureWindowFor(episode, positionRef.current)
        .then((res) => {
          if (!alive) return;
          // 新句子可能來自這次轉錄，也可能來自磁碟快取／現成全集稿——一律以
          // transcript.ts 目前手上的為準。同一個陣列參考時 React 會自行 bail out。
          const next = getSegments(episode.id);
          setSegments(next);
          // 渲染用全部，標註只送附近——理由見 ANNOTATE_AHEAD_SEC。
          const here = positionRef.current;
          const nearby = next.filter(
            (s) =>
              s.end >= here - ANNOTATE_BEHIND_SEC && s.start <= here + ANNOTATE_AHEAD_SEC,
          );
          if (nearby.length > 0) ensureAnnotations(episode.id, nearby);
          if (res?.status === 'failed') forceRender((v) => v + 1);
        })
        .catch(() => {
          // ensureWindowFor 內部已經把錯誤轉成 failedWindows，這裡只是防呆。
        });
    };

    run(); // 打開的當下就要一次，別讓使用者盯著空白等 3 秒
    const id = setInterval(run, ENSURE_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [episode, hydratedId]);

  // --- 位置 → 目前這句 -----------------------------------------------------
  const nearestIndex = useMemo(
    () => indexAt(segments, positionSec),
    [segments, positionSec],
  );
  // 嚴格落在 [start, end) 才算 current；句與句之間的停頓不該讓整列變亮。
  const activeIndex =
    nearestIndex >= 0 && positionSec < segments[nearestIndex].end ? nearestIndex : -1;

  const partsIndex = useMemo(
    () => buildHighlightIndex(segments, getTerms(episode.id)),
    // annotationRev 是標註到貨的訊號；getTerms 的回傳參考不保證穩定，不能當 dep。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [episode.id, segments, annotationRev],
  );

  // --- 自動捲動（隨時可被使用者奪回）---------------------------------------
  const scrollToRow = useCallback((index: number) => {
    listRef.current?.scrollToIndex({
      index,
      animated: true,
      viewPosition: FOLLOW_VIEW_POSITION,
    });
  }, []);

  useEffect(() => {
    if (!following) return;
    if (nearestIndex < 0 || nearestIndex >= segments.length) return;
    // 只有換行才捲：positionSec 每 250ms 就變，每次都捲會一直打斷動畫。
    if (nearestIndex === lastScrolledRef.current) return;
    lastScrolledRef.current = nearestIndex;
    scrollToRow(nearestIndex);
  }, [following, nearestIndex, segments.length, scrollToRow]);

  const armResume = useCallback(() => {
    // 選取進行中一律不復原跟播：播放推進會把畫面往上捲，第二次點擊就會點歪——
    // 而那兩次點擊之間隔多久，完全由使用者讀句子的速度決定。
    if (selectingRef.current) return;
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => setFollowing(true), FOLLOW_RESUME_MS);
  }, []);

  // 只有「真的在捲」才停止跟隨。以前綁在 onTouchStart 上，結果點一句跳轉也算
  // 動手，跟播會無謂地停 6 秒。
  const onUserGrab = useCallback(() => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    setFollowing(false);
  }, []);

  const resumeFollow = useCallback(() => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    lastScrolledRef.current = -1; // 強制立刻捲一次，不等下一句
    setFollowing(true);
  }, []);

  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      // 句子長短不一、又沒有誠實的 getItemLayout，目標列還沒被量到就會失敗。
      // 先用平均高度粗抓過去，等那批列量好再捲到正確位置。
      listRef.current?.scrollToOffset({
        offset: info.averageItemLength * info.index,
        animated: true,
      });
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => scrollToRow(info.index), SCROLL_RETRY_MS);
    },
    [scrollToRow],
  );

  // --- 框選的狀態機 ---------------------------------------------------------
  //
  //   idle      一般閱讀。點一句 = tap-to-seek。
  //   armed     選取模式開著，還沒點頭（可能連句子都還沒挑）。
  //   anchored  點了頭，範圍暫時只有那一個字。
  //   ranged    頭尾都有，中間全部高亮。
  //
  // 「anchored 就讓動作列出現」是刻意的：只圈一個字是最常見的情況（sheet 的
  // 第一個選項就叫「單字／片語」），若非得點兩個字才能送出，單字反而變成最難
  // 表達的東西。範圍在 selFocus < 0 時就是 [anchor, anchor]。

  /** 選取三值一起改。ref 與 state 同步寫：ref 給恆定 handler 讀，state 給畫面用。 */
  const applySelection = useCallback((anchor: number, focus: number) => {
    anchorRef.current = anchor;
    focusRef.current = focus;
    setSelAnchor(anchor);
    setSelFocus(focus);
  }, []);

  /** 回到 idle。不碰播放位置，也不自己恢復跟播（那由呼叫端決定時機）。 */
  const resetSelection = useCallback(() => {
    selectingRef.current = false;
    anchorRef.current = -1;
    focusRef.current = -1;
    setSelMode(false);
    setSelRow(null);
    setSelAnchor(-1);
    setSelFocus(-1);
  }, []);

  const exitSelection = useCallback(() => {
    resetSelection();
    armResume(); // 這時 selectingRef 已經是 false，計時器才排得下去
  }, [armResume, resetSelection]);

  /** 換集：token index 是對「那一句」的座標，換一集之後毫無意義，一律歸零。 */
  useEffect(() => {
    resetSelection();
    setDraft(null);
  }, [episode.id, resetSelection]);

  const enterSelection = useCallback((row: string | null) => {
    // 沿用 onUserGrab 的語意：使用者動手了就先停跟播，而且在選取結束前不復原。
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    selectingRef.current = true;
    anchorRef.current = -1;
    focusRef.current = -1;
    setFollowing(false);
    setSelMode(true);
    setSelRow(row);
    setSelAnchor(-1);
    setSelFocus(-1);
  }, []);

  const toggleSelectMode = useCallback(() => {
    if (selectingRef.current) exitSelection();
    else enterSelection(null); // 還沒挑句子，提示列會請他點一句
  }, [enterSelection, exitSelection]);

  // --- 點一句：selecting 決定它是「跳過去」還是「換一列來框」-----------------
  const handlePressRow = useCallback(
    (segment: TranscriptSegment) => {
      if (selectingRef.current) {
        // 選取模式下**絕不 seek**。跨句選取不支援（列與列之間有 paddingVertical
        // 的空隙，畫不出連續色塊；而且 capture 的窗口被定義成「那一句」的
        // start/end，跨句會讓那個窗口失去意義），所以點別的句子＝從那句重來。
        enterSelection(rowKey(segment));
        return;
      }
      // 1 秒寬容度讓「點目前這句」不會被誤記成重聽。positionRef 最多落後一個
      // render（250ms），而這個誤差只會讓我們少記、不會多記——訊號寧可漏不可假。
      seekRef.current(segment.start, segment.start < positionRef.current - 1);
      // 點完立刻恢復跟隨：使用者剛剛指定了要聽哪裡，畫面應該跟過去。
      resumeFollow();
    },
    [enterSelection, resumeFollow],
  );

  /** 長按是主要入口：不必先找開關，看到聽不懂的那一句直接壓住。 */
  const handleLongPressRow = useCallback(
    (segment: TranscriptSegment) => {
      enterSelection(rowKey(segment));
    },
    [enterSelection],
  );

  const handlePressToken = useCallback(
    (i: number) => {
      const anchor = anchorRef.current;
      const focus = focusRef.current;
      if (anchor < 0) {
        applySelection(i, -1); // armed → anchored
        return;
      }
      if (i === anchor) {
        // 點頭自己＝往回收一階：有範圍就收回只剩頭，只剩頭就整個取消。
        applySelection(focus < 0 ? -1 : anchor, -1);
        return;
      }
      // 點在頭前面也照收：兩次獨立的 tap 沒有天然的先後語意，範圍一律取
      // [min, max]（sliceSelection 本身也順序不拘）。
      applySelection(anchor, i);
    },
    [applySelection],
  );

  const handleOpenTerm = useCallback((term: Term) => {
    openTermRef.current(term);
  }, []);

  // --- 底部進度條（與播放器同一套拖曳語意）---------------------------------
  const barWidthRef = useRef(0);
  const durationRef = useRef(durationSec);
  const scrubStartRef = useRef(0);
  const commitScrubRef = useRef<(sec: number) => void>(() => {});

  const secAtX = (x: number) => {
    const w = barWidthRef.current;
    const d = durationRef.current;
    if (w <= 0 || d <= 0) return 0;
    return Math.max(0, Math.min(1, x / w)) * d;
  };

  const commitScrub = (target: number) => {
    setScrubSec(null);
    if (barWidthRef.current <= 0 || durationSec <= 0) return;
    // 往回拖與按 ↺15 是同一個領域事件，交給同一個 onSeek（ADR-0003）。
    onSeek(target, target < positionSec - 1);
  };

  useEffect(() => {
    durationRef.current = durationSec;
    commitScrubRef.current = commitScrub;
  });

  const scrubResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          scrubStartRef.current = e.nativeEvent.locationX;
          setScrubSec(secAtX(scrubStartRef.current));
        },
        onPanResponderMove: (_e, gesture) => {
          setScrubSec(secAtX(scrubStartRef.current + gesture.dx));
        },
        onPanResponderRelease: (_e, gesture) => {
          commitScrubRef.current(secAtX(scrubStartRef.current + gesture.dx));
        },
        onPanResponderTerminate: () => setScrubSec(null),
      }),
    // 只讀 ref，不需要（也不可以）重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onBarLayout = (e: LayoutChangeEvent) => {
    barWidthRef.current = e.nativeEvent.layout.width;
  };

  const displaySec = scrubSec ?? positionSec;
  const progress = durationSec > 0 ? Math.min(displaySec / durationSec, 1) : 0;

  // --- 框選的衍生值 ---------------------------------------------------------
  //
  // 用 rowKey 在 segments 裡找回那一句，而不是在鎖定時把物件存進 ref：轉錄窗口
  // 陸續到貨時 transcript.ts 會換掉整個陣列，存起來的舊物件可能已經被更準的
  // 版本取代。rowKey 是 `start.toFixed(2)`，跨批次仍指得回同一句。
  const selSegment = useMemo(
    () => (selRow === null ? null : (segments.find((s) => rowKey(s) === selRow) ?? null)),
    [segments, selRow],
  );
  // 這裡與 SegmentRow 各切一次同一句話。看起來重複，但那一份是 render 用的、
  // 這一份是 commit 與預覽用的，硬要共用就得把陣列當 prop 傳下去——而傳陣列
  // 正是 RowProps 全純量規則要擋掉的東西。一句話的切詞成本本來就接近零。
  const selTokens = useMemo(
    () => (selSegment ? tokenize(selSegment.text) : EMPTY_TOKENS),
    [selSegment],
  );
  const selLo = selAnchor < 0 ? -1 : selFocus < 0 ? selAnchor : Math.min(selAnchor, selFocus);
  const selHi = selAnchor < 0 ? -1 : selFocus < 0 ? selAnchor : Math.max(selAnchor, selFocus);
  const selText = useMemo(
    () => (selLo < 0 ? '' : sliceSelection(selTokens, selLo, selHi)),
    [selTokens, selLo, selHi],
  );

  const openSelectionSheet = () => {
    // 空字串直接放棄：寧可什麼都不發生，也不要建一筆沒有內容的 capture。
    if (!selSegment || selText === '') return;
    setDraft({ episodeId: episode.id, segment: selSegment, text: selText });
  };

  const handlePickKind = (kind: SelectionKind) => {
    const picked = draft;
    setDraft(null);
    if (!picked || picked.text === '') return;
    // 唯一的寫入點。commitSelection 不 seek、不 pause、不呼叫 ingestReplayEvent
    // ——框選是最強的訊號，但它不是一次重聽（lib/selection.ts 的三條禁令）。
    commitSelection({
      episodeId: picked.episodeId,
      segment: picked.segment,
      text: picked.text,
      kind,
      positionSec: positionRef.current,
      durationSec,
    });
    exitSelection();
    setConfirmed(t('ts.added_to_practice'));
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmed(null), CONFIRM_PILL_MS);
  };

  /**
   * 第三個出口：**詞界切分失敗**。
   *
   * 框選的預設是「使用者知道自己漏聽的是哪個詞」，但那正是聽力最常見的斷點之一
   * 不成立的地方（Field 2003）——他根本沒把那串聲音切成詞，自然框不出範圍。逼他
   * 框只會得到亂框或放棄，兩種都是把唯一有價值的資料丟掉。
   *
   * 所以這一顆**只要有 anchor 就能按**（他點得出「大概在這附近」就夠了），送出的
   * 是整句：斷點的位置本來就不在某個詞上。它仍然是 strength 'selected'——他倒帶、
   * 開了稿、親手指了位置，三個條件一個不少，差別只在指的範圍是一整句。
   *
   * **絕不經過 `openSelectionSheet` / `SelectionSheet`**：那張紙問的是「詞還是
   * 句型」，而這條路徑的整個前提就是他答不出來。
   */
  const handleSegmentation = () => {
    if (!selSegment) return;
    const whole = selSegment.text.trim();
    if (whole === '') return; // 空句直接放棄，寧可什麼都不發生
    commitSelection({
      episodeId: episode.id,
      segment: selSegment,
      text: whole,
      kind: 'segmentation',
      positionSec: positionRef.current,
      durationSec,
    });
    exitSelection();
    setConfirmed(t('ts.noted_segmentation'));
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmed(null), CONFIRM_PILL_MS);
  };

  const handleClose = () => {
    // 關閉前一定先清乾淨：選取狀態留在那裡，下次打開同一集會看到一列莫名其妙
    // 亮著、而使用者早忘了自己框過什麼。
    resetSelection();
    setDraft(null);
    onClose();
  };

  // --- 狀態訊息 ------------------------------------------------------------
  // 現成逐字稿免費且不需要後端，所以「有沒有得抓」不等於「有沒有 Supabase」。
  const canFetch = isSupabaseConfigured || Boolean(episode.transcriptUrl);
  const covered = isCovered(episode.id, positionSec);
  const failure = windowFailure(episode.id, positionSec);
  const status: string | null = covered
    ? null
    : failure // 伺服器已經寫成使用者看得懂的中文，原文照登
      ? failure
      : !canFetch
        ? t('ts.local_mode')
        : t('ts.transcribing');

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={handleClose}
          hitSlop={12}
          style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={t('ts.a11y_close')}
        >
          <Chevron direction="down" size={12} color={C.text} weight={2.5} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>{t('ts.title')}</Text>
          <Text style={styles.headerSub} numberOfLines={1}>
            {episode.title}
          </Text>
        </View>
        {/* 開著時是綠的：框選就是「學習者動手了」，這個色相是它憑語意賺到的。 */}
        <Pressable
          onPress={toggleSelectMode}
          hitSlop={10}
          style={({ pressed }) => [
            styles.selectBtn,
            selMode && styles.selectBtnOn,
            pressed && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityState={{ selected: selMode }}
          accessibilityLabel={selMode ? t('ts.a11y_select_on') : t('ts.a11y_select_off')}
        >
          <Text style={[styles.selectBtnText, selMode && styles.selectBtnTextOn]}>{t('ts.select')}</Text>
        </Pressable>
      </View>

      {status !== null && (
        <View style={styles.statusRow}>
          <Text style={styles.statusText}>{status}</Text>
        </View>
      )}
      {!isAnnotationConfigured() && (
        <View style={styles.statusRow}>
          <Text style={styles.statusText}>{t('ts.annotate_offline')}</Text>
        </View>
      )}

      {/* 逐字稿本體 */}
      <View style={styles.listWrap}>
        <FlatList
          ref={listRef}
          data={segments}
          keyExtractor={rowKey}
          // 選取狀態一定要進 extraData：點第二個字時，變的是**中間那些列**的
          // selFrom/selTo，而它們自己的 item 沒動，FlatList 不會主動重畫。
          extraData={`${activeIndex}|${selMode ? 1 : 0}|${selRow ?? ''}|${selAnchor}|${selFocus}`}
          onScrollToIndexFailed={onScrollToIndexFailed}
          onScrollBeginDrag={onUserGrab}
          onScrollEndDrag={armResume}
          onMomentumScrollEnd={armResume}
          initialNumToRender={12}
          // 選取模式下每一批的成本較高（被鎖定那列的 token、其餘列的樣式切換），
          // 把批次與窗口都調小，讓捲動時的掉格分攤掉。
          maxToRenderPerBatch={selMode ? 6 : 16}
          windowSize={selMode ? 7 : 11}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <Text style={styles.emptyText}>{status ?? t('ts.empty')}</Text>
          }
          renderItem={({ item, index }) => {
            const key = rowKey(item);
            const locked = selMode && key === selRow;
            return (
              <SegmentRow
                segment={item}
                parts={partsIndex.get(key)}
                state={
                  index === activeIndex ? 'current' : index <= nearestIndex ? 'past' : 'future'
                }
                selectable={locked}
                selecting={selMode}
                selFrom={locked ? selLo : -1}
                selTo={locked ? selHi : -1}
                onPressRow={handlePressRow}
                onLongPressRow={handleLongPressRow}
                onPressToken={handlePressToken}
                onOpenTerm={handleOpenTerm}
              />
            );
          }}
        />

        {/* 整個畫面唯一的一個 Gradient：讓最後幾行溶進 transport，而不是被切齊
            一刀。這是「還有東西在下面」最便宜的表達方式。 */}
        <Gradient from={BG_CLEAR} to={C.bg} bands={16} style={styles.listFade} />

        {selMode && selAnchor < 0 && (
          <View pointerEvents="none" style={styles.pillWrap}>
            <Glass weight="thick" radius={R.pill} style={styles.pill}>
              <Text style={styles.pillText}>
                {selRow === null ? t('ts.hint_pick_line') : t('ts.hint_pick_words')}
              </Text>
            </Glass>
          </View>
        )}

        {selMode && selAnchor >= 0 && selText !== '' && (
          <Glass
            weight="thick"
            bloom="accent"
            bloomCorner="topRight"
            elevated
            radius={R.lg}
            style={styles.actionBar}
          >
            {/* 上列＝「你圈到什麼」，下列＝「拿它做什麼」。兩個出口並排在同一列，
                是為了讓「我切不出詞」在他卡住的那一秒就與主按鈕同時被看見——
                收進選單或多一層 sheet，等於只有本來就知道自己漏聽哪個詞的人
                找得到它，而那正好是不需要這個出口的那群人。 */}
            <View style={styles.actionBody}>
              <View style={styles.actionRow}>
                <Text style={styles.actionPreview} numberOfLines={1}>
                  {selText}
                </Text>
                <Pressable
                  onPress={exitSelection}
                  hitSlop={8}
                  style={({ pressed }) => [styles.actionCancel, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={t('ts.a11y_cancel_select')}
                >
                  <Text style={styles.actionCancelText}>{t('ts.cancel')}</Text>
                </Pressable>
              </View>

              <View style={styles.actionRowExits}>
                <Pressable
                  onPress={handleSegmentation}
                  style={({ pressed }) => [styles.actionSeg, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={t('ts.a11y_cant_split')}
                >
                  <Text style={styles.actionSegText} numberOfLines={1}>
                    {t('ts.cant_split_btn')}
                  </Text>
                </Pressable>
                {/* 綠按鈕維持實色：accentInk 的 9.7:1 是對實色 accent 算的。 */}
                <Pressable
                  onPress={openSelectionSheet}
                  style={({ pressed }) => [styles.actionAdd, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={t('ts.a11y_add')}
                >
                  <Text style={styles.actionAddText}>{t('ts.add_btn')}</Text>
                </Pressable>
              </View>
            </View>
          </Glass>
        )}

        {confirmed && (
          <View pointerEvents="none" style={styles.pillWrap}>
            <View style={[styles.pill, styles.confirmPill]}>
              <Text style={styles.pillText}>{confirmed}</Text>
            </View>
          </View>
        )}

        {/* 選取中與剛送出時都不出現：它跟提示列／動作列／確認膠囊搶同一個位置，
            而那三者在當下都比「回到目前位置」重要。 */}
        {!following && !selMode && !confirmed && segments.length > 0 && (
          <Pressable
            onPress={resumeFollow}
            style={({ pressed }) => [styles.pillWrap, pressed && styles.pressed]}
          >
            <Glass weight="thick" radius={R.pill} style={styles.pill}>
              <Text style={styles.pillText}>{t('ts.back_to_position')}</Text>
            </Glass>
          </Pressable>
        )}
      </View>

      {/* 底部播放控制：看逐字稿時不必退回播放器。
          藍暈＝這塊面板在講「正在播放／進度」，是中性 chrome 賺到的色相；
          綠色只出現在 ↺15 那一顆鍵上（學習者動手了），不擴散到整塊面板。 */}
      <Glass
        weight="thick"
        bloom="primary"
        bloomCorner="topRight"
        radius={R.xl}
        style={styles.transport}
      >
        <View style={styles.barTouch} onLayout={onBarLayout} {...scrubResponder.panHandlers}>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${progress * 100}%` }]} />
          </View>
          <View
            pointerEvents="none"
            style={[
              styles.thumb,
              scrubSec !== null && styles.thumbActive,
              { left: `${progress * 100}%` },
            ]}
          />
        </View>
        <View style={styles.timeRow}>
          <Text style={styles.timeText}>{formatTime(displaySec)}</Text>
          <Text style={styles.timeText}>
            -{formatTime(Math.max(0, durationSec - displaySec))}
          </Text>
        </View>

        <View style={styles.controls}>
          {/* ↺15 是產品的核心手勢：唯一有顏色的鍵，永遠最大。 */}
          <Pressable
            onPress={onBack15}
            style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={t('home.a11y_back15')}
          >
            <SkipIcon seconds={BACK_SECONDS} direction="back" size={30} color={C.accent} />
          </Pressable>

          <Pressable
            onPress={onTogglePlay}
            style={({ pressed }) => [styles.playBtn, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={playing ? t('home.a11y_pause') : t('home.a11y_play')}
          >
            {playing ? <PauseIcon size={22} color={C.bg} /> : <PlayIcon size={24} color={C.bg} />}
          </Pressable>

          <Pressable
            onPress={onForward30}
            style={({ pressed }) => [styles.fwdBtn, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={t('home.a11y_forward30')}
          >
            <SkipIcon
              seconds={FORWARD_SECONDS}
              direction="forward"
              size={26}
              color={C.dim}
            />
          </Pressable>
        </View>
      </Glass>

      {/* 這一層是 Modal，但 TranscriptScreen 自己只是 App.tsx 的絕對定位覆蓋層
          （ADR-0015），所以整條路徑上仍然只有一層 Modal。 */}
      <SelectionSheet
        draft={draft}
        onCancel={() => setDraft(null)} // 回到 ranged，不清空——他可能只想改範圍
        onPick={handlePickKind}
      />
    </View>
  );
}

const MARKER_W = 3;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP(3),
    paddingHorizontal: SP(4),
    paddingBottom: SP(3),
  },
  // 這兩顆小控制項也玻璃化：填色 + hairline 一起換成 GLASS 那一組。兩套邊框不
  // 混用（theme.ts 的分工），所以這裡不會再出現 C.border。
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: GLASS.fill,
    borderWidth: 1,
    borderColor: GLASS.edge,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: { flex: 1 },
  headerTitle: { ...TYPE.heading, color: C.text },
  headerSub: { ...TYPE.caption, color: C.faint, fontWeight: '400', marginTop: 1 },

  selectBtn: {
    height: 30,
    paddingHorizontal: SP(3),
    borderRadius: R.pill,
    backgroundColor: GLASS.fill,
    borderWidth: 1,
    borderColor: GLASS.edge,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectBtnOn: { backgroundColor: C.accentSurface, borderColor: C.accent },
  selectBtnText: { ...TYPE.caption, color: C.dim },
  selectBtnTextOn: { color: C.text },

  statusRow: { paddingHorizontal: SP(5), paddingBottom: SP(2) },
  statusText: { ...TYPE.caption, color: C.dim, fontWeight: '400' },

  listWrap: { flex: 1 },
  listContent: {
    paddingHorizontal: SP(4),
    // 上下各留一大塊：當前句停在畫面 4 成高的位置，開頭與結尾也要捲得到那裡。
    paddingTop: SP(4),
    paddingBottom: SP(30),
  },
  emptyText: { ...TYPE.body, color: C.faint, paddingHorizontal: SP(2) },

  row: {
    flexDirection: 'row',
    gap: SP(3),
    paddingVertical: SP(2),
    paddingRight: SP(2),
    borderRadius: R.md,
  },
  rowPressed: { backgroundColor: C.surface },
  // 被鎖定的那一列刻意沿用 rowPressed 的同一個底色，不發明新的視覺語言：
  // 「這一列現在被按著」與「這一列現在可以圈」是同一件事的兩種說法。
  rowLocked: { backgroundColor: C.surface },

  // 位置標記：不畫底色塊，靠一條左邊的細線。底色塊會讓長句變成一大片色板，
  // 在滿版閱讀器裡比字本身還搶眼。
  marker: {
    width: MARKER_W,
    borderRadius: MARKER_W,
    backgroundColor: 'transparent',
    marginTop: SP(1),
    marginBottom: SP(1),
  },
  // 藍＝中性 chrome / 進度（theme.ts）。它表達的是播放位置，不是「你動手了」。
  markerOn: { backgroundColor: C.primary },

  // 三階的差距刻意拉大：字級 21 → 18，亮度 text → dim → faint。
  // 在會動的畫面上，只靠顏色一階是看不出來的。
  lineCurrent: {
    flex: 1,
    fontSize: 21,
    lineHeight: 33,
    fontWeight: '600',
    color: C.text,
    letterSpacing: 0.1,
  },
  linePast: { flex: 1, fontSize: 18, lineHeight: 30, fontWeight: '400', color: C.dim },
  lineFuture: { flex: 1, fontSize: 18, lineHeight: 30, fontWeight: '400', color: C.faint },

  // Term 的兩段式底色：巢狀 Text 的 opacity 在 iOS 上不可靠，所以「較弱的一層」
  // 靠換**底色**達成，不靠透明度。字色兩層都是 highlightInk —— `C.highlight`
  // 是那塊帶 alpha 的琥珀**底色**，拿它當字色會疊成 ~1.5:1，整句標註等於隱形。
  term: { backgroundColor: C.surfaceAlt, color: C.highlightInk },
  termCurrent: { backgroundColor: C.highlight, color: C.highlightInk, fontWeight: '700' },

  /**
   * 選取模式下的 term：**琥珀從底色降級成底線**。
   *
   * 這是「證據 vs 推測」那條分界線在選取模式下的活法。綠底（`accentSurface`）＝
   * 學習者親手圈的，琥珀＝app 猜的；兩者若共用「背景」這一個通道，同一個字上
   * 就會疊出一塊誰也認不出來的顏色，而那條分界正是整個產品的論點。所以背景整條
   * 讓給綠色，琥珀退到底線——兩個訊號同時看得見，而且永遠分得出誰是誰。
   *
   * 用 textDecoration 而不是 borderBottom：巢狀 `<Text>` 在 iOS 上是 attributed
   * string，border 系列根本不會畫出來。
   */
  termQuiet: {
    color: C.highlightInk,
    textDecorationLine: 'underline',
    textDecorationColor: C.highlightInk,
  },
  /** 被圈起來的字。current/past/future 一律 C.text——faint 疊在綠底上會掉出 AA。 */
  tokenPicked: { backgroundColor: C.accentSurface, color: C.text },
  /** 又被圈、又是 app 猜的難點詞：綠底 + 琥珀底線，兩個訊號各佔一個通道。 */
  tokenPickedTerm: {
    backgroundColor: C.accentSurface,
    color: C.text,
    textDecorationLine: 'underline',
    textDecorationColor: C.highlightInk,
  },

  // 列表下緣的淡出。高度約兩行，再高就會把還在讀的字也吃掉。
  listFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 72 },

  // 提示列／確認膠囊／「回到目前位置」共用同一個落點：它們永遠不同時出現，
  // 位置一致才不會讓使用者每次都要重新找。
  pillWrap: { position: 'absolute', alignSelf: 'center', bottom: SP(4) },
  pill: { borderRadius: R.pill, paddingHorizontal: SP(4), paddingVertical: SP(2) },
  pillText: { ...TYPE.caption, color: C.text },
  /** 綠底＝剛剛那一下是學習者自己動的手。 */
  confirmPill: { backgroundColor: C.accentSurface },

  actionBar: { position: 'absolute', left: SP(4), right: SP(4), bottom: SP(3) },
  // 排版放在內層：elevated 的 Glass 會把 style 交給外層投影用的 View，
  // flexDirection 寫在那上面排不到內容。
  // 三顆按鈕塞不進 375pt 的一列，所以拆兩列：上列是「你圈到什麼」，
  // 下列是「拿它做什麼」。padding 從 actionRow 移到外層 actionBody，
  // 免得兩列各補一次內距、面板上下不對稱。
  actionBody: { padding: SP(2), gap: SP(2) },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: SP(2) },
  actionRowExits: { flexDirection: 'row', alignItems: 'center', gap: SP(2) },
  actionPreview: {
    flex: 1,
    ...TYPE.caption,
    color: C.text,
    backgroundColor: C.accentSurface,
    borderRadius: R.sm,
    paddingHorizontal: SP(2),
    paddingVertical: SP(1),
    overflow: 'hidden', // iOS 上 Text 的圓角要靠這個才會裁
  },
  actionCancel: { paddingHorizontal: SP(2), paddingVertical: SP(2) },
  actionCancelText: { ...TYPE.caption, color: C.dim },
  actionAdd: {
    backgroundColor: C.accent,
    borderRadius: R.md,
    paddingHorizontal: SP(3),
    paddingVertical: SP(2),
  },
  actionAddText: { ...TYPE.caption, color: C.accentInk, fontWeight: '700' },
  /**
   * 「{t('ts.cant_split_btn')}」。**不給實色綠**：綠是那條路徑的主按鈕賺到的，
   * 這一顆是同等合法但較少走的出口，用玻璃填色排在同一列即可。給它 flex:1
   * 是因為文案最長，讓它吃掉剩餘寬度、「加入難點」維持內容寬。
   */
  actionSeg: {
    flex: 1,
    backgroundColor: GLASS.fillStrong,
    borderRadius: R.md,
    paddingHorizontal: SP(2),
    paddingVertical: SP(2),
    alignItems: 'center',
  },
  actionSegText: { ...TYPE.caption, color: C.text },

  transport: {
    paddingHorizontal: SP(5),
    paddingTop: SP(3),
    paddingBottom: SP(8),
    // 下面兩個角在螢幕外，留著只會讓 hairline 在底緣彎一下。
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  barTouch: { height: 26, justifyContent: 'center' },
  // 玻璃是凸的、軌道是凹的：用 GLASS.well 而不是 C.border（那條 hairline 色被
  // 當成填色用是既有的漂移，這塊面板改成玻璃之後更是不能留）。
  barTrack: { height: 4, borderRadius: 2, backgroundColor: GLASS.well, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: C.primary },
  thumb: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: C.text,
    marginLeft: -6,
  },
  thumbActive: { transform: [{ scale: 1.35 }] },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -2 },
  // transport 改成玻璃之後這裡從 faint 升一階：faint 的 4.6:1 是對實色 surface
  // 算的，玻璃底下是「底色 × 半透明填色 × 色暈」的變數，會掉出 AA。
  timeText: { ...TYPE.mono, color: C.dim, fontWeight: '400' },

  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SP(8),
    marginTop: SP(3),
  },
  backBtn: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  playBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: C.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fwdBtn: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
});
