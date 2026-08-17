/**
 * 本地通知 —— 兩條**互不干涉**的線：
 *
 *   ① 每日提醒（`daily-reminder`）：一則 DAILY repeating、純文字、無按鈕。
 *      **本輪一行都沒改。** 出不出得了題目都不影響它，所以「今天沒有題目」的
 *      降級狀態就是「回到今天的樣子」。
 *   ② 題目通知（`daily-quiz`）：互動式，一則一題、三個選項 + 一個「想不起來」。
 *      這是 Live Activity 的 JS 替代——widget extension 不能 OTA，本地排程 + 通知
 *      category 補到七成。
 *
 * **為什麼四顆按鈕全部 `opensAppToForeground: true`（這是可靠性的選擇，不是偷懶）：**
 * 官方文件明說 app 被**殺掉**（不只是背景）時，`opensAppToForeground: false` 的
 * action **不會**觸發 `NotificationResponseReceived` listener；那條路要走
 * `registerTaskAsync` 背景任務，而 JS 在那個窗口不保證跑完（expo #36282 至今未解）。
 * 所以按鈕開 app、再用 `getLastNotificationResponse()` 把答案讀回來，是**唯一可靠**
 * 的路徑。代價是每次作答都會把 app 帶到前景——所以 `App.tsx` 那側刻意不暫停播放、
 * 不切分頁（見 §4.3），把打擾降到只有「app 打開了」這一件事。
 *
 * **SRS 回寫是單向的**（規範，見 ADR-0022）：只有**答錯**與**想不起來**寫
 * `gradeSrsItem(item, 'again')`，答對／滑掉／點通知本體一律**不動 SRS**、
 * 不改 `capture.status`、不呼叫 `addPracticeRecord`、不進 daily session 或北極星。
 * 理由：ADR-0021⑤ 禁止鎖屏答題推進 SRS，是因為 1/3 猜對率會灌水 ADR-0011 的北極星
 * ——那個理由**只對「答對」成立**。答錯與想不起來是**相反方向**的證據：它只會把卡片
 * 拉回今天、把 ease 調低，不可能灌水任何指標，而且那是使用者親口說的「我不會」。
 * 所以本輪採單向寫入：**只准往「更常出現」的方向動，不准往「掌握了」的方向動。**
 * 這是 ADR-0021⑤ 的**收窄**（narrowing），不是 supersede。
 *
 * 再加一道**卡片資格閘**：只有 `confirmed` / `practiced` 的卡會真的寫。`pending` 的卡
 * 本來就每天在正式佇列裡，寫了不換來任何東西，卻可能在他之後按「只是分心，滑掉」時
 * 留下一張沒有畫面收得掉的幽靈卡（完整論證在 `harvestQuizResponse` 裡）。
 *
 * **DISMISS 的可靠性但書：** Apple 只在使用者**明確清除**通知時才觸發
 * `customDismissAction`（忽略通知、撥掉 banner 都不算），而且它不開前景，app 被殺時
 * 那一按仍落在 expo #36282 的窗口裡。所以「連續幾天被滑掉 ⇒ 提醒時間錯了」的
 * **分母是不完整的**：`DISMISS` 只能當 best-effort 訊號，
 * **不准拿它的缺席當「他沒滑掉」的證據**。
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import type { ChosenId, OptionId } from './liveActivity';
import {
  buildQuiz,
  nextSlotDate,
  QUIZ_CATEGORY_PREFIX,
  QUIZ_SLOTS,
  type QuizQuestion,
  type QuizStatus,
} from './quiz';
import { gradeSrsItem, newSrsItem, toDateStr, todayStr } from './srs';
import {
  getCapture,
  getCaptures,
  getSrsItem,
  initStore,
  upsertSrsItem,
} from './store';
import type { Capture } from './types';
import { t } from './i18n';

// 給 App.tsx 用的型別，從這裡一併 re-export，省得呼叫端要記住哪個型別住在哪個檔。
export type { QuizStatus, QuizQuestion, QuizBlockedReason } from './quiz';

export const DAILY_REMINDER_HOUR = 8; // 預設 08:00，之後設定頁可調
export const DAILY_REMINDER_MINUTE = 0;
const REMINDER_KIND = 'daily-reminder';

/**
 * 題目通知的 `data.kind` 與 Android channel id。
 *
 * ⚠️ 它含 `-`，所以**絕不可以拿來當 category identifier**（官方限制，見
 * `QUIZ_CATEGORY_PREFIX`）。兩者是不同的命名空間，別圖省事共用。
 */
export const QUIZ_KIND = 'daily-quiz';

/** iOS 沒有 exported 的 dismiss 常數，字面值就是它。 */
export const IOS_DISMISS_ACTION_IDENTIFIER =
  'com.apple.UNNotificationDismissActionIdentifier';

/**
 * action identifier。與 category identifier 同一套字元規則（**無 `:` / `-`**），
 * 所以是 `quizA` 不是 `quiz-a`。
 *
 * 靠**位置**對應到 `options[0..2]`，**不是**直接用 option 的 id（'a'/'b'/'c'）當
 * identifier：選項順序已經洗過，用 id 當按鈕 id 會在洗牌後錯位，把答案記到別的選項上。
 */
const QUIZ_ACTION_IDS = ['quizA', 'quizB', 'quizC'] as const;
/** 逃生口。**不是第四個選項**——猜對率的分母永遠是 3（`liveActivity.ts` 鐵律⑤）。 */
const QUIZ_UNKNOWN_ACTION_ID = 'quizUnknown';

/** 呼叫端可以放心每次 AppState active 都呼叫；真正的排程 I/O 由這道節流擋住。 */
const QUIZ_SYNC_MIN_INTERVAL_MS = 10 * 60_000;

const OPTION_IDS: readonly OptionId[] = ['a', 'b', 'c'];

// App 在前景時也顯示 banner（SDK 57：shouldShowAlert 已棄用）
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

async function ensurePermissions(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const req = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  return req.granted;
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 每日提醒（本輪未改動）
// ─────────────────────────────────────────────────────────────────────────────

/** 取消舊提醒＋用最新 pending 數重排。冪等，app 每次開啟呼叫一次即可。 */
export async function syncDailyReminder(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    if (!(await ensurePermissions())) return; // 拒絕 → 靜默略過，練習 badge 仍是主迴圈
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(REMINDER_KIND, {
        name: t('noti.channel_daily'),
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    // 去重：只認 data.kind 標籤，不存 identifier（避免 stale id）
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      scheduled
        .filter(
          (r) => (r.content.data as { kind?: string } | null)?.kind === REMINDER_KIND,
        )
        .map((r) => Notifications.cancelScheduledNotificationAsync(r.identifier)),
    );
    const n = getCaptures().filter((c) => c.status === 'pending').length;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: t('noti.daily_title'),
        body:
          n > 0
            ? t('noti.daily_body_n', { n })
            : t('noti.daily_body_0'),
        data: { kind: REMINDER_KIND },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: DAILY_REMINDER_HOUR,
        minute: DAILY_REMINDER_MINUTE,
        ...(Platform.OS === 'android' ? { channelId: REMINDER_KIND } : null),
      },
    });
  } catch (err) {
    console.warn('[notifications] syncDailyReminder failed:', err); // 通知失敗絕不影響 app
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 題目通知：排程
// ─────────────────────────────────────────────────────────────────────────────

let lastQuizStatus: QuizStatus | null = null;
let lastSyncAtMs = 0;
let lastSyncDate = '';

/** 最近一次 `syncQuizNotifications` 的結果。沒 sync 過回 null。 */
export function getLastQuizStatus(): QuizStatus | null {
  return lastQuizStatus;
}

/**
 * 取消舊題目通知 → 出題 → 註冊 category → 重排。
 *
 * 佇列由呼叫端傳進來（`App.tsx` 的三桶），本檔**不查 store 算佇列**。
 * 冪等且有節流，呼叫端可以在每次 AppState 變 active 時呼叫。
 */
export async function syncQuizNotifications(queue: Capture[]): Promise<QuizStatus> {
  if (Platform.OS === 'web') {
    return makeStatus({
      scheduled: 0,
      summary_zh: t('noti.web_skip'),
    });
  }

  const today = todayStr();
  const now = Date.now();
  // 日期一變就一定重排（跨午夜回前景時佇列已經換了一批）。
  if (
    lastQuizStatus &&
    lastSyncDate === today &&
    now - lastSyncAtMs < QUIZ_SYNC_MIN_INTERVAL_MS
  ) {
    return lastQuizStatus;
  }

  const status = await runQuizSync(queue, today);
  lastQuizStatus = status;
  // 失敗時也記時間戳：呼叫端每次 AppState active 都會呼叫，若失敗就跳過節流，
  // 一個持續失敗的原生錯誤會變成每次切回前景都跑一輪 I/O。代價是錯誤狀態最多
  // 停留 10 分鐘——可接受，而且 summary_zh 會如實寫出失敗原因。
  lastSyncAtMs = Date.now();
  lastSyncDate = today;
  return status;
}

/**
 * 示範模式：立刻排一則題目通知（預設 10 秒後響）。
 *
 * ## 它與正式路徑的關係
 *
 * **出題器完全共用**——一樣走 `buildQuiz` → `buildDeck` → `buildCard` 的同一組閘。
 * 只有兩件事不同：資料從呼叫端傳進來（`lib/demoDeck.ts`，不進 store），
 * 以及觸發時間被指定成「幾秒後」而不是下一個時段。
 *
 * 這一點很重要：如果示範模式自己寫一套簡化的出題邏輯，demo 上跑得動的東西就
 * 不代表產品跑得動。共用出題器意味著**示範會出題，就證明真資料也會出題**。
 *
 * ## 它推不動任何 SRS，而且那是對的
 *
 * `harvestQuizResponse` 第一件事是 `getCapture(card_id)`；示範 capture 不在 store 裡，
 * 所以回 `srs_skip: 'card-missing'`、**一個字都不寫**。示範答題可以看到回饋，
 * 但不會在 `difficulty_items` 留下任何一筆假資料。
 *
 * ⚠️ 這支**刻意不更新** `lastQuizStatus` / `lastSyncDate`：它排的是一則額外的示範
 * 通知，不是「今天的題目已經排好了」。讓它去動節流狀態，會使下一次真正的
 * `syncQuizNotifications` 被 10 分鐘節流擋掉，真題就這樣被示範題頂掉了。
 */
export async function fireDemoQuizSoon(
  queue: Capture[],
  delaySeconds = 10,
): Promise<QuizStatus> {
  if (Platform.OS === 'web') {
    return makeStatus({ scheduled: 0, summary_zh: t('noti.web_none') });
  }

  try {
    if (!(await ensurePermissions())) {
      return makeStatus({
        scheduled: 0,
        blocked: 'other',
        summary_zh: t('noti.no_perm_demo'),
      });
    }

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(QUIZ_KIND, {
        name: t('noti.channel_quiz'),
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    const built = buildQuiz({ queue, today: todayStr(), maxQuestions: 1 });
    const q = built.questions[0];
    if (!q) {
      return makeStatus({
        scheduled: 0,
        skipped: built.skipped,
        blocked: built.blocked,
        // 出不了題時要講**為什麼**——示範資料出不了題等於出題器有 bug，
        // 那比沒有通知嚴重得多，不能只顯示「0 題」。
        summary_zh: t('noti.demo_fail', { reason: built.summary_zh }),
      });
    }

    const fireDate = new Date(Date.now() + Math.max(5, delaySeconds) * 1000);
    await scheduleQuestion(q, QUIZ_SLOTS[0], fireDate);

    const secs = Math.max(5, delaySeconds);
    return makeStatus({
      scheduled: 1,
      skipped: built.skipped,
      summary_zh: t('noti.demo_ok', { s: secs, prompt: q.prompt }),
    });
  } catch (err) {
    console.warn('[notifications] fireDemoQuizSoon failed:', err);
    return makeStatus({
      scheduled: 0,
      blocked: 'other',
      summary_zh: t('noti.demo_error', { msg: errText(err) }),
    });
  }
}

/** 這支**永遠不丟例外**：任何失敗都轉成一個如實描述失敗的 QuizStatus。 */
async function runQuizSync(queue: Capture[], today: string): Promise<QuizStatus> {
  // 在 try 外面宣告，failure 分支才能回報**實際排出去幾則**而不是謊報 0。
  let scheduled = 0;
  let built: ReturnType<typeof buildQuiz> | null = null;

  try {
    if (!(await ensurePermissions())) {
      return makeStatus({
        scheduled: 0,
        blocked: 'other',
        summary_zh: t('noti.no_perm'),
      });
    }

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(QUIZ_KIND, {
        name: t('noti.channel_quiz'),
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    // 取消舊題目通知。**這是獨立的迴圈**——`syncDailyReminder` 的那個只認
    // 'daily-reminder'，兩邊各管各的，誰都不會誤刪對方的通知。
    const existing = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      existing
        .filter((r) => (r.content.data as { kind?: string } | null)?.kind === QUIZ_KIND)
        .map((r) => Notifications.cancelScheduledNotificationAsync(r.identifier)),
    );

    built = buildQuiz({ queue, today });

    // 清理舊 category：不清會逐日累積（一天最多三個，一個月就是九十個）。
    const keep = new Set(built.questions.map((q) => q.category_id));
    const categories = await Notifications.getNotificationCategoriesAsync();
    await Promise.all(
      categories
        .filter(
          (c) => c.identifier.startsWith(QUIZ_CATEGORY_PREFIX) && !keep.has(c.identifier),
        )
        .map((c) => Notifications.deleteNotificationCategoryAsync(c.identifier)),
    );

    // 出不了題就到此為止。**不排空通知、不排「今天沒有題目喔」這種佔位通知**——
    // 每日提醒已經覆蓋「今天該練習了」這個情境，再發一則只是在說我們沒東西給他。
    for (let i = 0; i < built.questions.length; i++) {
      const q = built.questions[i];
      const slot = QUIZ_SLOTS[i];
      if (!q || !slot) break; // questions ≤ 3 = QUIZ_SLOTS.length，理論上到不了
      await scheduleQuestion(q, slot);
      scheduled += 1;
    }

    return makeStatus({
      scheduled,
      skipped: built.skipped,
      blocked: built.blocked,
      summary_zh: built.summary_zh,
    });
  } catch (err) {
    console.warn('[notifications] syncQuizNotifications failed:', err);
    return makeStatus({
      scheduled,
      skipped: built?.skipped ?? [],
      blocked: built?.blocked ?? 'other',
      // 如實寫失敗原因：儀表上寧可出現一句難看的錯誤，也不要一句好看的謊話。
      summary_zh:
        scheduled > 0
          ? t('noti.sched_fail_at', { n: scheduled, msg: errText(err) })
          : t('noti.sched_fail', { msg: errText(err) }),
    });
  }
}

async function scheduleQuestion(
  q: QuizQuestion,
  slot: { hour: number; minute: number },
  /**
   * 示範模式用：直接指定觸發時間，跳過 `nextSlotDate` 的順延規則。
   *
   * 正式路徑**永遠不傳這一個**——順延到明天是刻意的（一開 app 就跳題目通知會讓人
   * 把通知權限關掉）。但 demo 現場沒辦法等到 12:30，所以留一個明確的旁路，
   * 而不是去把那條規則改鬆。
   */
  fireDateOverride?: Date,
): Promise<void> {
  /**
   * 🔴 `deck_date` 是**這則通知會在哪一天響**，不是「排程的今天」。
   *
   * `nextSlotDate` 會把已經過去的時段順延到**明天**（那是刻意的：一開 app 就跳
   * 一則題目通知會讓人把通知權限關掉）。所以任何在 12:30 之後跑的 sync，至少有一題
   * 是排給明天的。若把 `deck_date` 寫成排程當天，明天響的那則被作答時就會撞上
   * `harvestQuizResponse` 的日期閘（`deck_date !== todayStr()`）——SRS 一個字都不寫，
   * 畫面還回他一句「這張卡不在今天的佇列裡」，而它明明就在。
   *
   * 而這正好是**最該成立的那條路徑**：使用者一整天沒開 app，只從鎖定畫面按了一顆
   * 按鈕。日期閘要擋的是「隔了一天才回來按舊通知」，不是「排程跨過了午夜」。
   *
   * `nextSlotDate()` **只准算一次**：算兩次會在午夜前後拿到差一天的兩個答案，
   * 讓通知身上的 `deck_date` 與它真正的觸發時間對不起來。
   */
  const fireDate = fireDateOverride ?? nextSlotDate(slot);
  const deckDate = toDateStr(fireDate);

  // 一張題目一個 category：iOS 的 action 按鈕標題在**註冊時**就固定，而三個選項的
  // 中文是逐題不同的——共用一個 category 就只能寫「選項 A/B/C」，等於把題目藏起來。
  //
  // 重新註冊同一個 identifier 是安全的：`fixOptionOrder` 保證同一張卡永遠洗出同一個
  // 順序，所以這次註冊與上次**逐位元組相同**。（順序若會漂移，已經發出去、還躺在
  // 通知中心的那則通知會換上一組與它身上答案卷對不起來的按鈕——見 quiz.ts。）
  await Notifications.setNotificationCategoryAsync(q.category_id, quizActions(q), {
    // 要收到「明確清除」事件。但它的分母不完整，見檔頭的可靠性但書。
    customDismissAction: true,
    // 題面在關掉通知預覽時也要看得到——**標題就是題目**。
    showTitle: true,
    intentIdentifiers: [],
    allowInCarPlay: false,
  });

  await Notifications.scheduleNotificationAsync({
    content: {
      // 標題本身就是題面：iOS 的 action 按鈕預設收起來，要下拉才看得到。
      // 即使他不展開，光看到那個詞也已經是一次提取練習。
      title: q.prompt,
      body: t('noti.quiz_body'),
      categoryIdentifier: q.category_id, // iOS only
      data: {
        kind: QUIZ_KIND,
        quiz_id: `${deckDate}#${q.card_id}`, // '#' 不受 category 的字元限制約束
        card_id: q.card_id,
        deck_date: deckDate,
        // `correct_id` 隨通知走是**刻意的**：本輪不做遠端推播，這則通知從頭到尾
        // 沒離開過裝置；冷啟動時佇列可能已經換了一批，不把正解帶在身上就無法可靠
        // 判定對錯。要做推播的那一輪必須改成不帶正解（與 LiveActivityContentState
        // 同一條理由：那是會被序列化、可能經 push 傳輸的載體）。
        correct_id: q.correct_id,
        option_ids: q.options.map((o) => o.id),
        option_labels: q.options.map((o) => o.label_zh),
      },
    },
    trigger: {
      // 用 DATE（一次性）不用 DAILY：DAILY 會把同一題每天重播到天荒地老。
      // app 每次啟動都會重排，一次性正好。
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: fireDate, // 與上面的 deckDate 同一次計算，不准重算
      ...(Platform.OS === 'android' ? { channelId: QUIZ_KIND } : null),
    },
  });
}

function quizActions(q: QuizQuestion): Notifications.NotificationAction[] {
  const actions: Notifications.NotificationAction[] = q.options
    .slice(0, QUIZ_ACTION_IDS.length)
    .map((option, i) => ({
      identifier: QUIZ_ACTION_IDS[i] as string,
      buttonTitle: option.label_zh,
      // 明寫 true 雖然與預設相同——那是宣告意圖，見檔頭的可靠性論證。
      options: {
        opensAppToForeground: true,
        isDestructive: false,
        isAuthenticationRequired: false,
      },
    }));

  actions.push({
    identifier: QUIZ_UNKNOWN_ACTION_ID,
    buttonTitle: t('noti.quiz_unknown'),
    options: {
      opensAppToForeground: true,
      isDestructive: false,
      isAuthenticationRequired: false,
    },
  });

  return actions;
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 題目通知：收割 + SRS 回寫
// ─────────────────────────────────────────────────────────────────────────────

export type QuizAction = 'answer' | 'unknown' | 'dismiss' | 'tap';

/**
 * 「這一筆為什麼沒有推進 SRS」。
 *
 * 有這個欄位是因為 `srs_written: false` 有**好幾種完全不同的意思**，而畫面上那一行
 * 字必須講對是哪一種：對一張還在 pending 佇列裡的卡說「這張卡不在今天的佇列裡」，
 * 就是一句可以當場被戳破的謊。
 */
export type QuizSrsSkip =
  /** 不是今天那副牌（隔了一天才回來按舊通知）。 */
  | 'stale-deck'
  /** 本地找不到這張 capture（刪了、或換了裝置）。 */
  | 'card-missing'
  /** 卡還在 `pending`：他還沒說過這是不是真的難點。**它本來就每天在正式佇列裡。** */
  | 'card-unconfirmed'
  /** 卡已經是 `dismissed`：他親口說過那只是分心。 */
  | 'card-dismissed'
  /** 真的寫失敗了（例外）。 */
  | 'write-failed';

export interface QuizOutcome {
  quiz_id: string;
  card_id: string;
  deck_date: string;
  action: QuizAction;
  /** `action==='answer'` 時是 'a'|'b'|'c'；'unknown' 時是 'unknown'；其餘為 null。 */
  chosen: ChosenId | null;
  /** 'unknown' / 'dismiss' / 'tap' 恆為 false。 */
  correct: boolean;
  /** 使用者看到的正解中文（給前景那一行回饋用）。 */
  correct_label_zh: string | null;
  answered_at: string; // ISO 8601
  /** 這一筆有沒有**真的**推進 SRS。給儀表對帳用，不准憑 action 反推。 */
  srs_written: boolean;
  /**
   * `srs_written === false` 時的原因；有寫、或這個 action 本來就不該寫
   * （答對／滑掉／點通知本體）時為 null。
   */
  srs_skip: QuizSrsSkip | null;
}

/**
 * 冪等第一層：模組層的已收割集合。
 * key = `${request.identifier}:${actionIdentifier}`——同一則通知的不同按鈕是不同事件，
 * 但同一顆按鈕被冷啟動與 listener 各送一次就是同一筆。
 */
const seenQuizKeys = new Set<string>();

/** 純解析，**不寫任何東西**。不是題目通知 → null。 */
export function parseQuizResponse(
  response: Notifications.NotificationResponse,
): QuizOutcome | null {
  const data = response?.notification?.request?.content?.data as
    | Record<string, unknown>
    | null
    | undefined;
  // 不是題目通知就靜靜回 null，讓 App.tsx 走既有的每日提醒行為（不 warn，那是常態）。
  if (!data || data.kind !== QUIZ_KIND) return null;

  const card_id = str(data.card_id);
  const deck_date = str(data.deck_date);
  const correct_id = str(data.correct_id);
  const optionIds = strArray(data.option_ids);
  const optionLabels = strArray(data.option_labels);

  if (!card_id) {
    console.warn('[notifications] quiz notification without card_id:', data);
    return null;
  }

  const actionId = response.actionIdentifier;
  let action: QuizAction;
  let chosen: ChosenId | null = null;

  const optionIndex = (QUIZ_ACTION_IDS as readonly string[]).indexOf(actionId);
  if (optionIndex >= 0) {
    const picked = optionIds[optionIndex];
    // 對不回選項就**拒絕猜**：與其把一次作答記到不確定的選項上，不如整筆丟掉。
    if (!picked || !OPTION_IDS.includes(picked as OptionId)) {
      console.warn('[notifications] quiz answer cannot be mapped to an option:', data);
      return null;
    }
    action = 'answer';
    chosen = picked as ChosenId;
  } else if (actionId === QUIZ_UNKNOWN_ACTION_ID) {
    action = 'unknown';
    chosen = 'unknown';
  } else if (actionId === IOS_DISMISS_ACTION_IDENTIFIER) {
    action = 'dismiss';
  } else if (actionId === Notifications.DEFAULT_ACTION_IDENTIFIER) {
    action = 'tap';
  } else {
    console.warn('[notifications] unknown quiz action identifier:', actionId);
    return null;
  }

  // 「想不起來」永遠不算答對——它是逃生口，不是第四個選項。
  const correct = action === 'answer' && chosen !== null && chosen === correct_id;

  const correctIndex = optionIds.indexOf(correct_id);
  const correct_label_zh =
    correctIndex >= 0 ? (optionLabels[correctIndex] ?? null) : null;

  return {
    quiz_id: str(data.quiz_id) || `${deck_date}#${card_id}`,
    card_id,
    deck_date,
    action,
    chosen,
    correct,
    correct_label_zh,
    answered_at: new Date().toISOString(),
    srs_written: false, // 解析階段什麼都沒寫
    srs_skip: null, // …也還沒到「為什麼沒寫」那一步
  };
}

/**
 * 解析 + 去重 + 寫回。重複／不是題目通知 → null。
 *
 * SRS 回寫規則（規範，見檔頭）：
 *   選對      → 不動 SRS
 *   選錯      → gradeSrsItem(item, 'again')
 *   想不起來  → gradeSrsItem(item, 'again')
 *   明確滑掉  → 不動 SRS
 *   點通知本體 → 不動 SRS
 * 四種情況一律**不改 `capture.status`、不呼叫 `addPracticeRecord`**。
 *
 * 上面那個 `'again'` 還要再過一道**卡片資格閘**：只有 `confirmed` / `practiced` 的卡
 * 會真的寫下去（理由見函式內），其餘回 `srs_written: false` 並在 `srs_skip` 如實
 * 寫明是哪一種。
 */
export async function harvestQuizResponse(
  response: Notifications.NotificationResponse,
): Promise<QuizOutcome | null> {
  const outcome = parseQuizResponse(response);
  if (!outcome) return null;

  // 🔴 冪等第一層必須在**任何 await 之前**同步 check-and-add：冷啟動的
  // `getLastNotificationResponse()` 與 listener 可能送同一筆進來，兩邊都會在
  // `await initStore()` 上排隊，晚一步檢查就會雙寫（同一題被記兩次 'again'）。
  const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
  if (seenQuizKeys.has(key)) return null;
  seenQuizKeys.add(key);

  // 日期閘：昨天的答案不准動今天的排程（隔夜才開 app 的那條路徑）。
  // ⚠️ `deck_date` 是**通知響的那一天**（見 scheduleQuestion），不是排程當天——
  // 排在明天 12:30 的那則，明天按下去是「今天」，這道閘不該擋它。
  if (outcome.deck_date !== todayStr()) {
    console.warn(
      '[notifications] quiz answer from a previous deck date, not writing SRS:',
      outcome.deck_date,
    );
    // 仍然回傳，讓 UI 有東西顯示；srs_written 保持 false
    return { ...outcome, srs_skip: 'stale-deck' };
  }

  // **單向寫入**：只有答錯與想不起來會動 SRS，而且只往「更常出現」的方向動。
  const shouldWrite =
    (outcome.action === 'answer' && !outcome.correct) || outcome.action === 'unknown';
  if (!shouldWrite) return outcome;

  try {
    // 🔴 第一行必須是它：store.ts 的 persist 寫的是**整個 srsItems 陣列**，
    // 未 hydrate 就 upsert 會把 AsyncStorage 裡既有的 SRS 全部蓋成只剩一筆。
    await initStore();

    const capture = getCapture(outcome.card_id);
    if (!capture) {
      // 本地沒有這張卡（被刪了、或換裝置）就不寫：憑一個 card_id 造出 SRS item
      // 等於憑空生出一張沒有內容的卡，練習頁會拿到一個對不到 capture 的項目。
      console.warn('[notifications] quiz card no longer exists locally:', outcome.card_id);
      return { ...outcome, srs_skip: 'card-missing' };
    }

    /**
     * 🔴 **只推進「已經在複習流程裡」的卡**（`confirmed` / `practiced`）。
     *
     * `dismissed`：他親口說過那只是分心。繼續排它就是拿他否決過的東西煩他。
     *
     * `pending`：他還沒回答過「這段是真的沒聽懂嗎」。在這裡幫他生一個 SRS item
     * 會造出一張**沒有任何畫面收得掉的幽靈卡**：他之後在練習頁按「只是分心，滑掉」，
     * `status` 變 `dismissed`，但 SRS item 沒有人刪得掉（`store.ts` 沒有
     * `removeSrsItem`）。從那一刻起 `App.tsx` 的 `computeTodayBuckets` 會永遠把它算進
     * `dueItems`（那道 filter 只看 `isDue` 與 pendingIds，不看 `capture.status`），
     * 徽章永遠 +1；而 `Practice.tsx` 的複習佇列要求 `practiced | confirmed`，永遠不
     * 顯示它、也就永遠不會有人把它評分掉（`due_date` 停在過去，`isDue` 恆真）。
     * 那正是這個 repo 反覆寫下的那個最傷信任的病：**徽章說有 1 張、點進去是空的**。
     *
     * 而且對 pending 的卡來說，這一寫本來就**不換來任何東西**：昨天以前的 pending
     * 每天都在正式佇列裡（`officialPending`），今天照樣會出現在他面前。少寫這一筆
     * 沒有損失，寫下去卻可能留下一張清不掉的卡。
     *
     * （`dueReviews` 不過濾 `capture.status` 是 ADR-0022 記在案的既有落差，修它會動到
     * 徽章數字，是另一輪的題目。所以這裡走的是「不製造那個狀態」，而不是去改徽章。）
     */
    if (capture.status !== 'confirmed' && capture.status !== 'practiced') {
      return {
        ...outcome,
        srs_skip: capture.status === 'dismissed' ? 'card-dismissed' : 'card-unconfirmed',
      };
    }

    const item = getSrsItem(outcome.card_id) ?? newSrsItem(outcome.card_id);
    // `upsertSrsItem` 內部的遠端 syncSrsItem 若因 difficulty_items 的 FK 失敗
    // （capture 還沒上雲）只會 console.warn——本地那一份已經寫成功了，
    // 所以這裡回報 srs_written: true 是誠實的：**推進的是本地 SRS 排程**。
    upsertSrsItem(gradeSrsItem(item, 'again'));
    return { ...outcome, srs_written: true, srs_skip: null };
  } catch (err) {
    console.warn('[notifications] quiz SRS writeback failed:', err);
    // srs_written 維持 false——寫失敗就不准報成寫成功
    return { ...outcome, srs_skip: 'write-failed' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具（模組私有）
// ─────────────────────────────────────────────────────────────────────────────

function makeStatus(partial: {
  scheduled: number;
  skipped?: QuizStatus['skipped'];
  blocked?: QuizStatus['blocked'];
  summary_zh: string;
}): QuizStatus {
  return {
    scheduled: partial.scheduled,
    skipped: partial.skipped ?? [],
    blocked: partial.blocked ?? null,
    summary_zh: partial.summary_zh,
    checked_at: new Date().toISOString(),
  };
}

/** 通知的 data 走過一次序列化，型別保證在這裡就沒了——一律當 unknown 驗。 */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : '')) : [];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
