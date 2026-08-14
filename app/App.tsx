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
import { segmentKey, Term } from './lib/annotate';
import { DEMO_EPISODES, Episode } from './lib/episodes';
import { ensureSession, isSupabaseConfigured } from './lib/supabase';
import { makeReplayEvent, ReplayEvent, syncReplayEvent, TriggerSource } from './lib/replay';
import { ingestReplayEvent, noteRateChange, noteTranscriptOpen } from './lib/captureEngine';
import { commitSavedTerm, isTermSaved } from './lib/selection';
import { getSegments } from './lib/transcript';
import { getCaptures, getSrsItems, initStore, rememberEpisode, subscribe } from './lib/store';
import { isDue, toDateStr, todayStr } from './lib/srs';
import {
  getLastQuizStatus,
  harvestQuizResponse,
  QUIZ_KIND,
  syncDailyReminder,
  syncQuizNotifications,
  type QuizOutcome,
} from './lib/notifications';
import type { QuizStatus } from './lib/quiz';
import type { Capture } from './lib/types';
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

/* ───────────────────────────────────────────────────────────────────────────
 * 儀器化（ADR-0023）—— 外部倒帶推斷的環狀緩衝與開機探針
 *
 * ADR-0016 的推斷 08-08 上線至今，`trigger_source='lockscreen'` **一筆都沒有**。
 * 三道閘（時間窗、3 秒門檻、±1.5 秒位置比對）任何一道都可能吃掉真事件，而**沒有
 * 資料就改門檻是瞎猜**——所以這一輪一個常數都不動，只讓判定過程可觀測：每一次
 * 「位置往回跳」都留一筆帳，包含它被哪一道閘擋掉。
 *
 * 為什麼是記憶體而不是 store：這是實測期間的讀數，不是使用者資料。它的生命週期
 * 就只有「這一次實測」，寫進 AsyncStorage 要新增 key、要處理遷移，代價與價值不成
 * 比例。代價是 app 一關就清空——所以讀數要能在畫面上看到（DevProbes），使用者
 * 實測完直接截圖回報。
 * ─────────────────────────────────────────────────────────────────────────── */

/** 一次實測抓得完的筆數；再大只是佔記憶體。 */
const REWIND_PROBE_CAPACITY = 40;

/** 「答對了」那一行留在畫面上的時間。它是回饋不是通知，不該常駐。 */
const QUIZ_FEEDBACK_MS = 4000;

type RewindVerdict =
  /** 三道閘全過，已記成一筆 trigger_source='lockscreen'。 */
  | 'logged'
  /** 被閘②（SEEK_SETTLE_MS 時間窗）擋掉。 */
  | 'settle-ms'
  /** 被閘①（EXTERNAL_REWIND_MIN_SEC 門檻）擋掉。 */
  | 'min-sec'
  /** 被閘③（±SEEK_SETTLE_SEC 位置比對）擋掉。 */
  | 'commanded';

interface RewindProbe {
  at_ms: number;
  at_iso: string;
  episode_id: string;
  /** 上一格位置。 */
  prev: number;
  /** 這一格位置。 */
  next: number;
  /** prev - next，恆 > 0（往回跳才會進來）。 */
  delta: number;
  /** ignoreJumpUntilRef − now。> 0 代表當下還在時間窗內（被閘②擋）。 */
  gate2_margin_ms: number;
  commanded: number | null;
  /** commanded 為 null 時是 null；否則 |next − commanded|。 */
  gate3_dist: number | null;
  verdict: RewindVerdict;
  /** 前景誤判 vs 真鎖屏，只有這一欄分得出來。 */
  app_state: string;
  playing: boolean;
  /** 0.7× 時死帶會位移；對不上時序多半就是漏了它。 */
  rate: number;
}

const rewindProbes: RewindProbe[] = [];

function pushRewindProbe(probe: RewindProbe): void {
  rewindProbes.push(probe);
  if (rewindProbes.length > REWIND_PROBE_CAPACITY) rewindProbes.shift();
}

/** 新到舊。回 readonly 是因為讀數只該被印出來，不該被誰改一改再印。 */
function getRewindProbes(): readonly RewindProbe[] {
  return rewindProbes.slice().reverse();
}

/**
 * 開機時「鎖屏控制項到底啟用了沒」的量測。
 *
 * 這一筆回答的是一個三道閘都解釋不了的假設：**這台手機上跑的 binary 可能根本
 * 沒有 `setActiveForLockScreen`**。`expo-audio` 2026-08-04 才從 `~57.0.0` 拉到
 * `~57.0.3`、鎖屏那段程式碼 08-08 才寫，而 `runtimeVersion.policy: 'sdkVersion'`
 * **不指紋化原生模組**——所以新的 JS bundle 一定會被推到還沒有那顆原生函式的舊
 * build 上（與 `lib/selection.ts` 檔頭的「JS 一定比 SQL 早到」同一類風險）。
 * 沒有這一筆，`lockscreen` 0 筆永遠查不出來是「被閘擋掉」還是「壓根沒啟用」。
 */
interface AudioBootProbe {
  /** null = 還沒跑完。 */
  audio_mode_ok: boolean | null;
  /** `typeof player.setActiveForLockScreen`——'function' 以外都代表 binary 太舊。 */
  lock_screen_fn: string;
  lock_screen_ok: boolean | null;
  error: string | null;
  at_iso: string | null;
}

/** 一個 process 只開機一次，所以是模組層單例而不是 state。 */
const audioBootProbe: AudioBootProbe = {
  audio_mode_ok: null,
  lock_screen_fn: '未量測',
  lock_screen_ok: null,
  error: null,
  at_iso: null,
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 清掉原生模組手上的「最後一次通知回應」。
 *
 * 同步版（`clearLastNotificationResponseAsync` 在 57.0.8 已標 deprecated）。舊
 * binary 上這支不存在會丟 UnavailabilityError，所以包起來：少一層冪等保護不至於
 * 算錯帳（收割端自己還有兩層），但為了它 crash 是不成比例的代價。
 */
function clearLastResponse(): void {
  try {
    Notifications.clearLastNotificationResponse();
  } catch (err) {
    console.warn('[notifications] clearLastNotificationResponse unavailable:', err);
  }
}

/**
 * 今日佇列的三桶 + 徽章數字。
 *
 * badge = 正式佇列數：昨天以前的 pending + confirmed 但沒評分過的孤兒卡 + 到期
 * SRS 複習；今天剛抓的 pending 不算——收在練習頁的「搶先練」。規則與 Practice.tsx
 * 的佇列建構一致，**兩邊的過濾條件必須逐字一致**。
 *
 * 逐字稿框選產生的 capture 不需要在這裡加任何東西就會被算到：commitSelection 走的
 * 是 store 的 upsertCapture，而它結尾會 notify() → App 的 subscribe 就重算。
 *
 * ⚠️ 但它**當天不該進徽章**。框選出來的 capture 一出生就是 'confirmed'，會直接落進
 * orphanConfirmed 那一桶；如果不擋日期，圈完字的當下徽章就 +1，可是練習頁已經把
 * 同一天的 capture 分流到「搶先練」而不是正式佇列（ADR-0011）——徽章說有 3 張、
 * 點進去正式佇列是空的，那是最傷信任的一種不一致。所以兩桶都要過同一道 `< today`。
 *
 * 🔴 **本輪只把 count 換成陣列，語意一格都不准變。** `dueReviews` 目前不過濾
 * `capture.status`（與 Practice.tsx 有已知落差），而且 `badge` 仍用**到期 SRS 的
 * 筆數**算——即使某一筆對不到本地 capture（陣列版會丟掉它）。所以
 * `dueReviews.length` 可能小於 badge 裡的那一項，**這是刻意的**：改成
 * `dueReviews.length` 會動到徽章數字，那是另一輪的題目。
 */
interface TodayBuckets {
  /** 昨天以前的 pending。 */
  officialPending: Capture[];
  /** 昨天以前 confirmed 且無 SRS item。 */
  orphanConfirmed: Capture[];
  /** 到期 SRS 且不在 pendingIds、而且對得到本地 capture 的。 */
  dueReviews: Capture[];
  /** 三桶相加（dueReviews 那一項用**到期筆數**，見上面的鐵律）。 */
  badge: number;
}

function computeTodayBuckets(): TodayBuckets {
  const today = todayStr();
  const captures = getCaptures();
  const byId = new Map(captures.map((c) => [c.id, c]));

  const pendingAll = captures.filter((c) => c.status === 'pending');
  const pendingIds = new Set(pendingAll.map((c) => c.id));
  const officialPending = pendingAll.filter(
    (c) => toDateStr(new Date(c.created_at)) < today,
  );

  const srsItems = getSrsItems();
  const srsIds = new Set(srsItems.map((i) => i.capture_id));
  // 上次按了「真的沒聽懂」但沒評分就離開的卡（confirmed 且無 SRS item），以及昨天
  // 以前框選的、以及昨天以前**加入練習的標註詞**（strength 'saved'，一出生就是
  // confirmed，走的是同一桶）。今天的三者都歸「搶先練」，不算正式佇列。
  //
  // saved **要**進正式佇列，理由與框選同一條：它是「他想學什麼」，而練習頁的職責
  // 就是把想學的東西隔天送回他面前；排除它等於做了一顆按了不會發生任何事的按鈕。
  // 它與訊號指標的分界（那裡一律排除 saved）不衝突——佇列問的是「練什麼」，指標問
  // 的是「他哪裡聽不懂」，兩個問題本來就不同。
  const orphanConfirmed = captures.filter(
    (c) =>
      c.status === 'confirmed' &&
      !srsIds.has(c.id) &&
      toDateStr(new Date(c.created_at)) < today,
  );

  const dueItems = srsItems.filter((i) => isDue(i) && !pendingIds.has(i.capture_id));
  const dueReviews = dueItems
    .map((i) => byId.get(i.capture_id))
    .filter((c): c is Capture => c !== undefined);

  return {
    officialPending,
    orphanConfirmed,
    dueReviews,
    badge: officialPending.length + orphanConfirmed.length + dueItems.length,
  };
}

/**
 * 出題用的佇列。順序固定：正式 pending → 孤兒 confirmed → 到期複習。
 * **這是全 app 第二份也是最後一份今日佇列**（`liveActivity.ts` 鐵律②）——
 * `quiz.ts` / `notifications.ts` 都不准自己查 store 再算一次。
 */
function quizQueue(buckets: TodayBuckets): Capture[] {
  return [...buckets.officialPending, ...buckets.orphanConfirmed, ...buckets.dueReviews];
}

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
  /**
   * 環狀緩衝與開機探針都在模組層（不是 state），React 不會因為它們被寫入而重繪。
   * 這個計數器就是唯一的重繪訊號。倒帶事件本來就稀少，每筆一次 render 可以接受。
   */
  const [probeVersion, setProbeVersion] = useState(0);
  /** 上一次排程結果。初值讀模組層的快取，讓還沒 sync 完的那幾百毫秒也有東西可印。 */
  const [quizStatus, setQuizStatus] = useState<QuizStatus | null>(() => getLastQuizStatus());
  /** 剛從通知按鈕收割回來的那一筆，只顯示一行、幾秒後自己消失。 */
  const [quizFeedback, setQuizFeedback] = useState<QuizOutcome | null>(null);

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

  /** 探針寫完之後蓋時間戳 + 逼一次重繪（探針在模組層，React 看不到它變了）。 */
  const stampBootProbe = () => {
    audioBootProbe.at_iso = new Date().toISOString();
    setProbeVersion((v) => v + 1);
  };

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
        audioBootProbe.audio_mode_ok = true;
        /**
         * 🔴 **這一段自己 try/catch**，不能靠外層那個 `.catch`。
         *
         * 原本兩件事共用一個 `.catch(err => console.warn('[audio] setAudioModeAsync
         * failed:', err))`——`setActiveForLockScreen` 一 throw 就會被報成
         * 「setAudioModeAsync 壞了」。那是「鎖屏 0 筆」到今天查不出來的直接成因：
         * 訊息指向一個根本沒出事的函式。
         *
         * 先記 `typeof` 再呼叫：舊 binary 上這顆函式是 undefined，呼叫會丟
         * TypeError，而「函式不存在」與「函式失敗」是完全不同的結論。
         */
        try {
          audioBootProbe.lock_screen_fn = typeof playerRef.current.setActiveForLockScreen;
          playerRef.current.setActiveForLockScreen(true, lockScreenMetaRef.current, {
            showSeekBackward: true,
            showSeekForward: true,
          });
          audioBootProbe.lock_screen_ok = true;
        } catch (err) {
          audioBootProbe.lock_screen_ok = false;
          audioBootProbe.error = `[lockScreen] ${errText(err)}`;
          console.warn('[audio] setActiveForLockScreen failed:', err);
        }
        stampBootProbe();
      })
      .catch((err) => {
        audioBootProbe.audio_mode_ok = false;
        audioBootProbe.error = `[audioMode] ${errText(err)}`;
        console.warn('[audio] setAudioModeAsync failed:', err);
        stampBootProbe();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Hydrate the local store, keep the practice-tab badge in sync（規則見
  // computeTodayBuckets 的檔頭），並把同一份佇列餵給每日提醒與題目通知。
  //
  // **佇列只算在這裡一處。** quiz.ts / notifications.ts 不准自己查 store 再算一次
  // （liveActivity.ts 鐵律②：那會是第三份實作，保證重演「徽章說有 3 張、點進去是
  // 空的」）。
  useEffect(() => {
    const refreshBadge = () => setPracticeBadge(computeTodayBuckets().badge);
    /** 重算佇列 → 重排題目通知。內部有 10 分鐘 + 日期節流，多呼叫幾次是安全的。 */
    const resyncQuiz = () => {
      const buckets = computeTodayBuckets();
      setPracticeBadge(buckets.badge);
      void syncQuizNotifications(quizQueue(buckets)).then(setQuizStatus);
    };
    void initStore().then(() => {
      resyncQuiz();
      void syncDailyReminder(); // app 開啟時重排（冪等，內部已去重）
    });
    // ⚠️ subscribe 的回呼**只重算 badge**：store 每次 notify 都排一次通知會變成
    // I/O 風暴（框選一次就 upsert 一次）。
    const unsubscribe = subscribe(refreshBadge);
    // 跨午夜回前景時日界線變了 → 重算 badge（今天的 pending 變成昨天的），順便讓
    // 題目通知跟上新的一天。
    const appStateSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') resyncQuiz();
    });
    return () => {
      unsubscribe();
      appStateSub.remove();
    };
  }, []);

  /**
   * 通知回應的唯一入口。兩條路都要接：
   *
   *   - **listener**：app 已經活著的時候（前景／背景 warm start）。
   *   - **getLastNotificationResponse()**：**冷啟動**那一次。原本只掛 listener，
   *     所以「app 被殺 → 點通知」這條路徑的回應整個收不到——每日提醒的導頁也一樣
   *     漏，只是沒人注意到而已。
   *
   * 題目通知的按鈕全部 `opensAppToForeground: true`（見 notifications.ts）：killed
   * app 要在按鈕當下跑 JS 得用 `registerTaskAsync` 背景任務，而 JS 在那個窗口不保證
   * 跑得完（expo #36282 至今未解）。所以答案不是在按下的當下處理，而是**把 app 帶到
   * 前景、再從這裡讀回來**——這是唯一可靠的路徑，不是偷懶。
   */
  useEffect(() => {
    if (Platform.OS === 'web') return;

    const handle = (response: Notifications.NotificationResponse) => {
      const kind = (response.notification.request.content.data as { kind?: string } | null)
        ?.kind;

      /**
       * 冪等的第二層，**兩條分支都要做**（不能只做題目那條）。
       *
       * 原生模組的 lastResponse 會**跨啟動留著**，直到有人清掉它。官方文件對
       * `clearLastNotificationResponse` 的說明就是這個情境：「當 app 依通知回應
       * 選擇路由、而該回應已經處理完之後，不該再繼續選那個路由。」
       *
       * 少了這一行的後果分兩種，兩種都是真的會發生：
       *   - 每日提醒：點過一次之後，**之後每一次手動冷啟動**都會重播那一筆——
       *     使用者只是想開 app 聽 podcast，卻被暫停播放、關掉覆蓋層、甩到練習頁。
       *   - 題目通知：`seenQuizKeys` 是模組層的（process 一重啟就空），所以同一個
       *     答案會在下一次冷啟動被重新收割，對同一張卡再寫一次 'again'。
       * 這一行必須在分支**之前**：它與「這是哪一種通知」無關，是「這一筆已經處理
       * 過了」的意思。
       */
      clearLastResponse();

      if (kind === QUIZ_KIND) {
        void harvestQuizResponse(response).then((outcome) => {
          // null = 重複收割或解析不出來 → 什麼都不顯示，也什麼都不做。
          if (outcome) setQuizFeedback(outcome);
        });
        /**
         * **按答題按鈕不暫停播放、不關覆蓋層、不切分頁。** 按鈕已經把 app 帶到前景
         * （那本身就夠打擾了），再把他正在聽的東西按停、把畫面換掉，代價遠大於一行
         * 回饋的價值。只有點通知本體（DEFAULT）才導頁，語意與每日提醒相同。
         */
        if (response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) {
          playerRef.current.pause();
          setNowPlayingOpen(false);
          setTranscriptOpen(false);
          setTab('practice');
        }
        return;
      }

      // 既有行為：每日提醒（或任何非題目通知）→ 落在練習頁。
      playerRef.current.pause();
      setNowPlayingOpen(false);
      setTranscriptOpen(false);
      setTab('practice');
    };

    // 舊 binary 上這兩支是 UnavailabilityError（JS bundle 一定比原生早到），
    // 所以包起來：收不到答案是可惜，把 app 弄 crash 是災難。
    try {
      const last = Notifications.getLastNotificationResponse(); // 冷啟動那一次
      if (last) handle(last);
    } catch (err) {
      console.warn('[notifications] getLastNotificationResponse unavailable:', err);
    }
    const sub = Notifications.addNotificationResponseReceivedListener(handle);
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 回饋只是一行字，4 秒後自己消失（它不是通知，不該常駐在畫面上）。
  useEffect(() => {
    if (!quizFeedback) return;
    const id = setTimeout(() => setQuizFeedback(null), QUIZ_FEEDBACK_MS);
    return () => clearTimeout(id);
  }, [quizFeedback]);

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

    const delta = prev - currentTime;
    // **連 0.1 秒的抖動都收**（判定順序與三道閘完全不變，只是每個 early return 之前
    // 先留一筆帳）。門檻設在 0 以上是儀器化的關鍵：只有全收，才分得出「被閘擋掉」
    // 與「跳動根本沒送到 JS」——後者代表問題在更上游（鎖屏控制項壓根沒啟用），
    // 那是調任何門檻都救不回來的。
    if (delta <= 0) return;

    const now = Date.now();
    const gate2MarginMs = ignoreJumpUntilRef.current - now;
    const commanded = lastCommandedRef.current;
    const gate3Dist = commanded === null ? null : Math.abs(currentTime - commanded);

    const record = (verdict: RewindVerdict) => {
      pushRewindProbe({
        at_ms: now,
        at_iso: new Date(now).toISOString(),
        episode_id: episode.id,
        prev,
        next: currentTime,
        delta,
        gate2_margin_ms: gate2MarginMs,
        commanded,
        gate3_dist: gate3Dist,
        verdict,
        app_state: AppState.currentState,
        playing: status.playing,
        rate,
      });
      setProbeVersion((v) => v + 1);
    };

    // 閘②：seekTo 開的時間窗內，位置跳動一律當成自家造成的。
    if (gate2MarginMs > 0) {
      record('settle-ms');
      return;
    }
    // 閘①：小於 3 秒的位置變動是緩衝抖動或微調拖曳，不是「我沒聽懂」。
    if (delta < EXTERNAL_REWIND_MIN_SEC) {
      record('min-sec');
      return;
    }
    // 閘③：自家的 seek 遲到才生效（音檔還在載入時送出的）會落在保險絲之外。認位置比
    // 認時間可靠：寧可漏記一筆，也不要無中生有——幻覺事件會替一句學習者從沒重聽過的
    // 話建出 capture，那比少一筆更傷。
    if (gate3Dist !== null && gate3Dist <= SEEK_SETTLE_SEC) {
      record('commanded');
      return;
    }
    record('logged');
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

  /** 這次生命週期內剛加入的詞。store 沒有「這個詞存了沒」的訂閱，而按鈕必須
   *  在同一次開啟裡就翻面；跨重啟那一半由 isTermSaved 查 store 補上。 */
  const [justSaved, setJustSaved] = useState<ReadonlySet<string>>(() => new Set());
  const termKey = (t: Term) => `${episode.id}|${t.segment_id}|${t.term}`;

  /**
   * 標註詞 → 它所在的那一句。
   *
   * `Term.segment_id` 是 `segmentKey`（start×10），只還原得出 start；capture 的
   * 窗口還要 end 與整句文字，所以一定要回 transcript 快取拿真正的 segment。
   * **找不到就是 null，絕不拿 segment_id/10 猜一個 end 湊窗口**——那是在資料庫
   * 裡捏造一段從沒發生過的時間範圍。窗口重轉會讓 Whisper 斷句挪動零點幾秒、
   * segmentKey 跟著改變，反查 miss 是正常情形（那時按鈕不出現）。
   */
  const activeTermSegment = useMemo(
    () =>
      activeTerm
        ? getSegments(episode.id).find((s) => segmentKey(s) === activeTerm.segment_id) ?? null
        : null,
    [activeTerm, episode.id],
  );

  const activeTermSaved =
    activeTerm !== null &&
    (justSaved.has(termKey(activeTerm)) ||
      (activeTermSegment !== null &&
        isTermSaved(episode.id, activeTermSegment, activeTerm.term)));

  /**
   * 最弱的一級訊號：他沒有倒帶，只是點了 app 標的詞說想學。
   * 不 seek、不 pause、不建 replay event——播放位置紋風不動，所以也踩不到
   * ADR-0016 的外部倒帶推斷。
   */
  const saveActiveTerm = () => {
    if (!activeTerm || !activeTermSegment) return;
    commitSavedTerm({
      episodeId: episode.id,
      segment: activeTermSegment,
      text: activeTerm.term,
      durationSec: duration,
    });
    setJustSaved((prev) => new Set(prev).add(termKey(activeTerm)));
  };

  // 換集：sheet 開著時換集再按加入練習，capture 會被記到新的一集上、時間戳指向
  // 一段根本不存在那句話的音檔——那種錯誤在資料裡看起來完全合法，抓不出來。
  useEffect(() => {
    setActiveTerm(null);
  }, [episode.id]);

  /**
   * NowPlaying 把它印成「今天 N 次重聽」，所以這裡只能裝**重聽**。
   *
   * 框選（trigger_source 'select'）刻意不進 `events`：它不 seek、不動播放位置，
   * 本來就不是重聽（selection.ts 的三條禁令）。把它算進來只會讓這個數字說謊，
   * 而這個數字正是整個產品的論點。它自己的遠端事件由 commitSelection 直送
   * syncReplayEvent，不經過外殼。
   *
   * strength 'saved'（點了標註詞說想學）同理不得進來——而且它連 replay event 都
   * 沒有：`commitSavedTerm` 是全 app 唯一一條不建事件的寫入路徑。所以這裡不需要
   * 加任何過濾：`events` 只由 logReplayEvent 灌，而上面的 saveActiveTerm 從頭到尾
   * 沒碰它。這是**驗證過的**，不是假設——setEvents 全檔只出現在 logReplayEvent
   * 內部，而 logReplayEvent 的呼叫端只有 back15、onSeekFromUi(isRewind)、與外部
   * 倒帶偵測那三處。
   */
  const todayCount = useMemo(() => {
    const today = new Date().toDateString();
    return events.filter((e) => new Date(e.created_at).toDateString() === today).length;
  }, [events]);

  const loadState = status.isLoaded ? (status.isBuffering ? '緩衝中…' : null) : '載入音檔中…';

  // 緩衝在模組層、React 看不到它變了，所以重繪的依據是 probeVersion 而不是陣列本身。
  const probes = useMemo(() => getRewindProbes(), [probeVersion]);

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

        {/* 剛剛在通知上按的那一題。綠色只出現在這裡——那是**他**答的。 */}
        <QuizFeedback outcome={quizFeedback} />

        {/* 倒帶推斷與題目排程的自我報告。UpdateStatus 沒有 owner，所以這塊自己長在
            外殼裡，視覺規格照抄它（收合一行、caption、C.faint）。 */}
        <DevProbes probes={probes} boot={audioBootProbe} quiz={quizStatus} />

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
      <TermSheet
        term={activeTerm}
        canSave={activeTermSegment !== null}
        saved={activeTermSaved}
        onSave={saveActiveTerm}
        onClose={() => setActiveTerm(null)}
      />
    </View>
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * 開發期讀數。**這一塊只用 C.dim / C.faint / C.highlightInk**——它是 chrome 與
 * app 的自我報告，不是學習者的動作。綠色只留給下面那一行「答對了」。
 * ─────────────────────────────────────────────────────────────────────────── */

/** 展開後印幾筆倒帶。12 筆一個畫面截得下，也夠看出一次實測的節奏。 */
const PROBE_ROWS = 12;

const APP_STATE_SHORT: Record<string, string> = {
  active: 'fg',
  background: 'bg',
  inactive: 'ina',
};

function flag(v: boolean | null): string {
  return v === null ? '…' : v ? 'ok' : 'fail';
}

function clockTime(atMs: number): string {
  const d = new Date(atMs);
  const p = (n: number) => `${n}`.padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 被哪一道閘擋掉。三道閘的數字一起印出來，才看得出「差多少就過了」。 */
function verdictText(p: RewindProbe): string {
  switch (p.verdict) {
    case 'logged':
      return '已記錄';
    case 'settle-ms':
      return `閘②時間窗 ${Math.round(p.gate2_margin_ms)}ms`;
    case 'min-sec':
      return `閘①<${EXTERNAL_REWIND_MIN_SEC}s`;
    case 'commanded':
      return `閘③ |Δ|=${(p.gate3_dist ?? 0).toFixed(1)}`;
  }
}

function probeLine(p: RewindProbe): string {
  const where = APP_STATE_SHORT[p.app_state] ?? p.app_state;
  // 暫停時的往回跳很不尋常（多半是換集或載入），標出來；播放中是常態，不加噪音。
  const paused = p.playing ? '' : ' 暫停';
  return `${clockTime(p.at_ms)}  −${p.delta.toFixed(1)}s  ${verdictText(p)}  ${where} ${p.rate}×${paused}`;
}

function DevProbes({
  probes,
  boot,
  quiz,
}: {
  probes: readonly RewindProbe[];
  boot: AudioBootProbe;
  quiz: QuizStatus | null;
}) {
  const [open, setOpen] = useState(false);
  // 'function' 以外就是這顆 binary 沒有那支原生函式——那比任何一道閘更能解釋
  // 「lockscreen 0 筆」，所以它要在收合狀態就變色。
  const bootBad =
    boot.lock_screen_fn !== 'function' ||
    boot.audio_mode_ok === false ||
    boot.lock_screen_ok === false;

  return (
    <View>
      <Pressable onPress={() => setOpen((v) => !v)} hitSlop={8} style={styles.probeToggleRow}>
        <Text style={[styles.probeToggle, bootBad && styles.probeToggleWarn]}>
          {`倒帶 ${probes.length} 筆 · 題目 ${quiz?.scheduled ?? 0}`}
        </Text>
      </Pressable>

      {open && (
        <View style={styles.probeCard}>
          <Text style={bootBad ? styles.probeWarn : styles.probeLine}>
            {`鎖屏 API ${boot.lock_screen_fn} · audioMode ${flag(boot.audio_mode_ok)} · setActive ${flag(boot.lock_screen_ok)}`}
          </Text>
          {boot.error !== null && <Text style={styles.probeWarn}>{boot.error}</Text>}

          {/* 「今天為什麼沒有題目」。今天的正確答案就是「沒有 gloss_zh 所以不出題」——
              沒有這一行，使用者會以為功能壞了。 */}
          <Text style={styles.probeLine}>{quiz?.summary_zh ?? '尚未檢查'}</Text>

          {probes.length === 0 ? (
            <Text style={styles.probeLine}>
              還沒偵測到任何位置回跳（連 0.1 秒的抖動都會記）
            </Text>
          ) : (
            probes.slice(0, PROBE_ROWS).map((p, i) => (
              <Text
                key={`${p.at_ms}-${i}`}
                style={p.verdict === 'logged' ? styles.probeMono : styles.probeMonoWarn}
              >
                {probeLine(p)}
              </Text>
            ))
          )}
          {/* 沒有複製按鈕：clipboard 要新套件，本輪禁令。實測完截圖回報即可。 */}
        </View>
      )}
    </View>
  );
}

/** 剛剛在通知按鈕上答的那一題。滑掉／點通知本體不顯示——那兩個不是答案。 */
function QuizFeedback({ outcome }: { outcome: QuizOutcome | null }) {
  if (!outcome) return null;
  const line = quizFeedbackText(outcome);
  if (!line) return null;
  return <Text style={[styles.quizFeedback, { color: line.color }]}>{line.text}</Text>;
}

function quizFeedbackText(o: QuizOutcome): { text: string; color: string } | null {
  if (o.action === 'dismiss' || o.action === 'tap') return null;

  // 綠＝學習者動手了。**全 app 只有這一行的綠色是這個意思**，儀表區其餘一律 dim。
  if (o.action === 'answer' && o.correct) {
    return {
      text: o.correct_label_zh ? `答對了 · ${o.correct_label_zh}` : '答對了',
      color: C.accent,
    };
  }

  // 「今天會再出現一次」是對 SRS 的承諾，**只有真的寫回去了才敢講**。寫不回去是
  // 真的會發生的，而且不只一種原因——所以尾巴那句話要看 `srs_skip` 講對是哪一種，
  // 不能一律說「這張卡不在今天的佇列裡」（對一張 pending 的卡那就是句謊話）。
  const tail = o.srs_written ? '今天會再出現一次' : skipTailZh(o.srs_skip);

  if (o.action === 'unknown') {
    return o.srs_written
      ? { text: `記下來了 · ${tail}`, color: C.dim }
      : { text: `想不起來 · ${tail}`, color: C.highlightInk };
  }
  const label = o.correct_label_zh ?? '—';
  // 琥珀＝app 在講自己的判斷（正解是我們給的）。
  return { text: `正解是 ${label} · ${tail}`, color: C.highlightInk };
}

/** 沒推進 SRS 時，尾巴那句話。**每一句都要是當下真的成立的事實。** */
function skipTailZh(skip: QuizOutcome['srs_skip']): string {
  switch (skip) {
    case 'stale-deck':
      return '這是昨天的題目，沒有動今天的排程';
    case 'card-missing':
      return '這張卡不在這台裝置上';
    // pending 的卡沒有推進 SRS，但它**確實**每天都在正式佇列裡——所以這句話講的是
    // 「去練習頁」，不是「今天會再出現一次」（後者是對 SRS 的承諾，這裡沒有寫）。
    case 'card-unconfirmed':
      return '這張卡還沒確認，練習頁裡有它';
    case 'card-dismissed':
      return '你已經把這張卡標成分心，不再排它';
    case 'write-failed':
      return '這次沒記錄成功';
    default:
      return '沒有記錄這一筆';
  }
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

  // 讀數區。整組照抄 UpdateStatus 的視覺規格（收合一行、caption、C.faint；
  // 展開是 surface + R.md + border 的卡片），兩塊讀數並排時才不會像兩個系統。
  probeToggleRow: { alignSelf: 'flex-end', marginTop: SP(1) },
  probeToggle: { ...TYPE.caption, color: C.faint, fontWeight: '400' },
  probeToggleWarn: { color: C.highlightInk },
  probeCard: {
    marginTop: SP(2),
    backgroundColor: C.surface,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.border,
    padding: SP(3),
    gap: SP(1.5),
  },
  probeLine: { ...TYPE.caption, color: C.dim, fontWeight: '400' },
  probeWarn: { ...TYPE.caption, color: C.highlightInk, fontWeight: '400' },
  // 數字要對齊才看得出「跳幅是不是每次都一樣」，所以走 mono（tabular-nums）。
  probeMono: { ...TYPE.mono, color: C.dim, fontWeight: '400' },
  probeMonoWarn: { ...TYPE.mono, color: C.highlightInk, fontWeight: '400' },

  quizFeedback: { ...TYPE.caption, marginTop: SP(1), fontWeight: '400' },

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
