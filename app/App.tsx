import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  FlatList,
  LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from 'expo-audio';
import * as Notifications from 'expo-notifications';

import PodcastBrowser from './components/PodcastBrowser';
import { DEMO_EPISODES, Episode } from './lib/episodes';
import { isSupabaseConfigured } from './lib/supabase';
import { makeReplayEvent, ReplayEvent, syncReplayEvent } from './lib/replay';
import { ingestReplayEvent, noteRateChange } from './lib/captureEngine';
import {
  getCaptures,
  getSrsItems,
  initStore,
  rememberEpisode,
  subscribe,
} from './lib/store';
import { isDue, toDateStr, todayStr } from './lib/srs';
import { syncDailyReminder } from './lib/notifications';
import PracticeScreen from './screens/Practice';

const BACK_SECONDS = 15;
const FORWARD_SECONDS = 30;
const RATES = [1, 0.85, 0.7] as const;

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.floor(totalSeconds);
  const m = Math.floor(s / 60);
  const sec = (s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export default function App() {
  const [tab, setTab] = useState<'player' | 'practice'>('player');
  const [practiceBadge, setPracticeBadge] = useState(0);
  const [episode, setEpisode] = useState<Episode>(DEMO_EPISODES[0]);
  const [rateIndex, setRateIndex] = useState(0);
  const [events, setEvents] = useState<ReplayEvent[]>([]);
  const [barWidth, setBarWidth] = useState(0);

  // source 恆為 null → useAudioPlayer 內部的 useReleasingSharedObject dep
  // (JSON.stringify(source)) 恆定，player 實例永不重建。單集載入（初始與
  // 換集）統一走下面的 useEffect：player.replace() + setPlaybackRate()。
  // 若把 {uri} 直接傳進 hook，換集會 release 舊實例並以 1.0x 重建新實例，
  // 造成 UI 顯示的速度與實際播放速度脫鉤。
  const player = useAudioPlayer(null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  // 防禦性：事件監聽器（如通知回應）一律經 ref 拿 player，即使未來實例
  // 重建也不會對已 released 的物件呼叫方法。
  const playerRef = useRef(player);
  useEffect(() => {
    playerRef.current = player;
  }, [player]);

  const rate = RATES[rateIndex];
  const duration =
    status.duration && status.duration > 0 ? status.duration : episode.durationSec;
  const currentTime = status.currentTime ?? 0;
  const progress = duration > 0 ? Math.min(currentTime / duration, 1) : 0;

  // iOS: keep playing with the mute switch on; don't mix with other audio.
  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
      shouldPlayInBackground: true,
    }).catch((err) => console.warn('[audio] setAudioModeAsync failed:', err));
  }, []);

  // 單集載入：初始集與換集一律走這裡（player 實例穩定，replace 不重建），
  // 並重新套用使用者目前選的播放速度。
  useEffect(() => {
    player.replace({ uri: episode.audioUrl });
    player.setPlaybackRate(RATES[rateIndex], 'high');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode.id]);

  // Hydrate the local store and keep the practice-tab badge in sync
  // (badge = 正式佇列數：昨天以前的 pending + confirmed 但沒評分過的孤兒卡
  // + 到期 SRS 複習；今天剛抓的 pending 不算——收在練習頁的「搶先練」)。
  // 規則與 Practice.tsx 的佇列建構一致。
  useEffect(() => {
    const computeBadge = () => {
      const today = todayStr();
      const captures = getCaptures();
      const pendingAll = captures.filter((c) => c.status === 'pending');
      const pendingIds = new Set(pendingAll.map((c) => c.id));
      const officialPending = pendingAll.filter(
        (c) => toDateStr(new Date(c.created_at)) < today,
      ).length;
      const srsItems = getSrsItems();
      const srsIds = new Set(srsItems.map((i) => i.capture_id));
      // 上次按了「真的沒聽懂」但沒評分就離開的卡（confirmed 且無 SRS item）
      const orphanConfirmed = captures.filter(
        (c) => c.status === 'confirmed' && !srsIds.has(c.id),
      ).length;
      const dueReviews = srsItems.filter(
        (i) => isDue(i) && !pendingIds.has(i.capture_id),
      ).length;
      setPracticeBadge(officialPending + orphanConfirmed + dueReviews);
    };
    void initStore().then(() => {
      computeBadge();
      void syncDailyReminder(); // app 開啟時重排（冪等，內部已去重）
    });
    const unsubscribe = subscribe(computeBadge);
    // 跨午夜回前景時日界線變了 → 重算 badge（今天的 pending 變成昨天的）。
    const appStateSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') computeBadge();
    });
    return () => {
      unsubscribe();
      appStateSub.remove();
    };
  }, []);

  // 點每日提醒 → 直接落在練習頁（player 經 ref 取用，避免閉包抓住舊實例）
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = Notifications.addNotificationResponseReceivedListener(() => {
      playerRef.current.pause();
      setTab('practice');
    });
    return () => sub.remove();
  }, []);

  // Core loop: record every backward seek as a replay_event AND feed it to
  // the capture engine (headphone/lockscreen sources will reuse this exact
  // path once the dev build lands — only triggerSource changes).
  const logReplayEvent = (fromPos: number, toPos: number) => {
    const event = makeReplayEvent({
      episodeId: episode.id,
      fromPos,
      toPos,
      playbackRate: rate,
      triggerSource: 'screen',
    });
    setEvents((prev) => [event, ...prev]);
    ingestReplayEvent({
      episodeId: episode.id,
      fromPos,
      toPos,
      durationSec: duration,
    });
    void syncReplayEvent(event).then((synced) => {
      if (synced) {
        setEvents((prev) =>
          prev.map((e) => (e.local_id === event.local_id ? { ...e, synced: true } : e)),
        );
      }
    });
  };

  const togglePlay = () => {
    if (status.playing) player.pause();
    else player.play();
  };

  const back15 = () => {
    const from = currentTime;
    const to = Math.max(0, from - BACK_SECONDS);
    void player.seekTo(to);
    logReplayEvent(from, to);
  };

  const forward30 = () => {
    void player.seekTo(Math.min(duration, currentTime + FORWARD_SECONDS));
  };

  const cycleRate = () => {
    const next = (rateIndex + 1) % RATES.length;
    setRateIndex(next);
    player.setPlaybackRate(RATES[next], 'high');
    // Slowing down ≤10s after a rewind upgrades that capture to 'strong'.
    noteRateChange(episode.id, RATES[next], rate);
  };

  const switchTab = (next: 'player' | 'practice') => {
    if (next === tab) return;
    if (next === 'practice') player.pause(); // 練習時不跟主播放器搶聲音
    setTab(next);
  };

  const selectEpisode = (ep: Episode) => {
    if (ep.id === episode.id) return;
    // 快照進 episodeIndex + best-effort Supabase episodes upsert（replay_events
    // FK 先行）。DEMO 集也記——冪等且讓 episodes 列存在。
    rememberEpisode(ep);
    player.pause();
    setEpisode(ep); // replace + setPlaybackRate 由 useEffect([episode.id]) 統一處理
  };

  const onBarLayout = (e: LayoutChangeEvent) => setBarWidth(e.nativeEvent.layout.width);

  // Tap-to-seek on the progress bar. A backward scrub is also a replay signal.
  const onBarPress = (locationX: number) => {
    if (barWidth <= 0 || duration <= 0) return;
    const target = Math.max(0, Math.min(1, locationX / barWidth)) * duration;
    const from = currentTime;
    void player.seekTo(target);
    if (target < from - 1) logReplayEvent(from, target);
  };

  const todayCount = useMemo(() => {
    const today = new Date().toDateString();
    return events.filter((e) => new Date(e.created_at).toDateString() === today).length;
  }, [events]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.logo}>Echo</Text>
        <View
          style={[
            styles.badge,
            isSupabaseConfigured ? styles.badgeOn : styles.badgeOff,
          ]}
        >
          <Text style={styles.badgeText}>
            {isSupabaseConfigured ? 'Supabase 已連線' : '本地模式（未設 Supabase）'}
          </Text>
        </View>
      </View>

      {/* Tabs：播放器｜今日練習（state 切換，不用 navigation） */}
      <View style={styles.tabRow}>
        <Pressable
          onPress={() => switchTab('player')}
          style={[styles.tabBtn, tab === 'player' && styles.tabBtnActive]}
        >
          <Text
            style={[styles.tabText, tab === 'player' && styles.tabTextActive]}
          >
            播放器
          </Text>
        </Pressable>
        <Pressable
          onPress={() => switchTab('practice')}
          style={[styles.tabBtn, tab === 'practice' && styles.tabBtnActive]}
        >
          <Text
            style={[styles.tabText, tab === 'practice' && styles.tabTextActive]}
          >
            今日練習
          </Text>
          {practiceBadge > 0 && (
            <View style={styles.tabBadge}>
              <Text style={styles.tabBadgeText}>{practiceBadge}</Text>
            </View>
          )}
        </Pressable>
      </View>

      {tab === 'practice' ? (
        <PracticeScreen />
      ) : (
        <>
      {/* Podcast 搜尋 / 訂閱 / 單集清單 */}
      <PodcastBrowser selectedEpisodeId={episode.id} onSelectEpisode={selectEpisode} />

      {/* Now playing */}
      <Text style={styles.nowPlayingPodcast} numberOfLines={1}>
        {episode.podcast}
      </Text>
      <Text style={styles.nowPlaying} numberOfLines={2}>
        {episode.title}
      </Text>
      <Text style={styles.loadState}>
        {status.isLoaded ? (status.isBuffering ? '緩衝中…' : ' ') : '載入音檔中…'}
      </Text>

      {/* Progress */}
      <Pressable
        onLayout={onBarLayout}
        onPress={(e) => onBarPress(e.nativeEvent.locationX)}
        style={styles.barTouch}
        hitSlop={8}
      >
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${progress * 100}%` }]} />
        </View>
      </Pressable>
      <View style={styles.timeRow}>
        <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
        <Text style={styles.timeText}>{formatTime(duration)}</Text>
      </View>

      {/* Transport */}
      <View style={styles.transportRow}>
        <Pressable
          onPress={back15}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <Text style={styles.backButtonText}>↺15</Text>
          <Text style={styles.backButtonSub}>Back</Text>
        </Pressable>

        <Pressable
          onPress={togglePlay}
          style={({ pressed }) => [styles.playButton, pressed && styles.pressed]}
        >
          <Text style={styles.playButtonText}>{status.playing ? '❚❚' : '▶'}</Text>
        </Pressable>

        <Pressable
          onPress={forward30}
          style={({ pressed }) => [styles.fwdButton, pressed && styles.pressed]}
        >
          <Text style={styles.fwdButtonText}>30↻</Text>
        </Pressable>
      </View>

      {/* Rate */}
      <Pressable
        onPress={cycleRate}
        style={({ pressed }) => [styles.rateButton, pressed && styles.pressed]}
      >
        <Text style={styles.rateButtonText}>速度 {rate}x</Text>
      </Pressable>

      {/* Replay events */}
      <View style={styles.eventsHeader}>
        <Text style={styles.eventsTitle}>今日 Replay 事件</Text>
        <Text style={styles.eventsCount}>{todayCount}</Text>
      </View>
      <FlatList
        style={styles.eventsList}
        data={events}
        keyExtractor={(e) => e.local_id}
        ListEmptyComponent={
          <Text style={styles.eventsEmpty}>
            還沒有事件——按上面的「↺15」試試，每一次重聽都是訊號。
          </Text>
        }
        renderItem={({ item }) => (
          <View style={styles.eventRow}>
            <Text style={styles.eventTime}>{formatClock(item.created_at)}</Text>
            <Text style={styles.eventDetail}>
              {formatTime(item.from_pos)} → {formatTime(item.to_pos)} ·{' '}
              {item.playback_rate}x · {item.trigger_source}
            </Text>
            <Text
              style={[
                styles.eventSync,
                item.synced ? styles.eventSyncOn : styles.eventSyncOff,
              ]}
            >
              {item.synced ? '☁︎' : '⌁'}
            </Text>
          </View>
        )}
      />
        </>
      )}
    </View>
  );
}

const C = {
  bg: '#0C1117',
  card: '#161D26',
  cardSelected: '#1E2A38',
  border: '#243244',
  text: '#E8EDF4',
  dim: '#8A97A8',
  accent: '#4ADE80',
  accentDark: '#14532D',
  primary: '#3B82F6',
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 48 : 64,
    paddingBottom: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logo: { color: C.text, fontSize: 28, fontWeight: '800', letterSpacing: 1 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  badgeOn: { backgroundColor: C.accentDark },
  badgeOff: { backgroundColor: C.card },
  badgeText: { color: C.dim, fontSize: 11 },

  tabRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
    backgroundColor: C.card,
    borderRadius: 12,
    padding: 4,
    borderWidth: 1,
    borderColor: C.border,
  },
  tabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 9,
    paddingVertical: 10,
  },
  tabBtnActive: { backgroundColor: C.cardSelected },
  tabText: { color: C.dim, fontSize: 15, fontWeight: '700' },
  tabTextActive: { color: C.text },
  tabBadge: {
    backgroundColor: C.accent,
    borderRadius: 999,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  tabBadgeText: { color: '#06220F', fontSize: 12, fontWeight: '800' },

  nowPlayingPodcast: { color: C.dim, fontSize: 11, marginTop: 20 },
  nowPlaying: { color: C.text, fontSize: 18, fontWeight: '700', marginTop: 2 },
  loadState: { color: C.dim, fontSize: 12, marginTop: 4, minHeight: 16 },

  barTouch: { marginTop: 8, paddingVertical: 8 },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: C.card, overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: C.primary },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  timeText: { color: C.dim, fontSize: 12, fontVariant: ['tabular-nums'] },

  transportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 20,
  },
  backButton: {
    width: 108,
    height: 108,
    borderRadius: 54,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: { color: '#06220F', fontSize: 30, fontWeight: '800' },
  backButtonSub: { color: '#06220F', fontSize: 12, fontWeight: '700', marginTop: 2 },
  playButton: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButtonText: { color: C.text, fontSize: 30 },
  fwdButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fwdButtonText: { color: C.text, fontSize: 18, fontWeight: '700' },
  pressed: { opacity: 0.7, transform: [{ scale: 0.97 }] },

  rateButton: {
    alignSelf: 'center',
    marginTop: 16,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 999,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  rateButtonText: { color: C.text, fontSize: 16, fontWeight: '700' },

  eventsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 24,
    marginBottom: 8,
  },
  eventsTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  eventsCount: { color: C.accent, fontSize: 15, fontWeight: '800' },
  eventsList: { flex: 1 },
  eventsEmpty: { color: C.dim, fontSize: 13, lineHeight: 20, marginTop: 8 },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.card,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
    gap: 10,
  },
  eventTime: { color: C.dim, fontSize: 12, fontVariant: ['tabular-nums'] },
  eventDetail: { color: C.text, fontSize: 13, flex: 1 },
  eventSync: { fontSize: 14 },
  eventSyncOn: { color: C.accent },
  eventSyncOff: { color: C.dim },
});
