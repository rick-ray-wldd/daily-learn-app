/**
 * 介面語言 —— 繁體中文 ⇄ English。
 *
 * ## 為什麼一個學英語的 app 需要英文介面
 *
 * 因為使用者不只有中文母語者。`poster` 上那句「這不是英語產品，是聽力產品」講的
 * 就是這件事：倒帶這個訊號不帶語言。介面寫死中文，等於把產品綁在一個市場上。
 *
 * ## 這個檔的邊界（很重要）
 *
 * 它只管**靜態介面字串**。有兩類東西**不在**這裡，而且不可能在：
 *
 * 1. **模型生成的內容** —— `explanation_zh` / `gloss_zh` / `practice_tip_zh` 是
 *    `diagnose` / `annotate` 兩支 Edge Function 用中文 prompt 生出來、然後**存進
 *    資料庫**的。要英文得改伺服器端的 prompt 讓它同時生 `_en`，再重新部署——
 *    那不是 OTA 送得出去的東西。讀取端的 fallback 規則寫在 `pickLocalized()`。
 * 2. **podcast 內容本身** —— 逐字稿、集名、節目簡介都是來源給的，與介面語言無關。
 *
 * ## 為什麼不用 i18n 套件
 *
 * dependencies 是 14 個，硬上限（ADR-0018 / ADR-0021）。`i18n-js` 或
 * `react-i18next` 會多 1–3 個。而我們要的功能只有三件：查表、插值、切換時重繪。
 * 三件加起來不到 80 行，套件買不到相稱的東西。
 *
 * ## 切換時怎麼重繪
 *
 * 用 `useSyncExternalStore`（React 內建，不是新相依）。它是 React 官方為
 * 「外部可變狀態」設計的訂閱原語，比 Context 少一層 provider，也不會在
 * 切換語言時把整棵樹的 state 洗掉——**這一點很要緊**：使用者可能正在練習卡的
 * 第 3 張，切個語言不該把他踢回第 1 張。
 */
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Lang = 'zh-Hant' | 'en';

export const LANGS: readonly Lang[] = ['zh-Hant', 'en'];

/** 語言選單上顯示的名字。**一律用該語言自己的寫法**，不要翻譯它。 */
export const LANG_LABEL: Record<Lang, string> = {
  'zh-Hant': '繁體中文',
  en: 'English',
};

const STORAGE_KEY = 'echo.lang.v1';

/**
 * 預設繁體中文。
 *
 * 刻意**不**從系統語言推斷：這個 app 的第一批使用者是中文母語者在學英語，
 * 而他們的手機有相當比例是英文系統。照系統推斷會讓他們一開 app 就看到英文介面，
 * 而那正是他們裝這個 app 想避開的東西。要英文請自己切——切一次就記住了。
 */
let current: Lang = 'zh-Hant';
let hydrated = false;

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function getLang(): Lang {
  return current;
}

export function isLangHydrated(): boolean {
  return hydrated;
}

/**
 * 從磁碟讀回上次的選擇。**在 app 啟動時呼叫一次**。
 *
 * 讀失敗不丟例外：語言偏好壞掉不該讓 app 開不起來，退回預設中文就好。
 */
export async function initLang(): Promise<void> {
  if (hydrated) return;
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh-Hant') current = saved;
  } catch (err) {
    console.warn('[i18n] 讀取語言偏好失敗，用預設值:', err);
  }
  hydrated = true;
  emit();
}

/** 切換語言並持久化。寫入失敗只 warn——畫面已經切了，下次重開才會退回去。 */
export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  emit();
  void AsyncStorage.setItem(STORAGE_KEY, next).catch((err) =>
    console.warn('[i18n] 語言偏好寫入失敗:', err),
  );
}

export function subscribeLang(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 元件用這個訂閱語言。切換時只重繪，不重建 state。 */
export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, getLang, getLang);
}

/**
 * 取一段介面文字。
 *
 * `vars` 用 `{name}` 插值。**找不到 key 時回傳 key 本身**而不是空字串或丟例外：
 * 畫面上出現 `practice.confirm_yes` 很醜，但它會被立刻看見並修掉；
 * 空字串則是一個看不見的洞，可能上線好幾週都沒人發現。
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const table = DICT[current] ?? DICT['zh-Hant'];
  let s = table[key] ?? DICT['zh-Hant'][key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

/**
 * 讀模型生成的雙語欄位。
 *
 * `diagnose` / `annotate` 目前只生 `_zh`；等伺服器端 prompt 改成同時生 `_en`
 * 之後，這支才會真的回英文。**在那之前英文介面下仍會看到中文解釋**，
 * 而那是誠實的：假裝有英文（例如硬塞一句「English explanation unavailable」）
 * 會讓使用者以為功能壞了，不如給他真的有的那一份。
 *
 * @param zh 中文欄位值（一定有）
 * @param en 英文欄位值（可能沒有）
 */
export function pickLocalized(zh?: string, en?: string): string | undefined {
  if (current === 'en') return en?.trim() || zh;
  return zh?.trim() || en;
}

/** 陣列版（`distractors_zh` / `distractors_en`）。 */
export function pickLocalizedList(zh?: string[], en?: string[]): string[] | undefined {
  if (current === 'en') return en?.length ? en : zh;
  return zh?.length ? zh : en;
}

// ─────────────────────────────────────────────────────────────────────────────
// 字典
//
// key 命名：`<畫面>.<用途>`。同一句話在兩個畫面出現就給兩個 key——
// 共用 key 會在其中一邊要改字時綁住另一邊，而那種耦合看不見。
//
// ⚠️ 英文不是中文的直譯。中文版可以用「你」直接對著使用者說話，英文照翻會變得
// 過度親暱；反過來英文的簡潔在中文裡會顯得冷淡。兩邊各自寫得自然，意思一致就好。
// ─────────────────────────────────────────────────────────────────────────────

const ZH: Record<string, string> = {
  // ── 外殼 / 分頁 ──────────────────────────────────────────
  'tab.home': '首頁',
  'tab.browse': '探索',
  'tab.practice': '練習',
  'shell.language': '語言',

  // ── 首頁 ────────────────────────────────────────────────
  'home.now_playing': '正在播放',
  'home.nothing_playing': '還沒有在播的東西',
  'home.pick_episode': '去探索挑一集開始聽',
  'home.today_practice': '今日練習',
  'home.week_signal': '本週訊號',
  'home.streak': '連續',
  'home.streak_days': '{n} 天',
  'home.terms': '難點詞庫',
  'home.terms_empty': '還沒有標起來的詞',
  'home.browse': '探索',
  'home.rewinds': '重聽',
  'home.confirmed': '確認',
  'home.mastered': '掌握',

  // ── 播放器 ──────────────────────────────────────────────
  'player.back15': '往回 15 秒',
  'player.forward15': '往前 15 秒',
  'player.play': '播放',
  'player.pause': '暫停',
  'player.transcript': '逐字稿',
  'player.volume': '音量',

  // ── 逐字稿 ──────────────────────────────────────────────
  'transcript.title': '逐字稿',
  'transcript.loading': '轉錄中…',
  'transcript.none': '這一段還沒有逐字稿',
  'transcript.select_mode': '框選',
  'transcript.select_hint': '點第一個字，再點最後一個字',
  'transcript.cant_split': '我聽不出這裡有幾個字',
  'transcript.close': '關閉',

  // ── 難點詞 / 選取 ───────────────────────────────────────
  'term.add_to_practice': '＋ 加入練習',
  'term.added': '已加入練習',
  'term.guessed_by_app': 'app 標的，可能不準',
  'select.is_word': '單字',
  'select.is_pattern': '句型',
  'select.which': '這是單字還是句型？',
  'select.cancel': '取消',

  // ── 練習 ────────────────────────────────────────────────
  'practice.title': '今日練習',
  'practice.empty': '目前沒有待練項目',
  'practice.empty_cleared': '今天的正式練習已清空',
  'practice.fresh_header': '⚡ 搶先練（{n}）',
  'practice.fresh_start': '開始搶先練 {n} 張',
  'practice.card_of': '第 {i} / {total} 張',
  'practice.window': '難點窗口 {start} – {end}',
  'practice.rewound_times': '你在這裡重聽了 {n} 次',
  'practice.listen_first': '聽完再決定。是真的沒聽懂，還是只是分心？',
  'practice.confirm_yes': '這段是真的沒聽懂',
  'practice.confirm_no': '只是分心，滑掉',
  'practice.play_original': '▶ 原速',
  'practice.play_slow': '慢速 0.7x',
  'practice.reveal_clue': '線索',
  'practice.reveal_hint': '骨架',
  'practice.reveal_full': '全文',
  'practice.next': '下一張',
  'practice.done': '今天練完了',
  'practice.grade_again': '再來一次',
  'practice.grade_good': '記得',
  'practice.grade_easy': '很簡單',

  // ── 探索 ────────────────────────────────────────────────
  'browse.search_placeholder': '搜尋 podcast',
  'browse.subscriptions': '我的訂閱',
  'browse.results': '搜尋結果',
  'browse.episodes': '單集',
  'browse.subscribe': '訂閱',
  'browse.unsubscribe': '取消訂閱',
  'browse.loading': '載入中…',
  'browse.no_results': '找不到符合的節目',

  // ── 難度帶 ──────────────────────────────────────────────
  'level.unrated': '未評估',
  'level.1': '入門',
  'level.2': '初階',
  'level.3': '中階',
  'level.4': '中高階',
  'level.5': '進階',

  // ── 版本 / 更新 ─────────────────────────────────────────
  'update.checking': '檢查更新中…',
  'update.available': '有新版本，重開 app 就會套用',
  'update.latest': '已是最新版',
  'update.check': '檢查更新',
};

const EN: Record<string, string> = {
  'tab.home': 'Home',
  'tab.browse': 'Browse',
  'tab.practice': 'Practice',
  'shell.language': 'Language',

  'home.now_playing': 'Now playing',
  'home.nothing_playing': 'Nothing playing yet',
  'home.pick_episode': 'Go to Browse and pick an episode',
  'home.today_practice': "Today's practice",
  'home.week_signal': 'This week',
  'home.streak': 'Streak',
  'home.streak_days': '{n} days',
  'home.terms': 'Your gaps',
  'home.terms_empty': 'Nothing marked yet',
  'home.browse': 'Browse',
  'home.rewinds': 'Rewinds',
  'home.confirmed': 'Confirmed',
  'home.mastered': 'Mastered',

  'player.back15': 'Back 15 seconds',
  'player.forward15': 'Forward 15 seconds',
  'player.play': 'Play',
  'player.pause': 'Pause',
  'player.transcript': 'Transcript',
  'player.volume': 'Volume',

  'transcript.title': 'Transcript',
  'transcript.loading': 'Transcribing…',
  'transcript.none': 'No transcript for this stretch yet',
  'transcript.select_mode': 'Select',
  'transcript.select_hint': 'Tap the first word, then the last',
  'transcript.cant_split': "I can't tell where the words split",
  'transcript.close': 'Close',

  'term.add_to_practice': '+ Add to practice',
  'term.added': 'Added to practice',
  'term.guessed_by_app': 'Flagged by the app — may be wrong',
  'select.is_word': 'A word',
  'select.is_pattern': 'A pattern',
  'select.which': 'Is this a word or a pattern?',
  'select.cancel': 'Cancel',

  'practice.title': "Today's practice",
  'practice.empty': 'Nothing to practise right now',
  'practice.empty_cleared': "Today's queue is clear",
  'practice.fresh_header': '⚡ Practise early ({n})',
  'practice.fresh_start': 'Start {n} early',
  'practice.card_of': 'Card {i} of {total}',
  'practice.window': 'Difficulty window {start} – {end}',
  'practice.rewound_times': 'You rewound here {n}×',
  'practice.listen_first': "Listen first. Did you really miss it, or were you just distracted?",
  'practice.confirm_yes': "I really didn't catch it",
  'practice.confirm_no': 'Just distracted — skip',
  'practice.play_original': '▶ Full speed',
  'practice.play_slow': 'Slow 0.7×',
  'practice.reveal_clue': 'Clue',
  'practice.reveal_hint': 'Skeleton',
  'practice.reveal_full': 'Full text',
  'practice.next': 'Next',
  'practice.done': "That's today done",
  'practice.grade_again': 'Again',
  'practice.grade_good': 'Got it',
  'practice.grade_easy': 'Easy',

  'browse.search_placeholder': 'Search podcasts',
  'browse.subscriptions': 'Subscriptions',
  'browse.results': 'Results',
  'browse.episodes': 'Episodes',
  'browse.subscribe': 'Subscribe',
  'browse.unsubscribe': 'Unsubscribe',
  'browse.loading': 'Loading…',
  'browse.no_results': 'No shows matched',

  'level.unrated': 'Not rated',
  'level.1': 'Starter',
  'level.2': 'Easy',
  'level.3': 'Medium',
  'level.4': 'Hard',
  'level.5': 'Advanced',

  'update.checking': 'Checking for updates…',
  'update.available': 'Update ready — reopen the app to apply',
  'update.latest': "You're on the latest build",
  'update.check': 'Check for updates',
};

const DICT: Record<Lang, Record<string, string>> = { 'zh-Hant': ZH, en: EN };

/**
 * 開發期護欄：兩張表的 key 必須一樣多。
 *
 * 漏一個 key 的症狀是「英文介面裡冒出一句中文」——那在 demo 現場很難看，
 * 而且不會有任何錯誤訊息。這裡在 dev 時直接印出來。
 */
if (__DEV__) {
  const zhKeys = new Set(Object.keys(ZH));
  const enKeys = new Set(Object.keys(EN));
  const missingEn = [...zhKeys].filter((k) => !enKeys.has(k));
  const missingZh = [...enKeys].filter((k) => !zhKeys.has(k));
  if (missingEn.length) console.warn('[i18n] EN 缺 key:', missingEn.join(', '));
  if (missingZh.length) console.warn('[i18n] ZH 缺 key:', missingZh.join(', '));
}
