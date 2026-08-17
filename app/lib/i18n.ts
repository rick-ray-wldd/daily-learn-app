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
  // 1–5 的標籤原本寫死在 lib/level.ts 的 LEVEL_LABEL_ZH。移到這裡是因為
  // 它會直接印在探索頁的徽章上——那是介面文字，不是模型生成的內容。
  'level.unrated': '未評估',
  'level.1': '入門',
  'level.2': '初階',
  'level.3': '中階',
  'level.4': '中高階',
  'level.5': '進階',

  // ── 訊號環 ──────────────────────────────────────────────
  'signal.center': '重聽',

  // ── 外殼狀態 ────────────────────────────────────────────
  'shell.connected': '已連線',
  'shell.local_mode': '本地模式',
  'player.buffering': '緩衝中…',
  'player.loading': '載入音檔中…',

  // ── 通知答題的回饋（首頁頂端那一行綠字／琥珀字）──────────
  'quiz.correct': '答對了',
  'quiz.correct_with': '答對了 · {label}',
  'quiz.will_repeat': '今天會再出現一次',
  'quiz.noted': '記下來了 · {tail}',
  'quiz.cant_recall': '想不起來 · {tail}',
  'quiz.answer_was': '正解是 {label} · {tail}',
  'quiz.skip_stale': '這是昨天的題目，沒有動今天的排程',
  'quiz.skip_missing': '這張卡不在這台裝置上',
  'quiz.skip_unconfirmed': '這張卡還沒確認，練習頁裡有它',
  'quiz.skip_dismissed': '你已經把這張卡標成分心，不再排它',
  'quiz.skip_failed': '這次沒記錄成功',
  'quiz.skip_none': '沒有記錄這一筆',

  // ── 鎖屏卡（示範按鈕的回報）─────────────────────────────
  'la.not_ios': '只有 iOS 有 Live Activity。',
  'la.ios_too_old': 'Live Activity 需要 iOS 17 以上。',
  'la.module_missing': '這顆 binary 沒有鎖屏卡模組——要重新 build 並安裝。',
  'la.disabled': '系統設定裡的「即時動態」是關的：設定 → Echo → 打開。',
  'la.empty_deck': '今天沒有題目。',
  'la.deck_fail': '示範牌組建不起來（跳過 {n} 張）。',
  'la.started': '鎖屏卡已啟動（{n} 題）。鎖上螢幕看看。',
  'la.start_failed': '起卡失敗。',

  // ── 診斷面板（DevProbes）────────────────────────────────
  'probe.unmeasured': '未量測',
  'probe.toggle': '倒帶 {n} 筆 · 題目 {q}',
  'probe.not_checked': '尚未檢查',
  'probe.no_rewind': '還沒偵測到任何位置回跳（連 0.1 秒的抖動都會記）',
  'probe.logged': '已記錄',
  'probe.gate2': '閘②時間窗 {ms}ms',
  'probe.gate1': '閘①<{s}s',
  'probe.gate3': '閘③ |Δ|={d}',
  'probe.paused': ' 暫停',
  'probe.demo_quiz': '示範題 · {n} 秒後響（按完請鎖螢幕）',
  'probe.demo_la': '示範鎖屏卡（需要新 build）',
  'probe.demo_note': '示範題用預設單字，不寫進任何統計，答完也不會推進 SRS。',

  // ── 播放器 ──────────────────────────────────────────────
  'player.peek_placeholder': '逐字稿',
  'player.today_rewinds': '今天 {n} 次重聽',

  // ── 更新 ────────────────────────────────────────────────
  'update.failed': '失敗：{msg}',
  'update.rollback_note': '新版本啟動時失敗，已自動退回內建版。原因：',
  'update.error': '錯誤：{msg}',

  // ── 探索 ────────────────────────────────────────────────
  'browse.search_failed': '搜尋失敗，請檢查網路',
  'browse.subscribe_failed': '訂閱失敗：{msg}',
  'browse.refresh_failed': '更新失敗，顯示快取內容',
  'browse.placeholder': '搜尋 podcast 節目…',
  'browse.searching': ' 搜尋中…',
  'browse.no_results': '找不到節目，換個關鍵字試試',
  'browse.n_episodes': ' · {n} 集',
  'browse.subscribed': '已訂閱',
  'browse.subscribe': '訂閱',
  'browse.builtin_demo': '內建示範',
  'browse.default': '預設',
  'browse.no_playable': '（沒有可播放的單集）',
  'browse.transcript_chip': '逐字稿',
  'browse.too_long': '此集太長暫不支援轉錄',

  // ── 開機探針 ────────────────────────────────────────────
  'probe.boot': '鎖屏 API {fn} · audioMode {a} · setActive {s}',

  // ── 六類難點（診斷分類，會直接印在練習卡與詞卡上）────────
  'diag.vocab': '生詞片語',
  'diag.linking': '連音弱讀',
  'diag.speed': '語速',
  'diag.grammar': '文法結構',
  'diag.accent': '口音',
  'diag.culture': '文化背景',

  // ── 難度帶的理由 ────────────────────────────────────────
  'level.reason_transcript': '語速 {wpm} wpm・詞彙多樣性 {ttr}',
  'level.reason_listened': '你每 10 分鐘倒帶 {n} 次',
  'level.genre_kids': '兒童節目語速慢、用詞淺',
  'level.genre_learning': '教學類通常放慢並重述',
  'level.genre_fiction': '敘事類語速中等但用詞多樣',
  'level.genre_talk': '談話與喜劇語速快、慣用語多',
  'level.genre_news': '新聞與專業題材術語密度高',

  // ── 轉錄失敗 ────────────────────────────────────────────
  'tx.no_supabase': '未設定 Supabase，無法轉錄',
  'tx.out_of_range': '窗口超出單集長度',
  'tx.no_session': '尚未建立 session，無法轉錄',
  'tx.service_failed': '轉錄服務失敗：{msg}',
  'tx.unexpected': '轉錄服務回傳非預期結果',
  'tx.failed': '轉錄失敗：{msg}',

  // ── 逐字稿畫面 ──────────────────────────────────────────
  'ts.added_to_practice': '已加入今天的練習',
  'ts.noted_segmentation': '已記下：這一句我切不出詞',
  'ts.local_mode': '本地模式，逐字稿需要連線',
  'ts.transcribing': '轉錄中…',
  'ts.a11y_close': '關閉逐字稿',
  'ts.title': '逐字稿',
  'ts.a11y_select_on': '結束框選',
  'ts.a11y_select_off': '開始框選',
  'ts.select': '框選',
  'ts.annotate_offline': '難點標註需要連線',
  'ts.empty': '這一段還沒有逐字稿',
  'ts.hint_pick_line': '點一句話，再圈出聽不懂的字',
  'ts.hint_pick_words': '點第一個字，再點最後一個字',
  'ts.a11y_cancel_select': '取消框選',
  'ts.cancel': '取消',
  // ── 逐字稿：框選動作列 ──────────────────────────────────
  'ts.a11y_cant_split': '我聽不出這裡有幾個字，把整句加入練習',
  'ts.cant_split_btn': '我聽不出這裡有幾個字',
  'ts.a11y_add': '把圈起來的字加入難點',
  'ts.add_btn': '加入難點',
  'ts.back_to_position': '回到目前位置',

  // ── 通知：排程失敗與題目本文 ────────────────────────────
  'noti.sched_fail_at': '排到第 {n} 題時失敗：{msg}',
  'noti.sched_fail': '排題目通知時失敗：{msg}。今天沒有題目通知。',
  'noti.quiz_body': '這句話裡它是什麼意思？下拉選一個',
  'noti.quiz_unknown': '想不起來',

  // ── 練習：訊號強度徽章 ──────────────────────────────────
  'pr.badge_selected': '✍ 親手圈出',
  'pr.badge_strong': '★★★ 強訊號',
  'pr.badge_weak': '★ 弱訊號',
  'pr.badge_saved': '＋ 你標記想學',
  'pr.badge_segmentation': '✍ 你指了這一句',
  'pr.why_segmentation': '你在這裡重聽之後，指著這一句說「我聽不出這裡有幾個字」',
  'pr.why_selected': '你在這裡重聽之後，親手圈出了聽不懂的字',
  'pr.why_strong': '你在這裡重聽了 2 次以上，或重聽後放慢／打開了逐字稿',
  'pr.why_weak': '你在這裡重聽了 1 次',
  'pr.why_saved': '你在逐字稿裡點了這個詞，說想學它——這裡沒有重聽紀錄',

  // ── 練習：搶先練 ────────────────────────────────────────
  'pr.fresh_title': '⚡ 搶先練（{n}）',
  'pr.fresh_note': '這些是今天剛抓到的難點。正式節奏是明天早上練（隔夜複習效果更好）；等不及也可以現在清。',
  'pr.fresh_start': '開始搶先練 {n} 張',

  // ── 練習：統計 ──────────────────────────────────────────
  'pr.top_type': '你的難點 {pct}% 是',
  'pr.no_stats': '累積更多診斷後，這裡會顯示你的難點分佈',
  'pr.total_captures': '累計捕捉 {n} 個難點',
  'pr.confirm_rate': '倒帶確認率',
  'pr.confirm_rate_full': '倒帶確認率 {pct}',
  'pr.confirm_note': '（滑掉的是誤報；框選與標記想學不計入）',

  // ── 練習：空狀態 ────────────────────────────────────────
  'pr.loading_queue': '載入練習佇列…',
  'pr.empty_cleared': '今天的正式練習已清空',
  'pr.empty': '目前沒有待練項目',
  'pr.streak': '🔥 連續練習 {n} 天',
  'pr.empty_hint': '去「播放器」聽 podcast，按 ↺15 —— 每一次重聽都會被接住，',
  'pr.empty_hint2': '明天早上回來清掉它們。',

  // ── 練習：完成畫面 ──────────────────────────────────────
  'pr.done_title': '今日練習完成',
  'pr.done_practiced': '練了 {n} 句（強訊號 {strong}・弱訊號 {weak}{saved}）',
  'pr.done_saved_part': '・標記想學 {n}',
  'pr.done_dismissed': '滑掉分心誤報 {n} 個',
  'pr.done_due_tomorrow': '明日到期複習 {n} 張',
  'pr.done_minutes': '本次耗時約 {n} 分鐘',
  'pr.done_streak': '連續練習 {n} 天',
  'pr.done_bye': '繼續聽，明天見。',

  // ── 練習：卡片 ──────────────────────────────────────────
  'pr.card_of': '第 {i} / {total} 張',
  'pr.chip_streak': '🔥 {n} 天',
  'pr.chip_review': '複習',
  'pr.unknown_episode': '（未知單集）',
  'pr.this_sentence': '這一句',
  'pr.transcribing': '轉錄中…（每集只轉一次，第一次要下載音檔）',
  'pr.tx_failed': '轉錄失敗：{reason}',
  'pr.no_transcript': '此集還沒有逐字稿（設定 OpenAI key 後自動補）——先用耳朵練，下面的重聽鍵一樣可以按。',
  'pr.no_match': '（此窗口沒有對到句子）',

  // ── 練習：重聽階梯 ──────────────────────────────────────
  'pr.you_said_seg': '你說這裡切不出有幾個字',
  'pr.you_saved': '你標記想學',
  'pr.you_selected': '你圈的字',
  'pr.stop_replay': '停止重聽',
  'pr.replay_check': '原音重聽這一句 — 這次聽得出來嗎',
  'pr.replay_normal': '原速重聽這一句',
  'pr.a11y_chunked': '分塊重聽：塊內原速、邊界停頓',
  'pr.chunked': '① 分塊',
  'pr.a11y_slow_native': '原生慢速重聽',
  'pr.slow_native': '② 慢速',
  'pr.a11y_slow': '慢速重聽這一句',
  'pr.slow': '0.7× 慢速',
  'pr.ladder_note': '① 分塊 → ② 慢速 → ③ 原音（驗收）',

  // ── 練習：揭露與確認 ────────────────────────────────────
  'pr.more_hint': '再給一點提示',
  'pr.see_transcript': '看逐字稿',
  'pr.mask_note': '逐字稿在你回答下面那題之後才會開。',
  'pr.decide': '聽完再決定。',
  'pr.decide2': '是真的沒聽懂，還是只是分心？',
  'pr.confirm_yes': '這段是真的沒聽懂',
  'pr.confirm_no': '只是分心，滑掉',

  // ── 練習：指出難點 ──────────────────────────────────────
  'pr.where_stuck': '你覺得卡在哪？',
  'pr.these_words': '就是這幾個字',
  'pr.cant_split': '我切不出這裡有幾個字',
  'pr.skip': '跳過',
  'pr.you_circled': '你圈的：{text}',
  'pr.we_think': '我們判斷：{phrase}',
  'pr.same_spot': '同一處',
  'pr.diff_spot': '不同處——先信你圈的',
  'pr.you_said_cant_split': '你說：這裡切不出有幾個字',
  'pr.diagnosing': 'Claude 診斷中…',
  'pr.no_anthropic': '（未設定 Anthropic key，略過難點診斷）',

  // ── 練習：跟讀與評分 ────────────────────────────────────
  'pr.shadow': '跟讀',
  'pr.stop_rec': '⏹ 停止（{s}s）',
  'pr.rerecord': '🎙 重錄',
  'pr.start_rec': '🎙 開始跟讀',
  'pr.my_recording': '▶ 我的錄音',
  'pr.compare_original': '▶ 原音對照',
  'pr.mastery': '這句的掌握度',
  'pr.grade_again': '再來一次',
  'pr.grade_good': '記住了',
  'pr.grade_easy': '太簡單',
  'pr.mic_denied': '需要麥克風權限才能跟讀，請到系統設定開啟。',
  'pr.rec_failed': '錄音啟動失敗，再試一次。',
  // ── 通知 ────────────────────────────────────────────────
  // ⚠️ 通知是**排程當下**就把文字寫死進系統的。切換語言之後，已經排出去的那幾則
  //    仍然是舊語言，要等下一次 sync（app 回前景時）才會重排。這不是 bug，
  //    是本地通知的運作方式——不要為了「立刻同步」去清掉使用者已排的提醒。
  'noti.channel_daily': '每日練習提醒',
  'noti.daily_title': 'Echo 每日練習',
  'noti.daily_body_n': '你昨天存了 {n} 個難點，花 8 分鐘清掉',
  'noti.daily_body_0': '今天聽 podcast 了嗎？每次重聽都是進步的訊號',
  'noti.channel_quiz': '每日題目',
  'noti.web_skip': 'web 沒有本地通知，略過題目通知。',
  'noti.web_none': 'web 沒有本地通知。',
  'noti.no_perm_demo': '沒有通知權限，示範題排不出去。',
  'noti.no_perm': '沒有通知權限，略過題目通知。',
  'noti.demo_fail': '示範題出不來：{reason}',
  'noti.demo_ok': '示範題已排：{s} 秒後鎖上螢幕就會跳出「{prompt}」。',
  'noti.demo_error': '示範題排程失敗：{msg}',

  // ── 出題器的自我報告（顯示在診斷面板）───────────────────
  'quiz.skip_segmentation': '整句切分題，斷點不在詞義上',
  'quiz.skip_no_prompt': '還沒診斷過，沒有題面',
  'quiz.skip_prompt_long': '題面過長',
  'quiz.skip_no_gloss': '沒有中文簡義（gloss_zh）',
  'quiz.skip_few_distractors': '干擾項不足 2 個',
  'quiz.skip_label_long': '選項中文過長',
  'quiz.sum_scheduled': '已排 {n} 題：{slots}',
  'quiz.sum_no_due': '今天沒有到期的卡，所以沒有排題目通知。',
  'quiz.sum_no_gloss': '佇列有 {n} 張卡有題面，但沒有一張帶中文簡義（gloss_zh）：不是舊格式的診斷，就是那次診斷不是生詞類。要補上的話得在練習頁重新診斷。',
  'quiz.sum_few_distractors': '有 {n} 張卡有正解但干擾項不足 2 個，湊不出三選一。不排通知。',
  'quiz.sum_no_prompt': '有 {n} 張卡還沒被診斷過（沒有 focus_phrase 可以當題面）。診斷發生在練習頁按「看全文」的時候，練過就會有。今天不排題目通知。',
  'quiz.sum_other': '{n} 張卡被排除（{reason}），今天沒有可出的題目。',
  'quiz.reason_unknown': '原因不明',



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
  'level.1': 'Starter',
  'level.2': 'Easy',
  'level.3': 'Medium',
  'level.4': 'Hard',
  'level.5': 'Advanced',

  'signal.center': 'Rewound',

  'shell.connected': 'Online',
  'shell.local_mode': 'Local only',
  'player.buffering': 'Buffering…',
  'player.loading': 'Loading audio…',

  'quiz.correct': 'Correct',
  'quiz.correct_with': 'Correct · {label}',
  'quiz.will_repeat': "it'll come round again today",
  'quiz.noted': 'Noted · {tail}',
  'quiz.cant_recall': "Couldn't recall · {tail}",
  'quiz.answer_was': 'It was {label} · {tail}',
  'quiz.skip_stale': "yesterday's card — today's schedule untouched",
  'quiz.skip_missing': 'that card is not on this device',
  'quiz.skip_unconfirmed': "not confirmed yet — it's in Practice",
  'quiz.skip_dismissed': 'you marked this one as a distraction',
  'quiz.skip_failed': "couldn't record it this time",
  'quiz.skip_none': 'nothing recorded',

  'la.not_ios': 'Live Activities are iOS-only.',
  'la.ios_too_old': 'Live Activities need iOS 17 or later.',
  'la.module_missing': 'This build has no lock-screen module — it needs a rebuild and reinstall.',
  'la.disabled': 'Live Activities are off: Settings → Echo → turn them on.',
  'la.empty_deck': 'Nothing to ask today.',
  'la.deck_fail': "Couldn't build the demo deck ({n} skipped).",
  'la.started': 'Lock-screen card is up ({n} questions). Lock your screen and look.',
  'la.start_failed': "Couldn't start the card.",

  'probe.unmeasured': 'not measured',
  'probe.toggle': '{n} rewinds · {q} questions',
  'probe.not_checked': 'not checked yet',
  'probe.no_rewind': 'No backward jumps detected yet (even a 0.1 s wobble would log)',
  'probe.logged': 'logged',
  'probe.gate2': 'gate② window {ms}ms',
  'probe.gate1': 'gate①<{s}s',
  'probe.gate3': 'gate③ |Δ|={d}',
  'probe.paused': ' paused',
  'probe.demo_quiz': 'Demo question · fires in {n}s (lock the screen after tapping)',
  'probe.demo_la': 'Demo lock-screen card (needs a new build)',
  'probe.demo_note': 'The demo uses preset words. It writes to no metric and does not advance SRS.',

  'player.peek_placeholder': 'Transcript',
  'player.today_rewinds': '{n} rewinds today',

  'update.failed': 'Failed: {msg}',
  'update.rollback_note': 'The new build failed to launch and was rolled back. Reason:',
  'update.error': 'Error: {msg}',

  'browse.search_failed': 'Search failed — check your connection',
  'browse.subscribe_failed': "Couldn't subscribe: {msg}",
  'browse.refresh_failed': 'Refresh failed — showing cached content',
  'browse.placeholder': 'Search podcasts…',
  'browse.searching': ' Searching…',
  'browse.no_results': 'No shows found — try another keyword',
  'browse.n_episodes': ' · {n} episodes',
  'browse.subscribed': 'Subscribed',
  'browse.subscribe': 'Subscribe',
  'browse.builtin_demo': 'Built-in demo',
  'browse.default': 'Default',
  'browse.no_playable': '(no playable episodes)',
  'browse.transcript_chip': 'Transcript',
  'browse.too_long': 'This episode is too long to transcribe for now',

  'probe.boot': 'Lock-screen API {fn} · audioMode {a} · setActive {s}',

  'diag.vocab': 'Vocabulary',
  'diag.linking': 'Connected speech',
  'diag.speed': 'Speed',
  'diag.grammar': 'Grammar',
  'diag.accent': 'Accent',
  'diag.culture': 'Cultural reference',

  'level.reason_transcript': '{wpm} wpm · lexical variety {ttr}',
  'level.reason_listened': 'You rewind {n}× per 10 minutes',
  'level.genre_kids': "Children's shows speak slowly with simple words",
  'level.genre_learning': 'Teaching shows slow down and repeat',
  'level.genre_fiction': 'Narrative: medium pace, varied vocabulary',
  'level.genre_talk': 'Talk and comedy: fast, idiom-heavy',
  'level.genre_news': 'News and specialist topics are term-dense',

  'tx.no_supabase': 'Supabase not configured — cannot transcribe',
  'tx.out_of_range': 'Window is past the end of the episode',
  'tx.no_session': 'No session yet — cannot transcribe',
  'tx.service_failed': 'Transcription service failed: {msg}',
  'tx.unexpected': 'Transcription service returned something unexpected',
  'tx.failed': 'Transcription failed: {msg}',

  'ts.added_to_practice': "Added to today's practice",
  'ts.noted_segmentation': "Noted: I can't split this one into words",
  'ts.local_mode': 'Local mode — transcripts need a connection',
  'ts.transcribing': 'Transcribing…',
  'ts.a11y_close': 'Close the transcript',
  'ts.title': 'Transcript',
  'ts.a11y_select_on': 'Stop selecting',
  'ts.a11y_select_off': 'Start selecting',
  'ts.select': 'Select',
  'ts.annotate_offline': 'Word flagging needs a connection',
  'ts.empty': 'No transcript for this stretch yet',
  'ts.hint_pick_line': 'Tap a sentence, then select the words you missed',
  'ts.hint_pick_words': 'Tap the first word, then the last',
  'ts.a11y_cancel_select': 'Cancel selection',
  'ts.cancel': 'Cancel',
  'ts.a11y_cant_split': "I can't tell how many words that was — add the whole line",
  'ts.cant_split_btn': "I can't tell how many words that was",
  'ts.a11y_add': 'Add the selected words as a gap',
  'ts.add_btn': 'Add as a gap',
  'ts.back_to_position': 'Back to where you are',

  'noti.sched_fail_at': 'Failed while scheduling question {n}: {msg}',
  'noti.sched_fail': 'Failed to schedule questions: {msg}. None today.',
  'noti.quiz_body': 'What does it mean here? Pull down to choose',
  'noti.quiz_unknown': "Can't recall",

  'pr.badge_selected': '✍ You pointed at it',
  'pr.badge_strong': '★★★ Strong signal',
  'pr.badge_weak': '★ Weak signal',
  'pr.badge_saved': '+ You flagged it',
  'pr.badge_segmentation': '✍ You pointed at this line',
  'pr.why_segmentation': "You rewound here, then pointed at this line and said you couldn't tell where the words split",
  'pr.why_selected': 'You rewound here, then picked out the words you missed',
  'pr.why_strong': 'You rewound here twice or more — or rewound, then slowed down or opened the transcript',
  'pr.why_weak': 'You rewound here once',
  'pr.why_saved': 'You tapped this word in the transcript to learn it — no rewind here',

  'pr.fresh_title': '⚡ Practise early ({n})',
  'pr.fresh_note': "These were caught today. The real rhythm is tomorrow morning — sleep improves recall — but you can clear them now if you can't wait.",
  'pr.fresh_start': 'Start {n} early',

  'pr.top_type': '{pct}% of your gaps are',
  'pr.no_stats': 'Your breakdown shows up here once there are more diagnoses',
  'pr.total_captures': '{n} gaps caught so far',
  'pr.confirm_rate': 'Rewind confirm rate',
  'pr.confirm_rate_full': 'Rewind confirm rate {pct}',
  'pr.confirm_note': '(dismissed ones were false alarms; selections and flags are excluded)',

  'pr.loading_queue': 'Loading your queue…',
  'pr.empty_cleared': "Today's real queue is clear",
  'pr.empty': 'Nothing to practise right now',
  'pr.streak': '🔥 {n}-day streak',
  'pr.empty_hint': 'Go to the player, listen to a podcast, hit ↺15 — every rewind gets caught,',
  'pr.empty_hint2': 'and you clear them tomorrow morning.',

  'pr.done_title': "Today's practice is done",
  'pr.done_practiced': 'Practised {n} (strong {strong} · weak {weak}{saved})',
  'pr.done_saved_part': ' · flagged {n}',
  'pr.done_dismissed': 'Dismissed {n} false alarms',
  'pr.done_due_tomorrow': '{n} due for review tomorrow',
  'pr.done_minutes': 'About {n} minutes this session',
  'pr.done_streak': '{n}-day streak',
  'pr.done_bye': 'Keep listening. See you tomorrow.',

  'pr.card_of': 'Card {i} of {total}',
  'pr.chip_streak': '🔥 {n}d',
  'pr.chip_review': 'Review',
  'pr.unknown_episode': '(unknown episode)',
  'pr.this_sentence': 'This line',
  'pr.transcribing': 'Transcribing… (once per episode; the first run downloads the audio)',
  'pr.tx_failed': 'Transcription failed: {reason}',
  'pr.no_transcript': 'No transcript for this episode yet (it fills in once an OpenAI key is set) — practise by ear; the replay button below still works.',
  'pr.no_match': '(no sentence matched this window)',

  'pr.you_said_seg': "you couldn't tell where the words split",
  'pr.you_saved': 'you flagged it',
  'pr.you_selected': 'the words you picked',
  'pr.stop_replay': 'Stop',
  'pr.replay_check': 'Play the real audio — can you hear it now?',
  'pr.replay_normal': 'Replay at full speed',
  'pr.a11y_chunked': 'Chunked replay: full speed inside chunks, pauses at boundaries',
  'pr.chunked': '① Chunked',
  'pr.a11y_slow_native': 'Natively slow replay',
  'pr.slow_native': '② Slow',
  'pr.a11y_slow': 'Replay this line slowly',
  'pr.slow': '0.7× slow',
  'pr.ladder_note': '① chunked → ② slow → ③ real audio (the check)',

  'pr.more_hint': 'Give me another hint',
  'pr.see_transcript': 'Show the text',
  'pr.mask_note': 'The text opens after you answer the question below.',
  'pr.decide': 'Listen first.',
  'pr.decide2': 'Did you really miss it, or were you just distracted?',
  'pr.confirm_yes': "I really didn't catch it",
  'pr.confirm_no': 'Just distracted — skip',

  'pr.where_stuck': 'Where did it break?',
  'pr.these_words': 'These words',
  'pr.cant_split': "I can't tell where the words split",
  'pr.skip': 'Skip',
  'pr.you_circled': 'You picked: {text}',
  'pr.we_think': 'We think: {phrase}',
  'pr.same_spot': 'same spot',
  'pr.diff_spot': "different — we'll trust yours",
  'pr.you_said_cant_split': "You said: I can't tell where the words split",
  'pr.diagnosing': 'Claude is diagnosing…',
  'pr.no_anthropic': '(no Anthropic key set — diagnosis skipped)',

  'pr.shadow': 'Shadow it',
  'pr.stop_rec': '⏹ Stop ({s}s)',
  'pr.rerecord': '🎙 Re-record',
  'pr.start_rec': '🎙 Start shadowing',
  'pr.my_recording': '▶ My take',
  'pr.compare_original': '▶ The original',
  'pr.mastery': 'How well do you have it?',
  'pr.grade_again': 'Again',
  'pr.grade_good': 'Got it',
  'pr.grade_easy': 'Too easy',
  'pr.mic_denied': 'Shadowing needs microphone access — turn it on in Settings.',
  'pr.rec_failed': "Couldn't start recording. Try again.",
  'noti.channel_daily': 'Daily practice reminder',
  'noti.daily_title': 'Echo · daily practice',
  'noti.daily_body_n': 'You saved {n} gaps yesterday. Eight minutes clears them.',
  'noti.daily_body_0': 'Listened to a podcast today? Every rewind is progress.',
  'noti.channel_quiz': 'Daily questions',
  'noti.web_skip': 'No local notifications on web — skipping the question.',
  'noti.web_none': 'No local notifications on web.',
  'noti.no_perm_demo': "No notification permission — can't schedule the demo question.",
  'noti.no_perm': 'No notification permission — skipping questions.',
  'noti.demo_fail': "Demo question couldn't be built: {reason}",
  'noti.demo_ok': 'Demo scheduled: lock your screen and "{prompt}" appears in {s}s.',
  'noti.demo_error': 'Demo scheduling failed: {msg}',

  'quiz.skip_segmentation': 'a whole-line segmentation card — the break is not on a meaning',
  'quiz.skip_no_prompt': 'not diagnosed yet, so there is no prompt',
  'quiz.skip_prompt_long': 'the prompt is too long',
  'quiz.skip_no_gloss': 'no short gloss (gloss_zh)',
  'quiz.skip_few_distractors': 'fewer than 2 distractors',
  'quiz.skip_label_long': 'an option label is too long',
  'quiz.sum_scheduled': '{n} scheduled: {slots}',
  'quiz.sum_no_due': 'Nothing due today, so no question notifications.',
  'quiz.sum_no_gloss': '{n} cards have a prompt but none has a short gloss: either an older diagnosis format, or the diagnosis was not a vocabulary one. Re-diagnose from Practice to fill it in.',
  'quiz.sum_few_distractors': '{n} cards have an answer but fewer than 2 distractors — no three-way choice. Not scheduling.',
  'quiz.sum_no_prompt': '{n} cards have never been diagnosed (no focus_phrase to use as a prompt). Diagnosis happens when you tap "show the text" in Practice. No questions today.',
  'quiz.sum_other': '{n} cards excluded ({reason}) — nothing to ask today.',
  'quiz.reason_unknown': 'reason unknown',



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
