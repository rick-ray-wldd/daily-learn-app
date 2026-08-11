/**
 * 首頁 —— 上半是固定版面的 bento（正在播放／今日練習／本週訊號／連續天數／難點詞庫），
 * 下半是一路長下去的探索 masonry。整頁**只有一個捲動容器**：MasonryList 自己就是，
 * 五個 bento 區塊是它的 ListHeaderComponent。
 *
 * 為什麼 bento 不做成 position: fixed 的上半部：上半加起來約 650px，任何一支 iPhone
 * 都塞不下它 + 兩排卡片，做成固定區只會把探索壓成一條縫。「版面固定」指的是它的欄寬
 * 與高度不隨資料變動，不是它不會捲。
 *
 * ⚠️ 這個元件**永遠拿不到 player 實例**（ADR-0015：外殼擁有播放器）。所有播放狀態
 * 從 props 進來、所有動作走 props 的 callback 出去。特別是往回鍵一定要走
 * `onBack15`（= App.back15）——它會記 replay event，而那是整個產品唯一在乎的訊號；
 * 自己算目標位置再 seek 會讓那一下重聽從資料裡消失。
 *
 * 它每 250ms 會跟著播放位置重繪一次，所以清單卡片、訊號環都必須 memo，而傳給它們的
 * callback 必須身分恆定（見下方 handlersRef）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import Artwork from './Artwork';
import Glass from './Glass';
import Gradient from './Gradient';
import MasonryList from './MasonryList';
import SignalRing from './SignalRing';
import VolumeSlider from './VolumeSlider';
import { PauseIcon, PlayIcon, SkipIcon } from './Glyph';
import { DEMO_EPISODES, Episode } from '../lib/episodes';
import { cyrb53 } from '../lib/hash';
import { addDaysStr, toDateStr, todayStr } from '../lib/srs';
import { computeStreak } from '../lib/stats';
import {
  getCaptures,
  getFeedEpisodes,
  getFeeds,
  getPracticeLog,
  getSrsItems,
  initStore,
  subscribe,
} from '../lib/store';
import { BLOOM, C, GLASS, R, RAMP, SP, TYPE } from '../lib/theme';
import { Capture, SrsItem } from '../lib/types';

export interface HomeScreenProps {
  // —— 播放：全部由 App.tsx 的唯一 player 供給。這個元件永遠拿不到 player 實例，
  //    也永遠不自己呼叫 play/pause/seekTo。
  episode: Episode;
  positionSec: number;
  durationSec: number;
  playing: boolean;
  rate: number;
  loadState: string | null;
  /** 0–1。App.tsx 的 state 是唯一真相（AudioStatus 沒有 volume 欄位，讀不回來）。 */
  volume: number;
  onTogglePlay: () => void;
  /** 必須是 App.back15 —— 它會記 replay event，那是整個產品唯一在乎的訊號。 */
  onBack15: () => void;
  onForward30: () => void;
  onCycleRate: () => void;
  onVolumeChange: (value: number) => void;
  onOpenNowPlaying: () => void;
  onOpenTranscript: () => void;

  // —— 導覽
  onSelectEpisode: (ep: Episode) => void;
  onGoPractice: () => void;
  onGoBrowse: () => void;
  /** App.tsx 已經算好的待練張數，不要在這裡重算一次（那會變成第三份孿生邏輯）。 */
  practiceBadge: number;
}

/** 所有列間距與欄距都是這一個值，bento 才看得出來是同一張網格。 */
const GAP = SP(3);
/** 每頁 10 張。分頁是「無限」的實作方式——內容見底就誠實地請使用者去訂閱。 */
const PAGE_SIZE = 10;
/** 卡片封面底下留給兩行標題 + 一行 metadata 的高度。 */
const CARD_TEXT_H = 56;
/** 高低差的唯一來源：下緣不齊靠這個，不然 masonry 就只是一張表格。 */
const CARD_EXTRA = [0, 24, 48];
/** 螢幕矮於此就進 compact：hero 封面縮一階、藏掉節目名、ROW 2 降高。 */
const COMPACT_HEIGHT = 700;

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.floor(totalSeconds);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

/**
 * 卡片高度。**必須是純的、對同一集恆定**——高度是分欄演算法的輸入，同一集每次
 * 算出不同高度就會讓整批卡片在畫面上跳位，而使用者是靠形狀在清單裡認集數的。
 *
 * hash 直接用 lib/hash.ts 的 cyrb53（rss.ts 已經在用同一支）：Artwork 的 hueFrom
 * 沒 export，但沒有理由為此在這裡再寫第四份雜湊。
 */
function cardHeight(ep: Episode, w: number): number {
  return Math.round(w) + CARD_TEXT_H + CARD_EXTRA[cyrb53(ep.id) % CARD_EXTRA.length];
}

function pubTime(ep: Episode): number {
  if (!ep.pubDate) return Number.NaN;
  const t = new Date(ep.pubDate).getTime();
  return Number.isFinite(t) ? t : Number.NaN;
}

/** 新到舊；沒有 pubDate 的排最後，同組再用 id 字典序——排序必須全序才穩定。 */
function byRecency(a: Episode, b: Episode): number {
  const ta = pubTime(a);
  const tb = pubTime(b);
  const aHas = !Number.isNaN(ta);
  const bHas = !Number.isNaN(tb);
  if (aHas && bHas && ta !== tb) return tb - ta;
  if (aHas !== bHas) return aHas ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 探索卡片
// ---------------------------------------------------------------------------

interface CardProps {
  episode: Episode;
  width: number;
  active: boolean;
  onPress: (ep: Episode) => void;
}

/**
 * memo 不是可選的：首頁跟著播放位置每秒重繪 4 次，而清單上可能有數十張卡。
 * 它成立的前提是 `onPress` 身分恆定（見 HomeScreen 的 handlersRef）。
 */
const EpisodeCard = React.memo(function EpisodeCard({
  episode,
  width,
  active,
  onPress,
}: CardProps) {
  const meta =
    episode.durationSec > 0
      ? `${episode.podcast} · ${formatTime(episode.durationSec)}`
      : episode.podcast;

  return (
    <Pressable
      onPress={() => onPress(episode)}
      style={({ pressed }) => [styles.cardPress, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`播放 ${episode.title}`}
    >
      {/* sheen 在這麼小的卡上只是雜訊、elevated 會讓一整片清單看起來髒；
          正在播放的那一集用藍框標示——藍是中性 chrome（播放位置），不是綠。 */}
      <Glass sheen={false} radius={R.md} style={[styles.card, active && styles.cardActive]}>
        <Artwork episode={episode} size={width} radius={R.md} />
        <View style={styles.cardText}>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {episode.title}
          </Text>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {meta}
          </Text>
        </View>
      </Glass>
    </Pressable>
  );
});

// ---------------------------------------------------------------------------

export default function HomeScreen({
  episode,
  positionSec,
  durationSec,
  playing,
  rate,
  loadState,
  volume,
  onTogglePlay,
  onBack15,
  onForward30,
  onCycleRate,
  onVolumeChange,
  onOpenNowPlaying,
  onOpenTranscript,
  onSelectEpisode,
  onGoPractice,
  onGoBrowse,
  practiceBadge,
}: HomeScreenProps): React.ReactElement {
  const { height: screenHeight } = useWindowDimensions();
  const compact = screenHeight < COMPACT_HEIGHT;

  const [rev, setRev] = useState(0);
  const [page, setPage] = useState(1);

  // 照 App.tsx / Practice.tsx 的既有模式訂閱 store，不自己發明狀態管理。
  useEffect(() => {
    // 第一幀資料還沒 hydrate；少了這一步所有數字會先是 0 再閃一下。
    void initStore().then(() => setRev((v) => v + 1));
    const un = subscribe(() => setRev((v) => v + 1));
    // 跨午夜回前景時日界線變了 → 週視圖與連續天數都得重算，否則會停在昨天。
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setRev((v) => v + 1);
    });
    return () => {
      un();
      sub.remove();
    };
  }, []);

  /**
   * 傳給 memo 過的子元件的 callback 必須身分恆定，但 App.tsx 傳進來的每一個都是
   * inline 箭頭函式（每 250ms 換一次身分）。所以這裡用 ref 轉一手：外面怎麼換，
   * 下游拿到的都是同一個函式，memo 才真的擋得住重繪。
   */
  const handlersRef = useRef({ onSelectEpisode, onGoPractice, onGoBrowse });
  useEffect(() => {
    handlersRef.current = { onSelectEpisode, onGoPractice, onGoBrowse };
  });
  const selectEpisode = useCallback((ep: Episode) => handlersRef.current.onSelectEpisode(ep), []);
  const goPractice = useCallback(() => handlersRef.current.onGoPractice(), []);
  const goBrowse = useCallback(() => handlersRef.current.onGoBrowse(), []);

  /**
   * ⚠️ 所有衍生值的 dep 一律是 `rev`，**不能**用 `getCaptures()` 回傳的陣列：
   * store 的 mutator 是就地改，陣列 reference 永遠不變，拿它當 dep 等於永遠不重算。
   */
  const signal = useMemo(() => computeWeekSignal(getCaptures(), getSrsItems()), [rev]);
  const streak = useMemo(() => computeStreak(getPracticeLog()), [rev]);

  const weekDots = useMemo(() => {
    // 與 computeStreak 同一條判準（items_completed > 0），否則點點會跟數字打架。
    const done = new Set(
      getPracticeLog()
        .filter((r) => r.items_completed > 0)
        .map((r) => r.date),
    );
    // 由舊到新，最右邊那顆是今天——跟由左往右的閱讀順序一致。
    return Array.from({ length: 7 }, (_, i) => done.has(addDaysStr(-(6 - i))));
  }, [rev]);

  const chips = useMemo(
    () =>
      // 先複製再排序：getCaptures() 回的是 store 的**內部陣列**，就地 sort 會把
      // store 自己的順序打亂（它靠 unshift 維持新到舊）。
      [...getCaptures()]
        .filter((c) => !!c.selection_text)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
        .slice(0, 12),
    [rev],
  );

  const pool = useMemo(() => {
    const byId = new Map<string, Episode>();
    for (const ep of DEMO_EPISODES) byId.set(ep.id, ep);
    for (const feed of getFeeds()) {
      for (const ep of getFeedEpisodes(feed.feed_url)) {
        if (!byId.has(ep.id)) byId.set(ep.id, ep);
      }
    }
    return Array.from(byId.values()).sort(byRecency);
  }, [rev]);

  const visible = useMemo(() => pool.slice(0, page * PAGE_SIZE), [pool, page]);
  const exhausted = visible.length >= pool.length;

  const onEndReached = useCallback(() => {
    // 池到底就不再加頁。這裡刻意**不去接新的網路來源**（iTunes 榜單之類）：
    // 「無限」是分頁機制，內容見底就誠實地請使用者去訂閱（見 footer）。
    setPage((p) => (p * PAGE_SIZE >= pool.length ? p : p + 1));
  }, [pool.length]);

  const keyExtractor = useCallback((ep: Episode) => ep.id, []);
  const itemHeight = useCallback((ep: Episode, w: number) => cardHeight(ep, w), []);

  const progress =
    durationSec > 0 ? Math.min(Math.max(positionSec, 0) / durationSec, 1) : 0;
  const progressWidth: `${number}%` = `${progress * 100}%`;
  const remaining = durationSec > 0 ? Math.max(0, durationSec - positionSec) : 0;

  const header = (
    <View>
      {/* ── (a) 正在播放 ─────────────────────────────────────────────────── */}
      <Glass radius={R.xl} bloom="primary" bloomCorner="topRight" style={styles.hero}>
        {/*
          全頁唯一的一個 <Gradient>（§8 的上限）。與 bloom 圓不衝突：圓是局部熱點、
          這層是整面的光衰，兩者疊起來才有 mesh gradient 的錯覺。
          top 從 1 開始而不是 0：那 1px 是 Glass 的上緣高光，蓋掉它整塊就只是灰卡片。
          色相只用這塊面板憑語意賺到的藍（正在播放＝中性 chrome）。
        */}
        <Gradient from={BLOOM.primary} to={GLASS.fill} style={styles.heroWash} />

        <Pressable
          onPress={onOpenNowPlaying}
          style={({ pressed }) => [styles.heroTop, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`${episode.title}，打開播放器`}
        >
          <Artwork episode={episode} size={compact ? 56 : 72} radius={R.md} />
          <View style={styles.heroMeta}>
            <Text style={styles.heroTitle} numberOfLines={2}>
              {episode.title}
            </Text>
            {!compact && (
              <Text style={styles.heroShow} numberOfLines={1}>
                {episode.podcast}
              </Text>
            )}
          </View>
        </Pressable>

        {/*
          進度條**唯讀，不可拖曳**——這是規格層級的決定，不是還沒做完：
          (1) 可拖曳的 scrubber 在 NowPlaying 與 TranscriptScreen 已各有一份，第三份
              等於同一個 bug 要修三處；
          (2) 首頁是捲動容器，橫向 PanResponder 會跟垂直捲動搶手勢，而那兩份都不在
              捲動容器裡、沒踩過這個問題；
          (3) 要拖就點上面的卡片升起 NowPlaying，那裡有完整的。
          duration 為 0（RSS 常見）時填色寬度一律 0，不要拿 0 當分母。
        */}
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: progressWidth }]} />
        </View>
        <View style={styles.timeRow}>
          <Text style={styles.time}>{formatTime(positionSec)}</Text>
          <Text style={styles.time}>-{formatTime(remaining)}</Text>
        </View>

        {/* Transport：↺15 是產品的核心手勢，永遠是版面上唯一有顏色的鍵。
            快轉維持 30 秒（App.tsx 的 FORWARD_SECONDS）——需求文字寫「↷15」，但改那個
            常數會連帶動到 NowPlaying 與 TranscriptScreen 兩支別人的檔案。刻意偏離。 */}
        <View style={styles.transport}>
          <Pressable
            onPress={onBack15}
            style={({ pressed }) => [styles.skipBtn, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="重聽 15 秒"
          >
            <SkipIcon seconds={15} direction="back" size={34} color={C.accent} />
          </Pressable>

          <Pressable
            onPress={onTogglePlay}
            style={({ pressed }) => [styles.playBtn, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={playing ? '暫停' : '播放'}
          >
            {playing ? <PauseIcon size={20} color={C.bg} /> : <PlayIcon size={22} color={C.bg} />}
          </Pressable>

          <Pressable
            onPress={onForward30}
            style={({ pressed }) => [styles.skipBtn, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="快轉 30 秒"
          >
            <SkipIcon seconds={30} direction="forward" size={28} color={C.dim} />
          </Pressable>
        </View>

        <VolumeSlider value={volume} onChange={onVolumeChange} style={styles.volume} />

        <View style={styles.heroFoot}>
          <Pressable
            onPress={onOpenTranscript}
            hitSlop={8}
            style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="打開逐字稿"
          >
            <Text style={styles.pillText}>逐字稿</Text>
          </Pressable>
          <Text style={styles.loadState} numberOfLines={1}>
            {loadState ?? ''}
          </Text>
          <Pressable
            onPress={onCycleRate}
            hitSlop={8}
            style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`播放速度 ${rate} 倍，點擊切換`}
          >
            <Text style={styles.pillText}>{rate}x</Text>
          </Pressable>
        </View>
      </Glass>

      {/* ── (b) 今日練習 ＋ (d) 連續天數 ─────────────────────────────────── */}
      <View style={[styles.row2, { height: compact ? 96 : 112 }]}>
        <Pressable
          onPress={practiceBadge === 0 ? goBrowse : goPractice}
          style={({ pressed }) => [styles.row2Practice, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={
            practiceBadge === 0 ? '今天沒有待練的，去聽一集' : `今日練習，${practiceBadge} 張待練`
          }
        >
          {/* 綠暈：練習就是「學習者動手了」，這塊面板憑語意賺得到綠色。 */}
          <Glass radius={R.lg} bloom="accent" style={styles.tile}>
            {practiceBadge === 0 ? (
              <>
                <Text style={styles.tileEmptyTitle}>今天沒有待練的</Text>
                <Text style={styles.tileLabel}>去聽一集</Text>
              </>
            ) : (
              <>
                <Text style={styles.tileValue}>{practiceBadge}</Text>
                <Text style={styles.tileLabel}>待練</Text>
              </>
            )}
          </Glass>
        </Pressable>

        {/* 連續天數沒有可去的地方，所以不可點——把不會動的東西做成按鈕只會消耗信任。
            這塊沒有語意可用（它講的是紀律，不是那三個訊號階段），所以不放 bloom。 */}
        <Glass radius={R.lg} style={[styles.tile, styles.row2Streak]}>
          <Text style={styles.tileValue}>{streak}</Text>
          <Text style={styles.tileLabel}>連續天數</Text>
          <View style={styles.dots}>
            {weekDots.map((done, i) => (
              <View key={i} style={[styles.dot, done ? styles.dotOn : styles.dotOff]} />
            ))}
          </View>
        </Glass>
      </View>

      {/* ── (c) 本週訊號環 ───────────────────────────────────────────────── */}
      <Glass radius={R.lg} bloom="accent" bloomCorner="bottomLeft" style={styles.signal}>
        <SignalRing
          rewinds={signal.rewinds}
          confirmed={signal.confirmed}
          mastered={signal.mastered}
          size={92}
        />
        <View style={styles.legend}>
          {/* 圖例的三顆點與環上的三段共用 RAMP：同色相、不同濃度，讀起來才是
              同一件事的三個階段，而不是三種不同的東西。 */}
          <LegendRow color={RAMP.accentWeak} label="重聽" value={signal.rewinds} />
          <LegendRow color={RAMP.accentMid} label="確認" value={signal.confirmed} />
          <LegendRow color={RAMP.accentFull} label="掌握" value={signal.mastered} />
        </View>
      </Glass>

      {/* ── (e) 難點詞庫 ─────────────────────────────────────────────────── */}
      <Glass radius={R.lg} style={styles.vocab}>
        <Text style={styles.vocabHeading}>難點詞庫</Text>
        {chips.length === 0 ? (
          <Text style={styles.vocabEmpty}>在逐字稿裡圈出聽不懂的字，會出現在這裡</Text>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            {chips.map((c) => (
              <Chip key={c.id} capture={c} onPress={goPractice} />
            ))}
          </ScrollView>
        )}
      </Glass>

      <Text style={styles.sectionTitle}>探索</Text>
    </View>
  );

  const footer = exhausted ? (
    <Glass radius={R.lg} style={styles.endCard}>
      <Text style={styles.endText}>訂閱更多節目，這裡就會一直長下去</Text>
      <Pressable
        onPress={goBrowse}
        style={({ pressed }) => [styles.endBtn, pressed && styles.pressed]}
        accessibilityRole="button"
      >
        <Text style={styles.endBtnText}>去探索</Text>
      </Pressable>
    </Glass>
  ) : null;

  return (
    <MasonryList
      data={visible}
      keyExtractor={keyExtractor}
      itemHeight={itemHeight}
      renderItem={({ item, width }) => (
        <EpisodeCard
          episode={item}
          width={width}
          active={item.id === episode.id}
          onPress={selectEpisode}
        />
      )}
      columns={2}
      gap={GAP}
      onEndReached={onEndReached}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      contentContainerStyle={styles.listContent}
    />
  );
}

// ---------------------------------------------------------------------------
// 小元件
// ---------------------------------------------------------------------------

function LegendRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <View style={styles.legendRow}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
      <Text style={styles.legendValue}>{value}</Text>
    </View>
  );
}

function Chip({ capture, onPress }: { capture: Capture; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => pressed && styles.pressed}
      accessibilityRole="button"
      accessibilityLabel={`練習 ${capture.selection_text}`}
    >
      <Glass radius={R.pill} style={styles.chip}>
        {/* 綠色半透明底＝學習者親手圈出來的那幾個字。從 top:1 開始，把 Glass 的
            上緣高光留出來。 */}
        <View pointerEvents="none" style={styles.chipTint} />
        <View
          style={[
            styles.chipDot,
            capture.selection_kind === 'grammar' ? styles.chipDotGrammar : styles.chipDotVocab,
          ]}
        />
        <Text style={styles.chipText} numberOfLines={1}>
          {capture.selection_text}
        </Text>
      </Glass>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// 本週訊號
// ---------------------------------------------------------------------------

/** 練過至少兩次、且下一次複習排到三天以後 ＝ 不再是今天還在打轉的卡。 */
const MASTERED_MIN_REPS = 2;
const MASTERED_MIN_INTERVAL_DAYS = 3;

/**
 * 近 7 天（含今天）的訊號漏斗。搬到 lib/stats.ts 是下一輪的事——這一輪 stats.ts
 * 不屬於任何人，平行改同一支檔案只會互相覆蓋。
 *
 * ⚠️ `rewinds` 是「**重聽段落數**」而不是「按鍵次數」：captureEngine 會把同一段的
 * 多次倒帶合併成一筆 capture。UI 文案寫「重聽」就好，但這個落差要記著，別拿它去
 * 對「今天 N 次重聽」那個數字。
 *
 * ⚠️ **框選來的 capture 不進這個漏斗**（見 inWeek 的第一道過濾）。這是全 app 最顯眼
 * 的訊號視覺化，而產品論點就是「這些數字是真的」——把沒發生過的重聽算進來，
 * 論點當場失效。
 *
 * ⚠️ **絕對不能改用 ReplayEvent 算。** lib/replay.ts 的事件從不寫進 store，只活在
 * App.tsx 的 useState，重開 app 就歸零——任何基於它的「本週」數字都會在冷啟動後變 0。
 *
 * 三個數字保證 mastered ≤ confirmed ≤ rewinds：它們是同一組 capture 逐層過濾出來的，
 * 分開統計遲早會出現「掌握比重聽還多」這種不可能的畫面。
 */
function computeWeekSignal(
  captures: Capture[],
  srs: SrsItem[],
  now: Date = new Date(),
): { rewinds: number; confirmed: number; mastered: number } {
  const from = addDaysStr(-6, now);
  const to = todayStr(now);

  const inWeek = captures.filter((c) => {
    // 框選（strength 'selected'）**整條漏斗都不算**。它不 seek、不 pause，是唯一
    // 不伴隨播放位置變動的來源（ADR-0017），所以它背後的重聽次數是 0——一次都沒按
    // ↺15、只圈了五個片語的人，環中央不該寫「5 重聽」。App.tsx:448 為同一個理由把
    // 'select' 擋在 events 之外，這個漏斗只是把那條規則補齊。
    //
    // 只從 rewinds 扣掉不行：框選天生 confirmed，留在確認那一段會做出「確認 > 重聽」
    // 的環，底下保證的層層包含關係就破了。框選自己有難點詞庫那一塊在呈現。
    if (c.strength === 'selected') return false;
    // created_at 是 UTC ISO，一定要轉成**當地**日字串才對得上 srs.ts 的日界線；
    // 直接切字串會讓半夜的 capture 落到隔天。
    const day = toDateStr(new Date(c.created_at));
    return day >= from && day <= to;
  });

  const confirmed = inWeek.filter(
    (c) => c.status === 'confirmed' || c.status === 'practiced',
  );

  const srsByCapture = new Map(srs.map((i) => [i.capture_id, i]));
  const mastered = confirmed.filter((c) => {
    const item = srsByCapture.get(c.id);
    return (
      !!item &&
      item.reps >= MASTERED_MIN_REPS &&
      item.interval_days >= MASTERED_MIN_INTERVAL_DAYS
    );
  });

  return { rewinds: inWeek.length, confirmed: confirmed.length, mastered: mastered.length };
}

const styles = StyleSheet.create({
  // 左右留白由 App.styles.screen 的 paddingHorizontal 提供，這裡不准再加。
  listContent: { paddingBottom: SP(24) },

  // —— (a) 正在播放 ——
  hero: { padding: SP(4) },
  // 四個邊明寫（RN 0.86 已移除 absoluteFillObject，spread undefined 不報錯只會靜靜
  // 少掉 position:'absolute'）。
  heroWash: { position: 'absolute', top: 1, left: 0, right: 0, bottom: 0 },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: SP(3.5) },
  heroMeta: { flex: 1, gap: SP(1) },
  heroTitle: { ...TYPE.heading, color: C.text },
  heroShow: { ...TYPE.caption, color: C.dim, fontWeight: '400' },

  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: GLASS.well,
    overflow: 'hidden',
    marginTop: SP(4),
  },
  progressFill: { height: '100%', backgroundColor: C.primary },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: SP(1.5) },
  // 玻璃上的次要文字一律 C.dim（C.faint 的對比只對 bg / surface 實算過）。
  time: { ...TYPE.mono, color: C.dim, fontWeight: '400' },

  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SP(7),
    marginTop: SP(3),
  },
  skipBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  playBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: C.text,
    alignItems: 'center',
    justifyContent: 'center',
  },

  volume: { marginTop: SP(1) },

  heroFoot: { flexDirection: 'row', alignItems: 'center', gap: SP(3), marginTop: SP(2) },
  pill: {
    paddingHorizontal: SP(3),
    paddingVertical: SP(1.5),
    borderRadius: R.pill,
    backgroundColor: GLASS.fill,
  },
  pillText: { ...TYPE.caption, color: C.dim },
  loadState: { ...TYPE.caption, color: C.dim, fontWeight: '400', flex: 1, textAlign: 'right' },

  // —— (b)(d) ——
  row2: { flexDirection: 'row', gap: GAP, marginTop: GAP },
  row2Practice: { flex: 62 },
  row2Streak: { flex: 38 },
  tile: { flex: 1, padding: SP(3.5), justifyContent: 'center' },
  tileValue: { ...TYPE.title, fontSize: 32, lineHeight: 38, color: C.text },
  tileEmptyTitle: { ...TYPE.heading, color: C.text },
  tileLabel: { ...TYPE.caption, color: C.dim, fontWeight: '400', marginTop: SP(0.5) },
  dots: { flexDirection: 'row', gap: SP(1), marginTop: SP(2) },
  dot: { width: 4, height: 4, borderRadius: 2 },
  dotOn: { backgroundColor: C.accent },
  dotOff: { backgroundColor: GLASS.well },

  // —— (c) ——
  signal: {
    height: 148,
    padding: SP(4),
    marginTop: GAP,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP(4),
  },
  legend: { flex: 1, gap: SP(2) },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: SP(2) },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { ...TYPE.caption, color: C.dim, fontWeight: '400', flex: 1 },
  legendValue: { ...TYPE.caption, color: C.text, fontSize: 14 },

  // —— (e) ——
  // 右側刻意不留內距：晶片要能捲出面板邊緣，那條被切斷的邊就是「還有更多」。
  vocab: { minHeight: 96, paddingVertical: SP(3), paddingLeft: SP(3), marginTop: GAP },
  vocabHeading: { ...TYPE.caption, color: C.dim },
  vocabEmpty: { ...TYPE.caption, color: C.dim, fontWeight: '400', marginTop: SP(3) },
  chipRow: { flexDirection: 'row', gap: SP(2), paddingRight: SP(3), marginTop: SP(3) },
  chip: {
    height: 34,
    paddingHorizontal: SP(3),
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP(2),
  },
  chipTint: {
    position: 'absolute',
    top: 1,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: C.accentSurface,
  },
  chipDot: { width: 3, height: 3, borderRadius: 1.5 },
  chipDotVocab: { backgroundColor: C.accent },
  chipDotGrammar: { backgroundColor: C.primary },
  chipText: { ...TYPE.caption, color: C.text, fontWeight: '400' },

  // —— (f) ——
  sectionTitle: { ...TYPE.heading, color: C.text, marginTop: SP(5), marginBottom: SP(3) },
  cardPress: { flex: 1 },
  card: { flex: 1 },
  cardActive: { borderColor: C.primary },
  cardText: { paddingHorizontal: SP(2), paddingTop: SP(2), gap: SP(1) },
  cardTitle: { ...TYPE.caption, fontSize: 13, lineHeight: 17, color: C.text },
  cardMeta: { ...TYPE.caption, color: C.dim, fontWeight: '400' },

  endCard: { padding: SP(4), alignItems: 'center', gap: SP(3), marginTop: GAP },
  endText: { ...TYPE.caption, color: C.dim, fontWeight: '400', textAlign: 'center' },
  // 綠色按鈕維持實色：accentInk 的 9.7:1 是對實色 accent 算的，玻璃只用在容器層。
  endBtn: {
    paddingHorizontal: SP(5),
    paddingVertical: SP(2.5),
    borderRadius: R.pill,
    backgroundColor: C.accent,
  },
  endBtnText: { ...TYPE.caption, color: C.accentInk },

  pressed: { opacity: 0.6 },
});
