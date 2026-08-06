/**
 * 全螢幕播放器，由 mini player 往上升起。
 *
 * 從 App.tsx 搬出來的原因不只是檔案長度：以前播放器**就是**首頁，探索清單是它的
 * 一部分，所以「聽東西」與「找東西」永遠在搶同一塊垂直空間。拆開之後兩邊都拿到
 * 整個畫面，這裡也才有餘裕把封面放大、控制項拉開。
 *
 * 拖曳中的位置（scrubSec）是這個元件的本地狀態，不上送：手指經過的每個位置都可能
 * 觸發一個 10 分鐘窗口的 Whisper 轉錄（真的要錢），放開手才算數。App 那邊的
 * positionSec 仍然是「現在聽到哪裡」的唯一權威值。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import Artwork, { ART_MIN_SIZE } from './Artwork';
import { Chevron, PauseIcon, PlayIcon, SkipIcon, TranscriptIcon } from './Glyph';
import { Episode } from '../lib/episodes';
import { getSegments } from '../lib/transcript';
import { C, R, SP, TYPE } from '../lib/theme';

const BACK_SECONDS = 15;
const FORWARD_SECONDS = 30;

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.floor(totalSeconds);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

interface Props {
  episode: Episode;
  positionSec: number;
  durationSec: number;
  playing: boolean;
  rate: number;
  todayCount: number;
  loadState: string | null;
  onClose: () => void;
  onTogglePlay: () => void;
  onBack15: () => void;
  onForward30: () => void;
  onCycleRate: () => void;
  /** 唯一的 seek 入口；isRewind 決定要不要記成 replay event（ADR-0003）。 */
  onSeek: (toSec: number, isRewind: boolean) => void;
  onOpenTranscript: () => void;
}

export default function NowPlaying({
  episode,
  positionSec,
  durationSec,
  playing,
  rate,
  todayCount,
  loadState,
  onClose,
  onTogglePlay,
  onBack15,
  onForward30,
  onCycleRate,
  onSeek,
  onOpenTranscript,
}: Props) {
  const { width, height } = useWindowDimensions();
  const [scrubSec, setScrubSec] = useState<number | null>(null);

  // 封面吃掉寬度與高度中較保守的那個，小螢幕上不會把控制項擠出畫面。
  const artSize = Math.floor(Math.min(width - SP(16), height * 0.36));
  const showArt = artSize >= ART_MIN_SIZE;

  const displaySec = scrubSec ?? positionSec;
  const progress = durationSec > 0 ? Math.min(displaySec / durationSec, 1) : 0;

  // --- Scrubber -------------------------------------------------------------
  // PanResponder 只建立一次（重建會讓拖曳中途斷手），所以它看到的所有會變的值
  // 一律走 ref —— 直接閉包會永遠讀到第一次 render 的 duration / 寬度。
  const barWidthRef = useRef(0);
  const durationRef = useRef(durationSec);
  const positionRef = useRef(positionSec);
  const scrubStartRef = useRef(0);
  const commitScrubRef = useRef<(sec: number) => void>(() => {});

  const secAtX = (x: number) => {
    const w = barWidthRef.current;
    const d = durationRef.current;
    if (w <= 0 || d <= 0) return 0;
    return Math.max(0, Math.min(1, x / w)) * d;
  };

  // 往回拖與按 ↺15 是同一個領域事件，走同一條 onSeek（ADR-0003：只有一條
  // replay-event pipeline）。1 秒寬容度避免手抖被記成重聽。
  const commitScrub = (target: number) => {
    setScrubSec(null);
    if (barWidthRef.current <= 0 || durationRef.current <= 0) return;
    onSeek(target, target < positionRef.current - 1);
  };

  useEffect(() => {
    durationRef.current = durationSec;
    positionRef.current = positionSec;
    commitScrubRef.current = commitScrub;
  });

  const scrubResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // 拿到手勢就不放：底下的內容不該在拖曳中途把進度條搶走。
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          scrubStartRef.current = e.nativeEvent.locationX;
          setScrubSec(secAtX(scrubStartRef.current));
        },
        onPanResponderMove: (_e, gesture) => {
          // 用「按下的點 + dx」而不是移動中的 locationX：後者是相對於當下被命中的
          // 子 view，手指滑出進度條範圍時座標會突然跳掉。
          setScrubSec(secAtX(scrubStartRef.current + gesture.dx));
        },
        onPanResponderRelease: (_e, gesture) => {
          commitScrubRef.current(secAtX(scrubStartRef.current + gesture.dx));
        },
        // 被系統打斷（來電、手勢衝突）：放棄這次拖曳，不要送出半途的 seek。
        onPanResponderTerminate: () => setScrubSec(null),
      }),
    // 只讀 ref，不需要（也不可以）重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onBarLayout = (e: LayoutChangeEvent) => {
    barWidthRef.current = e.nativeEvent.layout.width;
  };

  // 目前這句：逐字稿入口不是一顆抽象按鈕，而是直接把正在唸的那句露出來。
  // 只讀 transcript.ts 手上現成的，不觸發任何轉錄——轉錄要等使用者真的打開。
  const peek = useMemo(() => {
    const segs = getSegments(episode.id);
    for (let i = segs.length - 1; i >= 0; i -= 1) {
      if (segs[i].start <= positionSec) {
        return positionSec < segs[i].end ? segs[i].text : null;
      }
    }
    return null;
  }, [episode.id, positionSec]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={onClose}
          hitSlop={12}
          style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="收起播放器"
        >
          <Chevron direction="down" size={12} color={C.text} weight={2.5} />
        </Pressable>
        <Text style={styles.headerLabel} numberOfLines={1}>
          {episode.podcast}
        </Text>
        {/* 佔位，讓中間的標題真的置中 */}
        <View style={styles.closeBtn} />
      </View>

      <View style={styles.stage}>
        {showArt && <Artwork episode={episode} size={artSize} shadow />}
      </View>

      <Text style={styles.title} numberOfLines={2}>
        {episode.title}
      </Text>
      <Text style={styles.show} numberOfLines={1}>
        {episode.podcast}
      </Text>

      <View style={styles.barTouch} onLayout={onBarLayout} {...scrubResponder.panHandlers}>
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${progress * 100}%` }]} />
        </View>
        {/* pointerEvents none 是必要的：拇指若吃得到觸控，從拇指上按下時 grant 的
            locationX 會變成「相對於拇指」，一按就跳到軌道最左邊。 */}
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
        <Text style={[styles.timeText, scrubSec !== null && styles.timeTextActive]}>
          {formatTime(displaySec)}
        </Text>
        <Text style={styles.timeText}>
          -{formatTime(Math.max(0, durationSec - displaySec))}
        </Text>
      </View>

      {/* Transport：↺15 是產品的核心手勢，永遠是版面上最大、唯一有顏色的鍵。 */}
      <View style={styles.transport}>
        <Pressable
          onPress={onBack15}
          style={({ pressed }) => [styles.skipBtn, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="重聽 15 秒"
        >
          <SkipIcon seconds={BACK_SECONDS} direction="back" size={42} color={C.accent} />
        </Pressable>

        <Pressable
          onPress={onTogglePlay}
          style={({ pressed }) => [styles.playBtn, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={playing ? '暫停' : '播放'}
        >
          {playing ? <PauseIcon size={26} color={C.bg} /> : <PlayIcon size={28} color={C.bg} />}
        </Pressable>

        <Pressable
          onPress={onForward30}
          style={({ pressed }) => [styles.skipBtn, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="快轉 30 秒"
        >
          <SkipIcon seconds={FORWARD_SECONDS} direction="forward" size={34} color={C.dim} />
        </Pressable>
      </View>

      {/* 逐字稿入口：直接顯示正在唸的那一句，點下去進全螢幕閱讀器。 */}
      <Pressable
        onPress={onOpenTranscript}
        style={({ pressed }) => [styles.peek, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="打開逐字稿"
      >
        <TranscriptIcon size={14} color={peek ? C.dim : C.faint} />
        <Text style={peek ? styles.peekText : styles.peekHint} numberOfLines={1}>
          {peek ?? '逐字稿'}
        </Text>
        <Chevron direction="up" size={8} color={C.faint} weight={1.8} />
      </Pressable>

      <View style={styles.footRow}>
        <Pressable
          onPress={onCycleRate}
          hitSlop={8}
          style={({ pressed }) => [styles.rateBtn, pressed && styles.pressed]}
        >
          <Text style={styles.rateText}>{rate}x</Text>
        </Pressable>
        <Text style={styles.footText}>今天 {todayCount} 次重聽</Text>
        <Text style={styles.footText}>{loadState ?? ''}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
    paddingHorizontal: SP(6),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP(3),
    paddingBottom: SP(2),
  },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerLabel: { ...TYPE.caption, color: C.dim, flex: 1, textAlign: 'center' },

  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 0 },

  title: { ...TYPE.heading, fontSize: 20, lineHeight: 26, color: C.text, marginTop: SP(6) },
  show: { ...TYPE.caption, color: C.dim, fontWeight: '400', marginTop: SP(1) },

  barTouch: { height: 30, justifyContent: 'center', marginTop: SP(5) },
  barTrack: { height: 5, borderRadius: 3, backgroundColor: C.border, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: C.primary },
  thumb: {
    position: 'absolute',
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: C.text,
    marginLeft: -6.5,
  },
  thumbActive: { transform: [{ scale: 1.4 }] },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -2 },
  timeText: { ...TYPE.mono, color: C.faint, fontWeight: '400' },
  timeTextActive: { color: C.text },

  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SP(9),
    marginTop: SP(5),
  },
  skipBtn: { width: 60, height: 60, alignItems: 'center', justifyContent: 'center' },
  playBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: C.text,
    alignItems: 'center',
    justifyContent: 'center',
  },

  peek: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP(3),
    marginTop: SP(6),
    paddingHorizontal: SP(4),
    paddingVertical: SP(3),
    backgroundColor: C.surface,
    borderRadius: R.lg,
  },
  peekText: { ...TYPE.caption, fontSize: 13, fontWeight: '400', color: C.text, flex: 1 },
  peekHint: { ...TYPE.caption, color: C.faint, fontWeight: '400', flex: 1 },

  footRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP(4),
    marginTop: SP(4),
    marginBottom: SP(4),
  },
  rateBtn: {
    paddingHorizontal: SP(3),
    paddingVertical: SP(1.5),
    borderRadius: R.pill,
    backgroundColor: C.surface,
  },
  rateText: { ...TYPE.caption, color: C.dim },
  footText: { ...TYPE.caption, color: C.faint, fontWeight: '400', flex: 1 },

  pressed: { opacity: 0.6 },
});
