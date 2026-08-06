/**
 * 全螢幕逐字稿閱讀器（Apple Podcasts 的 transcript 視圖）。
 *
 * 為什麼是**全螢幕**而不是播放器下面的一塊面板：面板版排在所有播放控制之後，在
 * iPhone 上只分得到約三成高度，一次看得到五、六行。跟播捲動在那種視窗裡看起來
 * 不像「跟著唸」，而像「清單在抖」。逐字稿是這個 app 的閱讀模式，它需要整個畫面。
 *
 * 「現在唸到哪一句」靠三件事同時表達，缺一都不夠明顯：
 *   1. 字級（21 vs 18）    —— 掃視時第一眼就會落在最大的那行
 *   2. 亮度（text vs dim） —— 其餘句子退成背景
 *   3. 左側的藍色標記      —— 位置的絕對指標，就算兩行字級接近也認得出來
 * 藍色是 theme.ts 定義的「中性 chrome＝進度」，用在這裡語意正確：它表達的是
 * 播放位置，不是「你動手了」（綠）也不是「app 在猜」（琥珀）。
 *
 * 播放控制留在底部，所以看逐字稿時不必退回播放器就能 ↺15、暫停、拖進度。
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

import { Chevron, PauseIcon, PlayIcon, SkipIcon } from './Glyph';
import {
  ensureAnnotations,
  getTerms,
  isAnnotationConfigured,
  segmentKey,
  subscribeAnnotations,
  Term,
} from '../lib/annotate';
import { Episode } from '../lib/episodes';
import { isSupabaseConfigured } from '../lib/supabase';
import {
  ensureWindowFor,
  getSegments,
  isCovered,
  preloadTranscript,
  windowFailure,
} from '../lib/transcript';
import { C, R, SP, TYPE } from '../lib/theme';
import { TranscriptSegment } from '../lib/types';

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

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.floor(totalSeconds);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface RowProps {
  segment: TranscriptSegment;
  parts: Part[] | undefined;
  state: RowState;
  onSelect: (segment: TranscriptSegment) => void;
  onOpenTerm: (term: Term) => void;
}

const SegmentRow = memo(function SegmentRow({
  segment,
  parts,
  state,
  onSelect,
  onOpenTerm,
}: RowProps) {
  const current = state === 'current';

  const pressTerm = (e: GestureResponderEvent, term: Term) => {
    // 點 term 到此為止——否則同一下也會被外層 Pressable 當成「跳到這句」，
    // 使用者只想看解釋卻被拖回句首。
    e.stopPropagation();
    onOpenTerm(term);
  };

  return (
    <Pressable
      onPress={() => onSelect(segment)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {/* 位置標記：只有當前句畫得出來，其餘句子留同寬的空位，免得整段文字左右跳。 */}
      <View style={[styles.marker, current && styles.markerOn]} />
      <Text
        style={
          current ? styles.lineCurrent : state === 'past' ? styles.linePast : styles.lineFuture
        }
      >
        {parts
          ? parts.map((p, i) =>
              p.term ? (
                <Text
                  key={i}
                  style={current ? styles.termCurrent : styles.term}
                  onPress={(e) => pressTerm(e, p.term as Term)}
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
  const [segments, setSegments] = useState<TranscriptSegment[]>(() =>
    getSegments(episode.id),
  );
  const [annotationRev, setAnnotationRev] = useState(0);
  const [following, setFollowing] = useState(true);
  const [hydratedId, setHydratedId] = useState<string | null>(null);
  const [scrubSec, setScrubSec] = useState<number | null>(null);
  // 暫停時沒有 positionSec 的更新來觸發重繪，轉錄失敗訊息得自己敲一下。
  const [, forceRender] = useState(0);

  const listRef = useRef<FlatList<TranscriptSegment>>(null);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrolledRef = useRef(-1);

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

  // --- 點一句 = 跳過去（往回跳就是一次 replay event）------------------------
  const handleSelect = useCallback((segment: TranscriptSegment) => {
    // 1 秒寬容度讓「點目前這句」不會被誤記成重聽。positionRef 最多落後一個
    // render（250ms），而這個誤差只會讓我們少記、不會多記——訊號寧可漏不可假。
    seekRef.current(segment.start, segment.start < positionRef.current - 1);
    // 點完立刻恢復跟隨：使用者剛剛指定了要聽哪裡，畫面應該跟過去。
    resumeFollow();
  }, [resumeFollow]);

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
        ? '本地模式，逐字稿需要連線'
        : '轉錄中…';

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={onClose}
          hitSlop={12}
          style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="關閉逐字稿"
        >
          <Chevron direction="down" size={12} color={C.text} weight={2.5} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>逐字稿</Text>
          <Text style={styles.headerSub} numberOfLines={1}>
            {episode.title}
          </Text>
        </View>
      </View>

      {status !== null && (
        <View style={styles.statusRow}>
          <Text style={styles.statusText}>{status}</Text>
        </View>
      )}
      {!isAnnotationConfigured() && (
        <View style={styles.statusRow}>
          <Text style={styles.statusText}>難點標註需要連線</Text>
        </View>
      )}

      {/* 逐字稿本體 */}
      <View style={styles.listWrap}>
        <FlatList
          ref={listRef}
          data={segments}
          keyExtractor={rowKey}
          extraData={activeIndex}
          onScrollToIndexFailed={onScrollToIndexFailed}
          onScrollBeginDrag={onUserGrab}
          onScrollEndDrag={armResume}
          onMomentumScrollEnd={armResume}
          initialNumToRender={14}
          maxToRenderPerBatch={16}
          windowSize={11}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <Text style={styles.emptyText}>{status ?? '這一段還沒有逐字稿'}</Text>
          }
          renderItem={({ item, index }) => (
            <SegmentRow
              segment={item}
              parts={partsIndex.get(rowKey(item))}
              state={
                index === activeIndex ? 'current' : index <= nearestIndex ? 'past' : 'future'
              }
              onSelect={handleSelect}
              onOpenTerm={handleOpenTerm}
            />
          )}
        />

        {!following && segments.length > 0 && (
          <Pressable
            onPress={resumeFollow}
            style={({ pressed }) => [styles.followPill, pressed && styles.pressed]}
          >
            <Text style={styles.followPillText}>回到目前位置</Text>
          </Pressable>
        )}
      </View>

      {/* 底部播放控制：看逐字稿時不必退回播放器 */}
      <View style={styles.transport}>
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
            accessibilityLabel="重聽 15 秒"
          >
            <SkipIcon seconds={BACK_SECONDS} direction="back" size={30} color={C.accent} />
          </Pressable>

          <Pressable
            onPress={onTogglePlay}
            style={({ pressed }) => [styles.playBtn, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={playing ? '暫停' : '播放'}
          >
            {playing ? <PauseIcon size={22} color={C.bg} /> : <PlayIcon size={24} color={C.bg} />}
          </Pressable>

          <Pressable
            onPress={onForward30}
            style={({ pressed }) => [styles.fwdBtn, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="快轉 30 秒"
          >
            <SkipIcon
              seconds={FORWARD_SECONDS}
              direction="forward"
              size={26}
              color={C.dim}
            />
          </Pressable>
        </View>
      </View>
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
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: { flex: 1 },
  headerTitle: { ...TYPE.heading, color: C.text },
  headerSub: { ...TYPE.caption, color: C.faint, fontWeight: '400', marginTop: 1 },

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

  followPill: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: SP(4),
    backgroundColor: C.surfaceAlt,
    borderRadius: R.pill,
    paddingHorizontal: SP(4),
    paddingVertical: SP(2),
  },
  followPillText: { ...TYPE.caption, color: C.text },

  transport: {
    paddingHorizontal: SP(5),
    paddingTop: SP(3),
    paddingBottom: SP(8),
    backgroundColor: C.surface,
    borderTopLeftRadius: R.xl,
    borderTopRightRadius: R.xl,
  },
  barTouch: { height: 26, justifyContent: 'center' },
  barTrack: { height: 4, borderRadius: 2, backgroundColor: C.border, overflow: 'hidden' },
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
  timeText: { ...TYPE.mono, color: C.faint, fontWeight: '400' },

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
