/**
 * App shell —— 只做三件事：擁有播放器、擁有導覽狀態、把兩者接起來。
 *
 * 版面是 podcast app 的標準結構，這不是抄形式而是解一個實際問題：以前「播放器」
 * 本身就是首頁，探索清單是播放器裡的一塊，所以（一）在聽東西時沒有「回主頁」這
 * 個動作可做，（二）逐字稿只能分到控制項用剩的三成高度，跟播看起來像清單在抖。
 *
 *   ┌───────────────────────────┐
 *   │ 分頁內容（首頁 ／ 探索 ／ 練習）│  ← 各自拿到整個畫面
 *   ├───────────────────────────┤
 *   │ mini player               │  ← 首頁以外常駐，點了往上升起
 *   │ 分頁列                     │
 *   └───────────────────────────┘
 *        ↑ NowPlaying 覆蓋上來
 *             ↑ TranscriptScreen 再覆蓋上來
 *
 * 播放狀態全部留在這裡（player、seekTarget、rate、volume、events）：它是跨畫面的，
 * 誰在最上層都不影響「現在聽到哪裡」。子畫面只拿值與 callback。
 */
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as Notifications from 'expo-notifications';

import HomeScreen from './components/HomeScreen';
import MiniPlayer from './components/MiniPlayer';
import NowPlaying from './components/NowPlaying';
import PodcastBrowser from './components/PodcastBrowser';
import TermSheet from './components/TermSheet';
import TranscriptScreen from './components/TranscriptScreen';
import UpdateStatus from './components/UpdateStatus';
import { Term } from './lib/annotate';
import { DEMO_EPISODES, Episode } from './lib/episodes';
import { ensureSession, isSupabaseConfigured } from './lib/supabase';
import { makeReplayEvent, ReplayEvent, syncReplayEvent, TriggerSource } from './lib/replay';
import { ingestReplayEvent, noteRateChange, noteTranscriptOpen } from './lib/captureEngine';
import { getCaptures, getSrsItems, initStore, rememberEpisode, subscribe } from './lib/store';
import { isDue, toDateStr, todayStr } from './lib/srs';
import { syncDailyReminder } from './lib/notifications';
import { C, R, SP, TYPE } from './lib/theme';
import PracticeScreen from './screens/Practice';

const BACK_SECONDS = 15;
const FORWARD_SECONDS = 30;
const RATES = [1, 0.85, 0.7] as const;

/**
 * 三個分頁。首頁**含**探索 masonry 與練習入口，所以「那兩個分頁還留著幹嘛」是
 * 個該回答的問題——兩個都留，理由不同：
 *
 * - **探索**留著是因為首頁的 masonry 只吃「已經有的東西」（DEMO 集 + 已訂閱 feed
 *   的單集）。搜尋 iTunes、訂閱新節目只有 PodcastBrowser 做得到，而首頁見底時的
 *   footer 正是把人往這裡送。首頁是消費、探索是取得，同一個名字兩件事。
 * - **練習**留著是因為徽章要能一眼看到（分頁列常駐，首頁的今日練習磚要捲到才看得
 *   見），而練習是一段全螢幕的流程，不是首頁塞得下的東西。首頁那塊磚是入口、
 *   分頁是目的地——兩者指向同一處完全正常（Apple Podcasts 的資料庫卡片與資料庫
 *   分頁就是這樣）。
 */
const TABS = [
  { key: 'home', label: '首頁' },
  { key: 'browse', label: '探索' },
  { key: 'practice', label: '練習' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

/** 沒有 safe-area 套件，用平台常數頂替（狀態列 + 瀏海）。 */
const TOP_INSET = Platform.OS === 'android' ? 40 : 60;

/**
 * seekTo 之後畫面先停在目標值上，直到播放位置追到這麼近為止。
 * 沒有這段延遲，進度條會先彈回舊位置再跳到新位置（status 每 250ms 才更新一次）。
 */
const SEEK_SETTLE_SEC = 1.5;
/** ……或等這麼久還沒追上就放手（音檔尚未載入、seek 被拒）。 */
const SEEK_SETTLE_MS = 1500;

/**
 * 播放位置往回跳超過這麼多秒，而且不是 app 自己送出的 seek → 判定為外部倒帶
 * （控制中心／鎖定畫面／之後的耳機遙控）。
 *
 * 取 3 秒是因為系統的往回鍵目前是 10 秒（見下面 setActiveForLockScreen 的註解），
 * 而比這更小的位置變動是緩衝抖動或微調拖曳，不是「我沒聽懂」。
 */
const EXTERNAL_REWIND_MIN_SEC = 3;

export default function App() {
  const [tab, setTab] = useState<TabKey>('home');
  const [practiceBadge, setPracticeBadge] = useState(0);
  const [episode, setEpisode] = useState<Episode>(DEMO_EPISODES[0]);
  const [rateIndex, setRateIndex] = useState(0);
  /**
   * expo-audio 57 的 `player.volume` 可寫（0.0–1.0），但 `AudioStatus` **沒有**
   * volume 欄位（只有 mute）——讀不回來，所以這個 state 就是唯一真相。
   *
   * 它調的是 app 內部的播放增益，與系統音量相乘：使用者按實體按鍵或到控制中心
   * 調的是後者，那些改動同步不回這裡，兩條路各走各的。
   */
  const [volume, setVolume] = useState(1);
  const [events, setEvents] = useState<ReplayEvent[]>([]);
  /** 已送出、還在等播放位置追上的 seek 目標。 */
  const [seekTarget, setSeekTarget] = useState<number | null>(null);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [activeTerm, setActiveTerm] = useState<Term | null>(null);

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

  /**
   * 「現在聽到哪裡」的唯一權威值——**所有以目前位置為起點的動作都要讀它**
   * （↺15、快轉、拖曳、點逐字稿），子畫面收到的也是這個值。
   *
   * 不能直接用 `status.currentTime`：它每 250ms 才取樣一次，送出 seek 之後最久
   * 會有 SEEK_SETTLE_MS 這麼久還停在**舊位置**。後果有兩層：連按兩次 ↺15 會用
   * 同一個起點算出同一個目標（第二下等於沒動），而更嚴重的是 logReplayEvent ——
   * capture 的難點窗口是 [T-15, T]（CONTEXT.md「Capture window」），T 取到落後
   * 的舊值，整則 capture 就指到學習者根本沒有重聽的那一句上。
   */
  const positionSec = seekTarget ?? currentTime;

  /**
   * 鎖定畫面／控制中心要顯示的資訊。放在 ref 是因為「啟用」發生在 setAudioModeAsync
   * 的 promise 之後，那時 render 的閉包可能已經過期（使用者早就換了一集）。
   */
  const lockScreenMetaRef = useRef({
    title: episode.title,
    artist: episode.podcast,
    artworkUrl: episode.artworkUrl,
  });

  // iOS: keep playing with the mute switch on; don't mix with other audio.
  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
      shouldPlayInBackground: true,
    })
      .then(() => {
        /**
         * 沒有這一行，控制中心／鎖定畫面就是死的：expo-audio 的 MediaController
         * 要等到有人把 player 設成 active，才會去填 MPNowPlayingInfoCenter 並把
         * MPRemoteCommandCenter 的各個 command `isEnabled = true`。在那之前
         * 系統手上沒有這個 app 的曲目資訊，按鍵也沒有接收者——所以會看到別的
         * app 的播放器，或按了沒反應。
         *
         * `interruptionMode` 必須是 'doNotMix' 系統才會把控制項對應到這個
         * player，所以接在 setAudioModeAsync 後面而不是各跑各的。
         *
         * ⚠️ **只能呼叫這一次。** enableRemoteCommands 每次都 addTarget，而
         * disable 用的 removeTarget(self) 移不掉 block 形式的 handler；重複啟用
         * 會讓按一次往回鍵 seek 好幾次。換集一律走 updateLockScreenMetadata。
         *
         * 往回／往前鍵的秒數由 expo-audio 寫死（10 秒），JS 這邊改不了，所以
         * 鎖定畫面的往回幅度與 app 內的 ↺15 不一致。這不影響訊號本身——難點
         * 窗口是從 fromPos 往回算的（captureEngine），跟跳了幾秒無關。
         */
        playerRef.current.setActiveForLockScreen(true, lockScreenMetaRef.current, {
          showSeekBackward: true,
          showSeekForward: true,
        });
      })
      .catch((err) => console.warn('[audio] setAudioModeAsync failed:', err));
  }, []);

  // 使用者主動選集才自動播；開 app 停在第一集不該直接出聲。
  const autoPlayRef = useRef(false);

  /** 上一次看到的播放位置，用來偵測「位置忽然往回跳」。 */
  const lastTimeRef = useRef(0);
  /**
   * 在這個時間戳之前，位置往回跳都當成是 app 自己造成的，不記錄。
   * 用 ref 而不是 state：seekTo 送出到 state 生效之間會有 status tick 進來，
   * 那一格會把我們自己的 ↺15 誤判成外部倒帶、記成第二筆事件。
   */
  const ignoreJumpUntilRef = useRef(0);
  /** 最後一次自己送出的 seek 目標，用來認出「遲到才生效」的自家 seek。 */
  const lastCommandedRef = useRef<number | null>(null);

  // 單集載入：初始集與換集一律走這裡（player 實例穩定，replace 不重建），
  // 並重新套用使用者目前選的播放速度。
  useEffect(() => {
    player.replace({ uri: episode.audioUrl });
    player.setPlaybackRate(RATES[rateIndex], 'high');
    // 理由與上一行完全相同：v57 的文件**沒有**說 volume 在 replace() 之後還在，
    // 而「沒寫」不是可以依賴的保證。不重套的話 UI 顯示的音量就會與實際脫鉤，
    // 正好重演當初速度脫鉤的那個 bug。
    player.volume = volume;

    lockScreenMetaRef.current = {
      title: episode.title,
      artist: episode.podcast,
      artworkUrl: episode.artworkUrl,
    };
    // 尚未啟用時是 no-op（首次啟用會自己讀上面那個 ref）。這裡不能改用
    // setActiveForLockScreen —— 重複啟用會疊加 command handler。
    player.updateLockScreenMetadata(lockScreenMetaRef.current);

    // 換集時位置一定會回到 0，那不是使用者倒帶。把基準歸零，外部倒帶偵測
    // 下一輪就會拿 0 當 prev，算出來的落差不可能為正。
    lastTimeRef.current = 0;
    lastCommandedRef.current = null; // 舊集的 seek 目標不能拿來認新集的位置

    if (autoPlayRef.current) {
      autoPlayRef.current = false;
      player.play();
    }
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
  //
  // 逐字稿框選產生的 capture 不需要在這裡加任何東西就會被算到：commitSelection
  // 走的是 store 的 upsertCapture，而它結尾會 notify() → 底下這個 subscribe 就重算。
  //
  // ⚠️ 但它**當天不該進徽章**。框選出來的 capture 一出生就是 'confirmed'，會直接
  // 落進 orphanConfirmed 那一桶；如果不擋日期，圈完字的當下徽章就 +1，可是練習頁
  // 已經把同一天的 capture 分流到「搶先練」而不是正式佇列（ADR-0011）——徽章說有
  // 3 張、點進去正式佇列是空的，那是最傷信任的一種不一致。所以兩桶都要過同一道
  // `< today`。
  //
  // 這裡是 Practice.tsx 佇列建構的孿生實作，**兩邊的過濾條件必須逐字一致**。
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
      // 上次按了「真的沒聽懂」但沒評分就離開的卡（confirmed 且無 SRS item），
      // 以及昨天以前框選的。今天的兩者都歸「搶先練」，不算正式佇列。
      const orphanConfirmed = captures.filter(
        (c) =>
          c.status === 'confirmed' &&
          !srsIds.has(c.id) &&
          toDateStr(new Date(c.created_at)) < today,
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
      setNowPlayingOpen(false);
      setTranscriptOpen(false);
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
  const logReplayEvent = (
    fromPos: number,
    toPos: number,
    triggerSource: TriggerSource = 'screen',
  ) => {
    const event = makeReplayEvent({
      episodeId: episode.id,
      fromPos,
      toPos,
      playbackRate: rate,
      triggerSource,
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
    // 先關掉外部倒帶偵測，再送 seek：這一跳是我們自己造成的，該記的呼叫端已經記了。
    ignoreJumpUntilRef.current = Date.now() + SEEK_SETTLE_MS;
    lastCommandedRef.current = clamped;
    void player.seekTo(clamped);
    setSeekTarget(clamped);
  };

  /**
   * 控制中心／鎖定畫面按往回，**不會經過這支 app 的任何 JS**：expo-audio 的
   * MPRemoteCommandCenter handler 直接呼叫 AVPlayer.seek。所以那一下倒帶——
   * 也就是這個產品唯一在乎的訊號——會憑空消失。
   *
   * 唯一還看得到它的地方是播放位置本身：狀態每 250ms 取樣一次，外部 seek 之後
   * 下一格就會忽然往回。這裡把那個落差撈回 logReplayEvent，讓它跟 ↺15 走同一條
   * 管線、只是 trigger_source 不同——ADR-0003 早就把「鎖定畫面遙控」列為來源之一。
   */
  useEffect(() => {
    const prev = lastTimeRef.current;
    lastTimeRef.current = currentTime;
    if (Date.now() < ignoreJumpUntilRef.current) return;
    if (prev - currentTime < EXTERNAL_REWIND_MIN_SEC) return;
    // 自家的 seek 遲到才生效（音檔還在載入時送出的）會落在保險絲之外。認位置比認
    // 時間可靠：寧可漏記一筆，也不要無中生有——幻覺事件會替一句學習者從沒重聽過的
    // 話建出 capture，那比少一筆更傷。
    const commanded = lastCommandedRef.current;
    if (commanded !== null && Math.abs(currentTime - commanded) <= SEEK_SETTLE_SEC) return;
    logReplayEvent(prev, currentTime, 'lockscreen');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime]);

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

  /**
   * 音量的唯一入口。夾在 0–1 是因為 volume 是從 UI 的手勢算出來的比例，
   * 手指滑出軌道時算出來的值會超出兩端。
   *
   * 與 cycleRate 不同，這裡**不記任何訊號**：調音量不代表沒聽懂（吵、戴上耳機、
   * 旁邊有人都會調），把它當訊號會稀釋掉真正的重聽。
   */
  const applyVolume = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolume(clamped);
    player.volume = clamped;
  };

  /**
   * 往回跳 = 一次 replay event，與 ↺15 完全同一條路徑，只是概念上的
   * trigger_source 不同（ADR-0003）。
   *
   * `from` 必須跟呼叫端判斷 isRewind 時用的是同一個時鐘（它比的是 positionSec），
   * 否則 seek 還在追的那段期間，一次往前跳可能被記成 replay event。
   */
  const onSeekFromUi = (to: number, isRewind: boolean) => {
    const from = positionSec;
    seekTo(to);
    if (isRewind) logReplayEvent(from, to);
  };

  const switchTab = (next: TabKey) => {
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
    autoPlayRef.current = true; // 明確選了一集就是要聽它
    setEpisode(ep); // replace + setPlaybackRate 由 useEffect([episode.id]) 統一處理
  };

  /**
   * 「rewind 之後打開逐字稿」是把 capture 升級成 ★★★ strong 的三個條件之一
   * （signal-design §2）。這裡只回報「使用者剛剛打開了」這個事實，「多久之內算數」
   * 的規則留在 captureEngine —— 升級規則只能有一個所在地（ADR-0003）。
   *
   * 逐字稿仍然是**要主動打開**的：它平常不在畫面上，所以「打開」這個動作才保有
   * 訊號意義。做成常駐面板的話這個條件就永遠成立，等於沒有這個條件。
   */
  const openTranscript = () => {
    setTranscriptOpen(true);
    noteTranscriptOpen(episode.id);
  };

  /**
   * NowPlaying 把它印成「今天 N 次重聽」，所以這裡只能裝**重聽**。
   *
   * 框選（trigger_source 'select'）刻意不進 `events`：它不 seek、不動播放位置，
   * 本來就不是重聽（selection.ts 的三條禁令）。把它算進來只會讓這個數字說謊，
   * 而這個數字正是整個產品的論點。它自己的遠端事件由 commitSelection 直送
   * syncReplayEvent，不經過外殼。
   */
  const todayCount = useMemo(() => {
    const today = new Date().toDateString();
    return events.filter((e) => new Date(e.created_at).toDateString() === today).length;
  }, [events]);

  const loadState = status.isLoaded ? (status.isBuffering ? '緩衝中…' : null) : '載入音檔中…';

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      <View style={styles.screen}>
        {/* Header：連線狀態縮成一個點——那是給我們自己看的除錯資訊，不該搶版面。 */}
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

        <View style={styles.tabContent}>
          {tab === 'home' ? (
            /* 播放狀態全部由外殼供給，HomeScreen 永遠拿不到 player 實例（ADR-0015）。
               往回鍵一定要接 back15 而不是自己算目標再 seek——它會記 replay event。
               這裡沒有 onSeek：首頁的進度條是唯讀的，第三份可拖曳的 scrubber 會跟
               捲動容器搶手勢，要拖就點卡片升起 NowPlaying。 */
            <HomeScreen
              episode={episode}
              positionSec={positionSec}
              durationSec={duration}
              playing={status.playing}
              rate={rate}
              loadState={loadState}
              volume={volume}
              onTogglePlay={togglePlay}
              onBack15={back15}
              onForward30={forward30}
              onCycleRate={cycleRate}
              onVolumeChange={applyVolume}
              onOpenNowPlaying={() => setNowPlayingOpen(true)}
              onOpenTranscript={openTranscript}
              onSelectEpisode={selectEpisode}
              onGoPractice={() => switchTab('practice')}
              onGoBrowse={() => switchTab('browse')}
              practiceBadge={practiceBadge}
            />
          ) : tab === 'browse' ? (
            <PodcastBrowser
              selectedEpisodeId={episode.id}
              onSelectEpisode={selectEpisode}
            />
          ) : (
            <PracticeScreen />
          )}
        </View>
      </View>

      {/*
        首頁不掛 mini player：首頁的 hero 是它的**超集**（封面、標題、進度、↺15、
        播放、快轉、速度、音量、逐字稿），兩條 transport 疊在同一畫面上，使用者要先
        決定該按哪一顆才能按——而兩顆 ↺15 送出的是同一個訊號，這個猶豫毫無回報。
        少掉一條也讓首頁多拿一整條的高度給 bento。

        已知取捨：hero 會跟著捲走，捲到探索區時就沒有 transport 了。不做「捲過就淡入
        mini player」是因為那要把 onScroll 從 MasonryList 一路穿回外殼、再加一段
        crossfade，而首頁的每張卡本來就能點開 NowPlaying。留給下一輪。
      */}
      {tab !== 'home' && (
        <MiniPlayer
          episode={episode}
          positionSec={positionSec}
          durationSec={duration}
          playing={status.playing}
          onOpen={() => setNowPlayingOpen(true)}
          onTogglePlay={togglePlay}
          onBack15={back15}
        />
      )}

      <View style={styles.tabBar}>
        {TABS.map(({ key, label }) => {
          const active = tab === key;
          return (
            <Pressable
              key={key}
              onPress={() => switchTab(key)}
              style={styles.tabItem}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
              {key === 'practice' && practiceBadge > 0 && (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>{practiceBadge}</Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {/* 覆蓋層。用絕對定位而不是 Modal：TermSheet 本身是 Modal，兩層 Modal 疊在
          iOS 上會有 present 時機的坑，而絕對定位的覆蓋層天生就在它下面。 */}
      {nowPlayingOpen && (
        <View style={styles.overlay}>
          <NowPlaying
            episode={episode}
            positionSec={positionSec}
            durationSec={duration}
            playing={status.playing}
            rate={rate}
            todayCount={todayCount}
            loadState={loadState}
            onClose={() => setNowPlayingOpen(false)}
            onTogglePlay={togglePlay}
            onBack15={back15}
            onForward30={forward30}
            onCycleRate={cycleRate}
            onSeek={onSeekFromUi}
            onOpenTranscript={openTranscript}
          />
        </View>
      )}

      {transcriptOpen && (
        <View style={styles.overlay}>
          <TranscriptScreen
            episode={episode}
            positionSec={positionSec}
            durationSec={duration}
            playing={status.playing}
            onClose={() => setTranscriptOpen(false)}
            onSeek={onSeekFromUi}
            onOpenTerm={setActiveTerm}
            onTogglePlay={togglePlay}
            onBack15={back15}
            onForward30={forward30}
          />
        </View>
      )}

      {/* Modal 常駐（TermSheet 內部靠 visible 切換，重建原生 view 會掉第一幀）。 */}
      <TermSheet term={activeTerm} onClose={() => setActiveTerm(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  // 上緣留白給 `screen` 自己吃，不放在 root：覆蓋層是 root 的絕對定位子層，
  // 而 RN 的 top:0 是對齊父層的 **padding box**，root 有 paddingTop 的話覆蓋層
  // 會從那底下才開始，再加上自己的 TOP_INSET 就變成兩倍留白。
  root: { flex: 1, backgroundColor: C.bg },

  screen: { flex: 1, paddingHorizontal: SP(5), paddingTop: TOP_INSET },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  logo: { ...TYPE.title, color: C.text, letterSpacing: 1 },
  sync: { flexDirection: 'row', alignItems: 'center', gap: SP(1.5) },
  syncDot: { width: 6, height: 6, borderRadius: 3 },
  syncDotOn: { backgroundColor: C.accent },
  syncDotOff: { backgroundColor: C.faint },
  syncText: { ...TYPE.caption, color: C.dim, fontWeight: '400' },
  tabContent: { flex: 1 },

  tabBar: {
    flexDirection: 'row',
    paddingTop: SP(2),
    paddingBottom: SP(7),
    paddingHorizontal: SP(3),
  },
  tabItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SP(1.5),
    paddingVertical: SP(2),
  },
  tabText: { ...TYPE.caption, fontSize: 13, color: C.faint },
  tabTextActive: { color: C.text },
  tabBadge: {
    backgroundColor: C.accent,
    borderRadius: R.pill,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  tabBadgeText: { ...TYPE.caption, fontSize: 11, color: C.accentInk, fontWeight: '800' },

  // 明寫四個邊而不是 spread `StyleSheet.absoluteFillObject`：RN 0.86 已經移除它，
  // 而 spread 一個 undefined 不會報錯，只會靜靜地少掉 position:'absolute'。
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: C.bg,
    paddingTop: TOP_INSET,
  },
});
