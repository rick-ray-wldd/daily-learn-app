/**
 * 常駐的迷你播放器，浮在底部分頁列上方（Apple Podcasts 的作法）。
 *
 * 它解掉的是一個結構問題：以前「播放器」本身就是首頁，探索清單塞在播放器裡面，
 * 所以在聽東西的時候沒有「回主頁」這件事可做，逐字稿也只能分到剩下的空間。把
 * 播放狀態收進這一條之後，探索與練習各自拿到整個畫面，播放器改成往上升起。
 *
 * ↺15 放在這裡是刻意的：它是產品的核心手勢（CONTEXT.md §1），使用者在探索頁
 * 逛清單時聽到聽不懂的一句，應該當場就能倒帶，不必先把播放器叫出來。
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import Artwork from './Artwork';
import { PauseIcon, PlayIcon, SkipIcon } from './Glyph';
import { Episode } from '../lib/episodes';
import { C, R, SP, TYPE } from '../lib/theme';

const BACK_SECONDS = 15;

interface Props {
  episode: Episode;
  positionSec: number;
  durationSec: number;
  playing: boolean;
  onOpen: () => void;
  onTogglePlay: () => void;
  onBack15: () => void;
}

export default function MiniPlayer({
  episode,
  positionSec,
  durationSec,
  playing,
  onOpen,
  onTogglePlay,
  onBack15,
}: Props) {
  const progress = durationSec > 0 ? Math.min(positionSec / durationSec, 1) : 0;

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onOpen}
        style={({ pressed }) => [styles.bar, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`開啟播放器：${episode.title}`}
      >
        <Artwork episode={episode} size={40} radius={R.sm} />

        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {episode.title}
          </Text>
          <Text style={styles.show} numberOfLines={1}>
            {episode.podcast}
          </Text>
        </View>

        {/* 按鈕自己吃掉觸控，不會連帶把播放器叫起來 */}
        <Pressable
          onPress={onBack15}
          hitSlop={8}
          style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="重聽 15 秒"
        >
          <SkipIcon seconds={BACK_SECONDS} direction="back" size={24} color={C.accent} />
        </Pressable>

        <Pressable
          onPress={onTogglePlay}
          hitSlop={8}
          style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={playing ? '暫停' : '播放'}
        >
          {playing ? (
            <PauseIcon size={17} color={C.text} />
          ) : (
            <PlayIcon size={18} color={C.text} />
          )}
        </Pressable>
      </Pressable>

      {/* 進度是一條貼著底緣的細線——迷你播放器不需要可拖曳的進度條，
          那是升起後的播放器該做的事。 */}
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${progress * 100}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: SP(3),
    borderRadius: R.lg,
    backgroundColor: C.surfaceAlt,
    overflow: 'hidden',
    // 浮起來一層，才看得出它疊在內容上面而不是版面的一部分。
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP(3),
    paddingHorizontal: SP(2.5),
    paddingVertical: SP(2),
  },
  text: { flex: 1 },
  title: { ...TYPE.caption, fontSize: 13, color: C.text },
  show: { ...TYPE.caption, color: C.faint, fontWeight: '400', marginTop: 1 },
  btn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  track: { height: 2, backgroundColor: C.border },
  fill: { height: '100%', backgroundColor: C.primary },
  pressed: { opacity: 0.7 },
});
