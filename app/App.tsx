import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Image,
  LayoutChangeEvent,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from 'expo-audio';
import * as Notifications from 'expo-notifications';

import PodcastBrowser from './components/PodcastBrowser';
import TermSheet from './components/TermSheet';
import TranscriptPanel from './components/TranscriptPanel';
import UpdateStatus from './components/UpdateStatus';
import { Term } from './lib/annotate';
import { DEMO_EPISODES, Episode } from './lib/episodes';
import { ensureSession, isSupabaseConfigured } from './lib/supabase';
import { makeReplayEvent, ReplayEvent, syncReplayEvent } from './lib/replay';
import {
  ingestReplayEvent,
  noteRateChange,
  noteTranscriptOpen,
} from './lib/captureEngine';
import {
  getCaptures,
  getSrsItems,
  initStore,
  rememberEpisode,
  subscribe,
} from './lib/store';
import { isDue, toDateStr, todayStr } from './lib/srs';
import { syncDailyReminder } from './lib/notifications';
import { C, R, SP, TYPE } from './lib/theme';
import PracticeScreen from './screens/Practice';

const BACK_SECONDS = 15;
const FORWARD_SECONDS = 30;
const RATES = [1, 0.85, 0.7] as const;

const TABS = [
  { key: 'player', label: '播放器' },
  { key: 'practice', label: '今日練習' },
] as const;

/** 小於這個邊長的封面已經不是封面、只是裝飾 —— 改走縮圖列，把空間讓給控制項。 */
const ART_MIN_SIZE = 140;
/** 縮圖列裡的封面邊長。 */
const ART_THUMB_SIZE = 56;
/**
 * seekTo 之後畫面先停在目標值上，直到播放位置追到這麼近為止。
 * 沒有這段延遲，進度條會先彈回舊位置再跳到新位置（status 每 250ms 才更新一次）。
 */
const SEEK_SETTLE_SEC = 1.5;
/** ……或等這麼久還沒追上就放手（音檔尚未載入、seek 被拒）。 */
const SEEK_SETTLE_MS = 1500;

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.floor(totalSeconds);
  const m = Math.floor(s / 60);
  const sec = (s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

/** 右側顯示剩餘而非總長（Podcasts 的作法）：聽的人關心的是「還要多久」。 */
function formatRemaining(current: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '-0:00';
  return `-${formatTime(Math.max(0, total - current))}`;
}

/**
 * 由單集 id 推出的色相。同一集永遠是同一張替代封面 —— 使用者是靠圖在清單裡
 * 認集數的，全部畫成同一塊灰底方塊等於沒有封面。
 */
function hueFrom(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/** 單集封面：有圖用圖，沒有就畫一張認得出來的替代圖。 */
function Artwork({ episode, size }: { episode: Episode; size: number }) {
  const radius = size >= ART_MIN_SIZE ? R.xl : R.md;
  const hue = hueFrom(episode.id);
  const initial = episode.podcast.trim().charAt(0).toUpperCase() || '♪';

  return (
    // 陰影畫在外層、裁切在內層：同一個 View 既 overflow:hidden 又要投影，
    // 陰影會被自己的裁切一起剪掉。
    <View style={[styles.artShadow, { width: size, height: size, borderRadius: radius }]}>
      <View style={[styles.artClip, { borderRadius: radius }]}>
        {episode.artworkUrl ? (
          <Image source={{ uri: episode.artworkUrl }} style={styles.artFill} />
        ) : (
          <View
            style={[
              styles.artFill,
              styles.artPlaceholder,
              { backgroundColor: `hsl(${hue}, 38%, 26%)` },
            ]}
          >
            {/* 斜切的第二色塊 —— 專案沒有 gradient 套件，用一塊旋轉的實色頂替。 */}
            <View
              style={[
                styles.artWedge,
                {
                  backgroundColor: `hsl(${(hue + 42) % 360}, 44%, 17%)`,
                  width: size * 1.8,
                  height: size * 1.8,
                  left: -size * 0.4,
                  top: size * 0.52,
                },
              ]}
            />
            <Text style={[styles.artInitial, { fontSize: size * 0.34 }]}>{initial}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

export default function App() {
  const [tab, setTab] = useState<'player' | 'practice'>('player');
  const [practiceBadge, setPracticeBadge] = useState(0);
  const [episode, setEpisode] = useState<Episode>(DEMO_EPISODES[0]);
  const [rateIndex, setRateIndex] = useState(0);
  const [events, setEvents] = useState<ReplayEvent[]>([]);
  const [stageHeight, setStageHeight] = useState(0);
  /** 拖曳中的目標秒數（null = 沒在拖）。 */
  const [scrubSec, setScrubSec] = useState<number | null>(null);
  /** 已送出、還在等播放位置追上的 seek 目標。 */
  const [seekTarget, setSeekTarget] = useState<number | null>(null);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [activeTerm, setActiveTerm] = useState<Term | null>(null);

  const { width } = useWindowDimensions();

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

  // 進度條顯示的位置：拖曳中跟著手指，剛 seek 完跟著目標，其餘時間才是真實播放位置。
  const displaySec = scrubSec ?? seekTarget ?? currentTime;
  const progress = duration > 0 ? Math.min(displaySec / duration, 1) : 0;
  /**
   * 「現在聽到哪裡」的唯一權威值——**所有以目前位置為起點的動作都要讀它**
   * （↺15、快轉、拖曳、點逐字稿），逐字稿面板收到的也是這個值。
   *
   * 不能直接用 `status.currentTime`：它每 250ms 才取樣一次，送出 seek 之後最久
   * 會有 SEEK_SETTLE_MS 這麼久還停在**舊位置**。後果有兩層：連按兩次 ↺15 會用
   * 同一個起點算出同一個目標（第二下等於沒動），而更嚴重的是 logReplayEvent ——
   * capture 的難點窗口是 [T-15, T]（CONTEXT.md「Capture window」），T 取到落後
   * 的舊值，整則 capture 就指到學習者根本沒有重聽的那一句上。
   *
   * 拖曳中的 scrubSec 刻意不算進來：手指經過的每個位置都可能觸發一個 10 分鐘
   * 窗口的 Whisper 轉錄（真的要錢），使用者放開手才算數。
   */
  const positionSec = seekTarget ?? currentTime;

  const artSize = Math.floor(Math.min(width - SP(10), stageHeight));
  const showLargeArt = !transcriptExpanded && artSize >= ART_MIN_SIZE;

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

  // 建立匿名 session（第一次啟動時註冊，之後從 AsyncStorage 還原）。
  // 沒有它：RLS 讀不到自己的資料、Edge Function 會回 401、指標也無法歸屬到人。
  // 失敗不擋 UI —— ensureSession 永遠不 throw，回 null 就是本地模式。
  useEffect(() => {
    void ensureSession();
  }, []);

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

  // 播放位置追上目標了 → 把進度條交還給 status。
  useEffect(() => {
    if (seekTarget === null) return;
    if (Math.abs(currentTime - seekTarget) <= SEEK_SETTLE_SEC) setSeekTarget(null);
  }, [seekTarget, currentTime]);

  // 保險絲：seek 沒生效（音檔還沒載入 / 位置被拒）時，不要讓進度條永遠凍在目標上。
  useEffect(() => {
    if (seekTarget === null) return;
    const id = setTimeout(() => setSeekTarget(null), SEEK_SETTLE_MS);
    return () => clearTimeout(id);
  }, [seekTarget]);

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

  /** 所有 seek 的單一入口：真的 seek + 記下目標，讓進度條立刻到位。 */
  const seekTo = (target: number) => {
    const clamped = Math.max(0, duration > 0 ? Math.min(target, duration) : target);
    void player.seekTo(clamped);
    setSeekTarget(clamped);
  };

  const togglePlay = () => {
    if (status.playing) player.pause();
    else player.play();
  };

  const back15 = () => {
    const from = positionSec;
    const to = Math.max(0, from - BACK_SECONDS);
    seekTo(to);
    logReplayEvent(from, to);
  };

  const forward30 = () => {
    seekTo(Math.min(duration, positionSec + FORWARD_SECONDS));
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
    setSeekTarget(null); // 舊集的 seek 目標不能套到新集的進度條上
    setEpisode(ep); // replace + setPlaybackRate 由 useEffect([episode.id]) 統一處理
  };

  // --- Scrubber -------------------------------------------------------------
  // PanResponder 只建立一次（重建會讓拖曳中途斷手），所以它看到的所有會變的值
  // 一律走 ref —— 直接閉包會永遠讀到第一次 render 的 duration / 寬度。
  const barWidthRef = useRef(0);
  const durationRef = useRef(duration);
  const scrubStartRef = useRef(0);
  const commitScrubRef = useRef<(sec: number) => void>(() => {});

  const secAtX = (x: number) => {
    const w = barWidthRef.current;
    const d = durationRef.current;
    if (w <= 0 || d <= 0) return 0;
    return Math.max(0, Math.min(1, x / w)) * d;
  };

  // 拖曳結束 = 一次 seek；往回拖與按 ↺15 是同一個領域事件，走同一條
  // logReplayEvent（ADR-0003：只有一條 replay-event pipeline）。
  const commitScrub = (target: number) => {
    setScrubSec(null);
    if (barWidthRef.current <= 0 || duration <= 0) return;
    const from = positionSec;
    seekTo(target);
    if (target < from - 1) logReplayEvent(from, target);
  };

  useEffect(() => {
    durationRef.current = duration;
    commitScrubRef.current = commitScrub;
  });

  const scrubResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // 拿到手勢就不放：底下的清單/面板不該在拖曳中途把進度條搶走。
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

  // 封面舞台吃掉剩下的垂直空間，量到多少就畫多大的正方形。
  const onStageLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    // 只接受正值：display:none 與剛掛載時會量到 0，讓封面歸零反而閃一下。
    if (h > 0) setStageHeight(h);
  };

  // --- 逐字稿 ---------------------------------------------------------------
  // 「rewind 之後打開逐字稿」是把 capture 升級成 ★★★ strong 的三個條件之一
  //（signal-design §2）。這裡只回報「使用者剛剛展開了」這個事實，「多久之內算數」
  // 的規則留在 captureEngine —— 升級規則只能有一個所在地（ADR-0003）。
  const toggleTranscript = (next: boolean) => {
    setTranscriptExpanded(next);
    if (next) noteTranscriptOpen(episode.id);
  };

  // 往回跳 = 一次 replay event，與 ↺15 完全同一條路徑，只是概念上的
  // trigger_source 不同（ADR-0003）。
  //
  // `from` 必須跟面板判斷 isRewind 時用的是同一個時鐘（它比的是 positionSec），
  // 否則 seek 還在追的那段期間，一次往前跳可能被記成 replay event。
  const onTranscriptSeek = (to: number, isRewind: boolean) => {
    const from = positionSec;
    seekTo(to);
    if (isRewind) logReplayEvent(from, to);
  };

  const todayCount = useMemo(() => {
    const today = new Date().toDateString();
    return events.filter((e) => new Date(e.created_at).toDateString() === today).length;
  }, [events]);

  const loadState = status.isLoaded
    ? status.isBuffering
      ? '緩衝中…'
      : null
    : '載入音檔中…';

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {/* Header：連線狀態縮成一個點——那是給我們自己看的除錯資訊，不該跟單集搶版面。 */}
      <View style={styles.header}>
        <Text style={styles.logo}>Echo</Text>
        <View style={styles.sync}>
          <View
            style={[
              styles.syncDot,
              isSupabaseConfigured ? styles.syncDotOn : styles.syncDotOff,
            ]}
          />
          <Text style={styles.syncText}>
            {isSupabaseConfigured ? '已連線' : '本地模式'}
          </Text>
        </View>
      </View>

      {/* 現在跑的是哪一顆 bundle。OTA 送達與否在畫面上看不出來，只能把它印出來。 */}
      <UpdateStatus />

      {/* Tabs：播放器｜今日練習（state 切換，不用 navigation） */}
      <View style={styles.segment}>
        {TABS.map(({ key, label }) => {
          const active = tab === key;
          return (
            <Pressable
              key={key}
              onPress={() => switchTab(key)}
              style={[styles.segmentItem, active && styles.segmentItemActive]}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                {label}
              </Text>
              {key === 'practice' && practiceBadge > 0 && (
                <View style={styles.segmentBadge}>
                  <Text style={styles.segmentBadgeText}>{practiceBadge}</Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {tab === 'practice' ? (
        <PracticeScreen />
      ) : (
        <View style={styles.player}>
          {/* Podcast 搜尋 / 訂閱 / 單集清單。逐字稿展開時收起來（display:none 而非
              卸載——搜尋字串與選中的 feed 是使用者的工作狀態，不能因為打開逐字稿
              就被丟掉）。 */}
          <View style={transcriptExpanded ? styles.hidden : undefined}>
            <PodcastBrowser
              selectedEpisodeId={episode.id}
              onSelectEpisode={selectEpisode}
            />
          </View>

          {/* 封面舞台：拿剩下的垂直空間畫一個正方形。空間不夠（訂閱清單很長、
              小螢幕）時整塊讓位，封面自動退成下面那排的縮圖。 */}
          {!transcriptExpanded && (
            <View style={styles.stage} onLayout={onStageLayout}>
              {showLargeArt && <Artwork episode={episode} size={artSize} />}
            </View>
          )}

          {/* Now playing */}
          <View style={styles.nowPlaying}>
            {!showLargeArt && <Artwork episode={episode} size={ART_THUMB_SIZE} />}
            <View style={styles.nowPlayingText}>
              <Text style={styles.podcastName} numberOfLines={1}>
                {episode.podcast}
              </Text>
              <Text style={styles.episodeTitle} numberOfLines={2}>
                {episode.title}
              </Text>
            </View>
          </View>

          {/* Scrubber（可拖曳；往回拖也是一次 replay event） */}
          <View
            style={styles.barTouch}
            onLayout={onBarLayout}
            {...scrubResponder.panHandlers}
          >
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${progress * 100}%` }]} />
            </View>
            {/* pointerEvents none 是必要的：拇指若吃得到觸控，從拇指上按下時
                grant 的 locationX 會變成「相對於拇指」，一按就跳到軌道最左邊。 */}
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
            <Text style={styles.timeText}>{formatRemaining(displaySec, duration)}</Text>
          </View>

          {/* Transport：↺15 是產品的核心手勢，永遠是版面上最大、唯一有顏色的鍵。 */}
          <View style={styles.transport}>
            <Pressable
              onPress={back15}
              style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="重聽 15 秒"
            >
              <Text style={styles.backButtonText}>↺15</Text>
              <Text style={styles.backButtonSub}>Back</Text>
            </Pressable>

            <Pressable
              onPress={togglePlay}
              style={({ pressed }) => [styles.playButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={status.playing ? '暫停' : '播放'}
            >
              <Text style={styles.playButtonText}>{status.playing ? '❚❚' : '▶'}</Text>
            </Pressable>

            <Pressable
              onPress={forward30}
              style={({ pressed }) => [styles.fwdButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="快轉 30 秒"
            >
              <Text style={styles.fwdButtonText}>30↻</Text>
            </Pressable>
          </View>

          {/* 次要控制：速度、逐字稿 */}
          <View style={styles.pillRow}>
            <Pressable
              onPress={cycleRate}
              style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
            >
              <Text style={styles.pillText}>速度 {rate}x</Text>
            </Pressable>
            <Pressable
              onPress={() => toggleTranscript(!transcriptExpanded)}
              style={({ pressed }) => [
                styles.pill,
                transcriptExpanded && styles.pillActive,
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[styles.pillText, transcriptExpanded && styles.pillTextActive]}
              >
                逐字稿
              </Text>
            </Pressable>
          </View>

          {/* 重聽次數：以前那份 replay 事件清單是除錯用的，只有這個數字對使用者
              有意義（完整事件仍在 events state 裡，capture engine 走同一條路）。 */}
          <View style={styles.footRow}>
            <Text style={styles.footText}>今天 {todayCount} 次重聽</Text>
            {loadState !== null && <Text style={styles.footText}>{loadState}</Text>}
          </View>

          <TranscriptPanel
            episode={episode}
            positionSec={positionSec}
            expanded={transcriptExpanded}
            onToggleExpand={toggleTranscript}
            onSeek={onTranscriptSeek}
            onOpenTerm={setActiveTerm}
          />
        </View>
      )}

      {/* Modal 常駐（TermSheet 內部靠 visible 切換，重建原生 view 會掉第一幀）。 */}
      <TermSheet term={activeTerm} onClose={() => setActiveTerm(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
    paddingHorizontal: SP(5),
    paddingTop: Platform.OS === 'android' ? 48 : 64,
    paddingBottom: SP(6),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logo: { ...TYPE.title, color: C.text, letterSpacing: 1 },
  sync: { flexDirection: 'row', alignItems: 'center', gap: SP(1.5) },
  syncDot: { width: 6, height: 6, borderRadius: 3 },
  syncDotOn: { backgroundColor: C.accent },
  syncDotOff: { backgroundColor: C.faint },
  syncText: { ...TYPE.caption, color: C.dim, fontWeight: '400' },

  // 分段控制：外框是容器，選中的那格自己浮起來一層。
  segment: {
    flexDirection: 'row',
    marginTop: SP(3.5),
    backgroundColor: C.surface,
    borderRadius: R.md,
    padding: 3,
    borderWidth: 1,
    borderColor: C.border,
  },
  segmentItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SP(1.5),
    borderRadius: R.sm,
    paddingVertical: SP(2.5),
  },
  segmentItemActive: { backgroundColor: C.surfaceAlt },
  segmentText: { ...TYPE.heading, fontSize: 15, color: C.dim },
  segmentTextActive: { color: C.text },
  segmentBadge: {
    backgroundColor: C.accent,
    borderRadius: R.pill,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  segmentBadgeText: { ...TYPE.caption, color: C.accentInk, fontWeight: '800' },

  player: { flex: 1 },
  hidden: { display: 'none' },

  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SP(3),
  },
  artShadow: {
    backgroundColor: C.surface,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  artClip: { flex: 1, overflow: 'hidden' },
  artFill: { flex: 1 },
  artPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  artWedge: { position: 'absolute', transform: [{ rotate: '-18deg' }] },
  artInitial: { color: '#FFFFFFDD', fontWeight: '800' },

  nowPlaying: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SP(3),
    marginTop: SP(4),
  },
  nowPlayingText: { flex: 1 },
  podcastName: { ...TYPE.caption, color: C.dim, fontWeight: '400' },
  episodeTitle: { ...TYPE.heading, fontSize: 20, lineHeight: 26, color: C.text, marginTop: 2 },

  // 觸控區比視覺上的 6pt 軌道厚得多——細的進度條很難用手指抓準。
  barTouch: { marginTop: SP(4), paddingVertical: SP(3) },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: C.surfaceAlt, overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: C.primary },
  // top 是算出來的：paddingVertical(12) + (軌道 6 - 拇指高) / 2。
  thumb: {
    position: 'absolute',
    top: 9,
    width: 12,
    height: 12,
    borderRadius: 6,
    marginLeft: -6,
    backgroundColor: C.text,
  },
  thumbActive: { top: 6, width: 18, height: 18, borderRadius: 9 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between' },
  timeText: { ...TYPE.mono, color: C.dim, fontWeight: '400' },
  timeTextActive: { color: C.text },

  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SP(5),
  },
  backButton: {
    width: 108,
    height: 108,
    borderRadius: 54,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: { color: C.accentInk, fontSize: 30, fontWeight: '800' },
  backButtonSub: { ...TYPE.caption, color: C.accentInk, fontWeight: '700', marginTop: 2 },
  playButton: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: C.surface,
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
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fwdButtonText: { ...TYPE.heading, color: C.text },
  pressed: { opacity: 0.7, transform: [{ scale: 0.97 }] },

  pillRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: SP(2),
    marginTop: SP(4),
  },
  pill: {
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.pill,
    paddingHorizontal: SP(4),
    paddingVertical: SP(2),
  },
  pillActive: { backgroundColor: C.surfaceAlt, borderColor: C.primary },
  pillText: { ...TYPE.heading, fontSize: 14, color: C.dim },
  pillTextActive: { color: C.text },

  footRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SP(3),
    marginBottom: SP(2),
  },
  footText: { ...TYPE.caption, color: C.faint, fontWeight: '400' },
});
