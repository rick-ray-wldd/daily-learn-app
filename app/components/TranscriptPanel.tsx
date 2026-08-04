/**
 * TranscriptPanel — 跟讀逐字稿（播放器下半部）。
 *
 * ⚠️ 為什麼預設是摺疊的：這是**產品約束**，不是視覺偏好。
 * CONTEXT.md 對 **signal strength** 的定義裡，「rewind 之後打開逐字稿」是三個
 * 把一則 **capture** 升級成 strong 的條件之一。逐字稿若永遠攤開，「打開」就不
 * 再是一個事件，那個訊號會被我們自己銷毀。所以 `onToggleExpand(true)` 必須對
 * 應一次真實的使用者動作：只在使用者按下去時呼叫一次，
 * **絕不從 effect 呼叫、絕不在 re-render 時呼叫**。
 *
 * 第二條約束：自動捲動必須讓位給使用者（見 FOLLOW_RESUME_MS）。讀到一半被清
 * 單拉走，比沒有逐字稿更糟。
 *
 * 第三條：摺疊時**不驅動轉錄**。學習者沒在讀，而每個新窗口都要付 Whisper 的錢。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

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
import { C, R, SP, TYPE } from '../lib/theme';
import {
  ensureWindowFor,
  getSegments,
  isCovered,
  preloadTranscript,
  windowFailure,
} from '../lib/transcript';
import { TranscriptSegment } from '../lib/types';

/** 展開時驅動轉錄的節流間隔。ensureWindowFor 自己會去重，這裡只是不要每 250ms 敲一次。 */
const ENSURE_INTERVAL_MS = 3000;
/** 使用者停手多久才恢復自動跟隨。 */
const FOLLOW_RESUME_MS = 6000;
/** 目前這句停在畫面上方約 1/3：上面留剛講完的當上下文，下面留最多待讀空間。 */
const FOLLOW_VIEW_POSITION = 0.33;
/** scrollToIndex 失敗後、等 FlatList 量完那批列再重試的間隔。 */
const SCROLL_RETRY_MS = 240;

interface TranscriptPanelProps {
  episode: Episode;
  positionSec: number;
  expanded: boolean;
  onToggleExpand: (next: boolean) => void;
  onSeek: (toSec: number, isRewind: boolean) => void;
  onOpenTerm: (term: Term) => void;
}

type RowState = 'current' | 'past' | 'future';

/** 一句話切成「純文字」與「被標註的 term」兩種片段。 */
interface Part {
  text: string;
  term?: Term;
}

// ---------------------------------------------------------------------------
// 純函式（不碰 state，方便將來抽出去測）
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

/**
 * 詞邊界判斷。數字也算 word char，免得 "AI" 之類的 term 咬進 "AI2" 中間。
 */
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

/** 依 term 出現位置把一句話切成片段；這句沒有任何命中就回 null（省掉巢狀 Text）。 */
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
 * 整集的切詞結果，key = rowKey(segment)。
 *
 * 只在 segments 或標註變動時重建一次，之後每個 row 直接拿現成的陣列——切詞
 * 若放在 renderItem 裡，捲動時每一格都要重跑一次字串搜尋。
 *
 * 查表用 `segmentKey` 而不是 `segment.id`：上面說的撞號會讓第一個窗口的 term
 * 掛到第二個窗口的句子上（splitByTerms 只擋得掉文字對不上的那些，剛好用字
 * 相同的仍會畫出一個解釋錯句子的高亮）。
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
  const textStyle = current
    ? styles.lineCurrent
    : state === 'past'
      ? styles.linePast
      : styles.lineFuture;

  const pressTerm = (e: GestureResponderEvent, term: Term) => {
    // 點 term 到此為止——否則同一下也會被外層 Pressable 當成「跳到這句」，
    // 使用者只想看解釋卻被拖回句首。
    e.stopPropagation();
    onOpenTerm(term);
  };

  return (
    <Pressable
      onPress={() => onSelect(segment)}
      style={[styles.row, current && styles.rowCurrent]}
    >
      <Text style={textStyle}>
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
// Panel
// ---------------------------------------------------------------------------

export default function TranscriptPanel({
  episode,
  positionSec,
  expanded,
  onToggleExpand,
  onSeek,
  onOpenTerm,
}: TranscriptPanelProps) {
  const [segments, setSegments] = useState<TranscriptSegment[]>(() =>
    getSegments(episode.id),
  );
  const [annotationRev, setAnnotationRev] = useState(0);
  const [following, setFollowing] = useState(true);
  /**
   * 已經讀過磁碟快取的那一集。存 id 而不是 boolean，是為了不依賴 effect 之間的
   * 執行順序：換集那一個 render 裡它還是舊集的 id，轉錄 effect 自然就跳過了。
   */
  const [hydratedId, setHydratedId] = useState<string | null>(null);
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
  // 都要重付一次 Whisper 的錢（一個窗口約 $0.06）——快取等於白做。
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

  // --- 驅動轉錄（只在展開、且磁碟快取讀完之後）-----------------------------
  useEffect(() => {
    if (!expanded || hydratedId !== episode.id) return;
    let alive = true;

    const run = () => {
      void ensureWindowFor(episode, positionRef.current)
        .then((res) => {
          if (!alive) return;
          // 新句子可能來自這次轉錄，也可能來自磁碟快取／RSS 全集稿——一律以
          // transcript.ts 目前手上的為準。同一個陣列參考時 React 會自行 bail
          // out，所以每 3 秒呼叫一次不會造成多餘 render。
          const next = getSegments(episode.id);
          setSegments(next);
          if (next.length > 0) ensureAnnotations(episode.id, next);
          if (res?.status === 'failed') forceRender((v) => v + 1);
        })
        .catch(() => {
          // ensureWindowFor 內部已經把錯誤轉成 failedWindows，這裡只是防呆。
        });
    };

    run(); // 展開的當下就要一次，別讓使用者盯著空白等 3 秒
    const id = setInterval(run, ENSURE_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [expanded, episode, hydratedId]);

  // --- 位置 → 目前這句 -----------------------------------------------------
  const nearestIndex = useMemo(
    () => indexAt(segments, positionSec),
    [segments, positionSec],
  );
  // 嚴格落在 [start, end) 才算 current；句與句之間的停頓不該讓整列變亮。
  const activeIndex =
    nearestIndex >= 0 && positionSec < segments[nearestIndex].end
      ? nearestIndex
      : -1;

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
    if (!expanded || !following) return;
    if (nearestIndex < 0 || nearestIndex >= segments.length) return;
    // 只有換行才捲：positionSec 每 250ms 就變，每次都捲會一直打斷動畫。
    if (nearestIndex === lastScrolledRef.current) return;
    lastScrolledRef.current = nearestIndex;
    scrollToRow(nearestIndex);
  }, [expanded, following, nearestIndex, segments.length, scrollToRow]);

  const armResume = useCallback(() => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => setFollowing(true), FOLLOW_RESUME_MS);
  }, []);

  // 手一碰就停止跟隨，而且不倒數——倒數要從「放開」那一刻才開始算。
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
  }, []);

  const handleOpenTerm = useCallback((term: Term) => {
    openTermRef.current(term);
  }, []);

  // --- 狀態訊息 ------------------------------------------------------------
  // RSS 官方逐字稿免費且不需要後端，所以「有沒有得抓」不等於「有沒有 Supabase」。
  const canFetch = isSupabaseConfigured || Boolean(episode.transcriptUrl);
  const covered = isCovered(episode.id, positionSec);
  const failure = windowFailure(episode.id, positionSec);
  // 展開時只要「沒覆蓋、沒失敗、抓得到」，transcript.ts 就一定有一個窗口在飛
  // （pickWindow 的定義），所以「轉錄中…」不需要另外追一個 in-flight 旗標。
  const status: string | null = covered
    ? null
    : failure // 伺服器已經寫成使用者看得懂的中文，原文照登
      ? failure
      : !canFetch
        ? '本地模式，逐字稿需要連線'
        : expanded
          ? '轉錄中…'
          : null;

  // --- 摺疊：只露出正在講的那一句 ------------------------------------------
  if (!expanded) {
    const peek =
      activeIndex >= 0
        ? segments[activeIndex].text
        : (status ?? '點開看逐字稿');
    return (
      <Pressable
        onPress={() => onToggleExpand(true)}
        style={({ pressed }) => [styles.peek, pressed && styles.pressed]}
      >
        <Text
          style={activeIndex >= 0 ? styles.peekText : styles.peekHint}
          numberOfLines={1}
        >
          {peek}
        </Text>
        <Text style={styles.chevron}>⌃</Text>
      </Pressable>
    );
  }

  // --- 展開 ----------------------------------------------------------------
  const showStatusRow = status !== null && segments.length > 0;

  return (
    <View style={styles.panel}>
      <Pressable onPress={() => onToggleExpand(false)} style={styles.header} hitSlop={6}>
        <Text style={styles.headerTitle}>逐字稿</Text>
        {!isAnnotationConfigured() && (
          <Text style={styles.headerNote}>難點標註需要連線</Text>
        )}
        <Text style={styles.chevron}>⌄</Text>
      </Pressable>

      {showStatusRow && (
        <View style={styles.statusRow}>
          <Text style={styles.statusText}>{status}</Text>
        </View>
      )}

      <View style={styles.listWrap}>
        <FlatList
          ref={listRef}
          data={segments}
          keyExtractor={rowKey}
          extraData={activeIndex}
          onScrollToIndexFailed={onScrollToIndexFailed}
          onTouchStart={onUserGrab}
          onScrollBeginDrag={onUserGrab}
          onScrollEndDrag={armResume}
          onMomentumScrollEnd={armResume}
          onTouchEnd={armResume}
          initialNumToRender={12}
          maxToRenderPerBatch={16}
          windowSize={9}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <Text style={styles.emptyText}>{status ?? '這一段還沒有逐字稿'}</Text>
          }
          renderItem={({ item, index }) => (
            <SegmentRow
              segment={item}
              parts={partsIndex.get(rowKey(item))}
              state={
                index === activeIndex
                  ? 'current'
                  : index <= nearestIndex
                    ? 'past'
                    : 'future'
              }
              onSelect={handleSelect}
              onOpenTerm={handleOpenTerm}
            />
          )}
        />

        {!following && segments.length > 0 && (
          <Pressable
            onPress={resumeFollow}
            style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
          >
            <Text style={styles.pillText}>回到目前位置</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // 摺疊
  peek: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP(2),
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.md,
    paddingHorizontal: SP(3),
    paddingVertical: SP(2),
  },
  peekText: { ...TYPE.body, color: C.text, flex: 1 },
  peekHint: { ...TYPE.caption, color: C.faint, flex: 1 },
  chevron: { ...TYPE.caption, color: C.dim },

  // 展開
  panel: {
    flex: 1,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.lg,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP(2),
    paddingHorizontal: SP(3),
    paddingVertical: SP(2),
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  headerTitle: { ...TYPE.caption, color: C.dim, flex: 1 },
  headerNote: { ...TYPE.caption, color: C.faint },

  statusRow: {
    paddingHorizontal: SP(3),
    paddingVertical: SP(1),
    backgroundColor: C.surfaceAlt,
  },
  statusText: { ...TYPE.caption, color: C.dim },

  listWrap: { flex: 1 },
  listContent: { paddingVertical: SP(2), paddingHorizontal: SP(2) },
  emptyText: {
    ...TYPE.caption,
    color: C.faint,
    paddingHorizontal: SP(2),
    paddingVertical: SP(3),
  },

  row: {
    paddingHorizontal: SP(2),
    paddingVertical: SP(1),
    borderRadius: R.md,
  },
  rowCurrent: { backgroundColor: C.surfaceAlt },
  lineCurrent: { ...TYPE.heading, color: C.text, fontWeight: '600' },
  linePast: { ...TYPE.body, color: C.dim },
  lineFuture: { ...TYPE.body, color: C.faint },

  // Term 的兩段式底色：巢狀 Text 的 opacity 在 iOS 上不可靠，所以「較弱的一層」
  // 靠換**底色**達成（surfaceAlt 取代半透明的 highlight），不靠透明度。
  // 字色兩層都是 highlightInk —— `C.highlight` 是那塊帶 alpha 的琥珀**底色**，
  // 拿它當字色會疊成 ~1.5:1，整句標註等於隱形。
  term: { backgroundColor: C.surfaceAlt, color: C.highlightInk },
  termCurrent: {
    backgroundColor: C.highlight,
    color: C.highlightInk,
    fontWeight: '700',
  },

  pill: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: SP(2),
    backgroundColor: C.accent,
    borderRadius: R.pill,
    paddingHorizontal: SP(3),
    paddingVertical: SP(1),
  },
  pillText: { ...TYPE.caption, color: C.accentInk, fontWeight: '700' },

  pressed: { opacity: 0.7 },
});
