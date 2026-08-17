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
  'lang.label': '語言',
  'lang.switch_a11y': '切換介面語言',

  // ── 首頁：正在播放 ──────────────────────────────────────
  'home.a11y_open_player': '{title}，打開播放器',
  'home.a11y_play_episode': '播放 {title}',
  'home.a11y_back15': '重聽 15 秒',
  'home.a11y_forward30': '快轉 30 秒',
  'home.a11y_pause': '暫停',
  'home.a11y_play': '播放',
  'home.a11y_open_transcript': '打開逐字稿',
  'home.a11y_rate': '播放速度 {rate} 倍，點擊切換',
  'home.transcript': '逐字稿',

  // ── 首頁：今日練習 / 連續 ───────────────────────────────
  'home.a11y_practice_empty': '今天沒有待練的，去聽一集',
  'home.a11y_practice_n': '今日練習，{n} 張待練',
  'home.practice_empty_title': '今天沒有待練的',
  'home.practice_empty_cta': '去聽一集',
  'home.pending': '待練',
  'home.streak_days': '連續天數',

  // ── 首頁：訊號環 / 難點詞庫 / 探索 ──────────────────────
  'home.legend_rewinds': '重聽',
  'home.legend_confirmed': '確認',
  'home.legend_mastered': '掌握',
  'home.vocab_heading': '難點詞庫',
  'home.vocab_empty': '圈出聽不懂的字、或把標注的詞加入練習，會出現在這裡',
  'home.a11y_practice_term': '練習 {text}',
  'home.browse_title': '探索',
  'home.end_text': '訂閱更多節目，這裡就會一直長下去',
  'home.end_cta': '去探索',

  // ── 迷你播放器 ──────────────────────────────────────────
  'mini.a11y_open': '開啟播放器：{title}',

  // ── 全螢幕播放器 ────────────────────────────────────────
  'player.a11y_collapse': '收起播放器',

  // ── 難度帶 ──────────────────────────────────────────────
  'level.unrated': '未評估',

  // ── 難點詞卡 ────────────────────────────────────────────
  'term.a11y_close': '關閉解釋，回到播放',
  'term.a11y_dismiss': '知道了，關閉解釋',
  'term.added': '已加入練習',
  'term.a11y_add': '把這個詞加入練習',
  'term.added_check': '✓ 已加入練習',
  'term.add': '＋ 加入練習',
  'term.ok': '知道了',

  // ── 框選確認 ────────────────────────────────────────────
  'select.a11y_cancel': '取消，回到逐字稿',
  'select.a11y_word': '這是單字或片語',
  'select.a11y_pattern': '這是句型或文法',
  'select.word': '單字／片語',
  'select.pattern': '句型／文法',
  'select.cancel': '取消',

  // ── 版本 / 更新 ─────────────────────────────────────────
  'update.rolled_back': '已回滾到內建版',
  'update.builtin': '內建版本',
  'update.disabled': '這顆 build 沒有啟用更新（開發模式下 OTA 是關的）',
  'update.applying': '套用中…',
  'update.checking': '檢查中…',
  'update.none': '伺服器上沒有更新的版本了',
  'update.downloading': '下載中…',
  'update.same': '下載到的是同一顆，沒有變更',
  'update.done_restarting': '下載完成，重新啟動…',
  'update.ready': '更新已就緒 · 點我套用',
  'update.running': '執行中',
  'update.published_at': '發佈時間',
  'update.unknown': '未提供',
  'update.restart_to_apply': '重新啟動以套用',
  'update.check': '檢查更新',
  'update.available': '伺服器上有新版本',
};

const EN: Record<string, string> = {
  'tab.home': 'Home',
  'tab.browse': 'Browse',
  'tab.practice': 'Practice',
  'lang.label': 'Language',
  'lang.switch_a11y': 'Switch interface language',

  'home.a11y_open_player': '{title}, open the player',
  'home.a11y_play_episode': 'Play {title}',
  'home.a11y_back15': 'Back 15 seconds',
  'home.a11y_forward30': 'Forward 30 seconds',
  'home.a11y_pause': 'Pause',
  'home.a11y_play': 'Play',
  'home.a11y_open_transcript': 'Open transcript',
  'home.a11y_rate': 'Playback speed {rate}×, tap to change',
  'home.transcript': 'Transcript',

  'home.a11y_practice_empty': 'Nothing to practise today — go listen to an episode',
  'home.a11y_practice_n': "Today's practice, {n} cards waiting",
  'home.practice_empty_title': 'Nothing to practise',
  'home.practice_empty_cta': 'Go listen',
  'home.pending': 'waiting',
  'home.streak_days': 'day streak',

  'home.legend_rewinds': 'Rewound',
  'home.legend_confirmed': 'Confirmed',
  'home.legend_mastered': 'Mastered',
  'home.vocab_heading': 'Your gaps',
  'home.vocab_empty': 'Select the words you missed, or add a flagged word to practice — they show up here',
  'home.a11y_practice_term': 'Practise {text}',
  'home.browse_title': 'Browse',
  'home.end_text': 'Subscribe to more shows and this keeps going',
  'home.end_cta': 'Browse shows',

  'mini.a11y_open': 'Open player: {title}',

  'player.a11y_collapse': 'Collapse the player',

  'level.unrated': 'Not rated',

  'term.a11y_close': 'Close and go back to playback',
  'term.a11y_dismiss': 'Got it, close',
  'term.added': 'Added to practice',
  'term.a11y_add': 'Add this word to practice',
  'term.added_check': '✓ Added to practice',
  'term.add': '+ Add to practice',
  'term.ok': 'Got it',

  'select.a11y_cancel': 'Cancel and go back to the transcript',
  'select.a11y_word': "It's a word or phrase",
  'select.a11y_pattern': "It's a pattern or grammar",
  'select.word': 'Word / phrase',
  'select.pattern': 'Pattern / grammar',
  'select.cancel': 'Cancel',

  'update.rolled_back': 'Rolled back to the built-in bundle',
  'update.builtin': 'Built-in build',
  'update.disabled': 'Updates are off in this build (OTA is disabled in dev)',
  'update.applying': 'Applying…',
  'update.checking': 'Checking…',
  'update.none': 'No newer build on the server',
  'update.downloading': 'Downloading…',
  'update.same': 'Same bundle came back — nothing changed',
  'update.done_restarting': 'Downloaded, restarting…',
  'update.ready': 'Update ready · tap to apply',
  'update.running': 'Running',
  'update.published_at': 'Published',
  'update.unknown': 'not provided',
  'update.restart_to_apply': 'Restart to apply',
  'update.check': 'Check for updates',
  'update.available': 'A newer build is on the server',
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
