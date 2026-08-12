/**
 * 使用者親手指出來的難點 → capture。兩個入口，強度天差地遠：
 *
 * - `commitSelection`：框選 → `strength: 'selected'`。**不是新的輸入來源**，是既有
 *   訊號的最強一級（saved → weak → strong → selected，migration 006）：學習者不只
 *   倒帶、不只跑去看字，還親手指出是哪幾個字。所以 ADR-0003 的單一 replay-event
 *   管線不變，只是多一種 `trigger_source: 'select'`。它也承接 `'segmentation'`
 *   （「我聽不出這裡有幾個字」）——那仍然是倒帶＋開稿＋親手指出，只是指的是整句。
 * - `commitSavedTerm`：點了 app 標的詞 → `strength: 'saved'`，最弱的一級。它背後
 *   **沒有任何倒帶**，所以是唯一一條不建 replay event 的路徑（見該函式的禁令 4）。
 *
 * 這支檔案刻意分成「兩個純函式 + 有副作用的入口」：`tokenize` / `sliceSelection`
 * 在每一次觸控都會被呼叫，它們必須能在沒有 store、沒有網路、沒有 React 的情況下
 * 單獨驗證；只有 `commitSelection` / `commitSavedTerm` 會寫東西。
 */
import { uuidv4 } from './captureEngine';
import { makeReplayEvent, syncReplayEvent } from './replay';
import { getCaptures, upsertCapture } from './store';
import { supabase } from './supabase';
import { Capture, SelectionKind, TranscriptSegment } from './types';

/**
 * 練習頁回放的前後留白，必須與 `captureEngine.CONTEXT_PAD_SECONDS` 同值。
 *
 * 那個常數沒有 export（而 captureEngine 這一輪唯讀），所以只能在這裡複製。
 * 兩者不一致的後果不是崩潰而是更陰險的東西：框選來的卡片與倒帶來的卡片在同一
 * 個 session 裡回放長度不同，學習者會以為 app 隨機吃掉了句子的開頭。
 */
const CONTEXT_PAD_SECONDS = 6;

/** 與 captureEngine 同樣的 0.1 秒精度：兩邊產生的 capture 會排在同一個清單裡。 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface Token {
  /** 在 segment.text 裡的起始字元 offset（含）。 */
  start: number;
  /** 結束 offset（不含）。 */
  end: number;
  /** 原文切片，**含尾隨空白**（見 tokenize 註解）。 */
  text: string;
  /** 去掉尾隨空白後的可見文字。渲染量測用 text，比對用 word。 */
  word: string;
}

/**
 * 把一句話切成可點的 token。
 *
 * 規則是「一個詞 + 它後面的空白算同一個 token」（全域比對 `\S+\s*`）。空白歸前面那個詞
 * 是為了讓連續選取的綠底**不會在字與字之間斷開**——空白若自成 token 而沒被選進
 * 範圍，一段五個字的選取看起來會像五塊獨立的標籤。
 *
 * ⚠️ 不准改用 `text.split(/\s+/)`：它丟掉 offset，而 offset 是選取範圍唯一該用的
 * 座標；而且 Whisper 經 Edge Function 回來的 text 常帶前導空白，split 會生出一個
 * 空字串開頭。字串開頭的空白直接被跳過（不屬於任何 token），這在視覺上沒有差別，
 * 因為那段空白本來就不可見。
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  if (!text) return tokens;
  // 每次呼叫都新建 RegExp：帶 /g 的正規式有可變的 lastIndex，共用一個實例會讓
  // 第二次呼叫從上一次結束的地方接著切。
  const re = /\S+\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    tokens.push({
      start: m.index,
      end: m.index + raw.length,
      text: raw,
      word: raw.replace(/\s+$/, ''),
    });
  }
  return tokens;
}

/**
 * 兩個 token index（含頭含尾，順序不拘）→ 使用者實際框到的字串（已 trim）。
 * 超出範圍或 tokens 為空時回空字串——呼叫端據此擋掉空選取。
 *
 * 順序不拘是因為 UI 允許「先點後面那個字」：兩次獨立的 tap 沒有天然的先後語意，
 * 逼使用者由左往右點只會讓他以為 app 沒反應。
 */
export function sliceSelection(tokens: Token[], a: number, b: number): string {
  if (tokens.length === 0) return '';
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo < 0 || hi >= tokens.length) return '';
  // token.text 已含尾隨空白，所以逐段串接等同於原文 [tokens[lo].start,
  // tokens[hi].end) 的切片——不需要把原字串也傳進來。
  let out = '';
  for (let i = lo; i <= hi; i += 1) out += tokens[i].text;
  return out.trim();
}

export interface SelectionInput {
  episodeId: string;
  /** 被框的那一句（框選一律鎖在單一句子內）。 */
  segment: TranscriptSegment;
  /** 框到的字，已 trim 且非空。 */
  text: string;
  kind: SelectionKind;
  /** 框選當下的播放位置，只用來填 replay event 的 from_pos。 */
  positionSec: number;
  /** 單集長度，用來夾住 context_end；未知傳 0。 */
  durationSec: number;
}

/**
 * 框選 → 一筆 strength 'selected' 的 capture ＋ 一筆 trigger_source 'select'
 * 的 replay event。同步回傳建好的 capture（本地已寫入，遠端 best-effort）。
 *
 * 三條禁令，違反等於毀掉這個產品唯一在乎的訊號：
 *
 * 1. **絕不呼叫 `ingestReplayEvent`。** 它會依 `[T-15, T]` 另建一筆 weak capture，
 *    並可能與這一筆合併／收窄窗口，把「精確的一句話」變回「模糊的十五秒」——
 *    而框選存在的理由就是那個精確度。
 * 2. **絕不動播放位置。** 不 seek、不 pause。因此也完全不會踩到 App.tsx 的外部
 *    倒帶推斷（ADR-0016）：那套機制看的是「位置忽然往回」，框選讓位置紋風不動。
 * 3. **絕不寫 AsyncStorage、不新增 store key。** 唯一的本地寫入路徑是
 *    `upsertCapture`，它自己會 persist。
 */
export function commitSelection(input: SelectionInput): Capture {
  const { episodeId, segment, text, kind, positionSec, durationSec } = input;

  const capture: Capture = {
    id: uuidv4(),
    episode_id: episodeId,
    // 框選鎖的是**這一句**，不是 [T-15, T] 窗口。這是它比倒帶精確的地方，
    // 也是整個功能存在的理由——不要「順手」改回窗口算法。
    window_start: round1(segment.start),
    window_end: round1(segment.end),
    context_start: round1(Math.max(0, segment.start - CONTEXT_PAD_SECONDS)),
    context_end: round1(
      durationSec > 0
        ? Math.min(segment.end + CONTEXT_PAD_SECONDS, durationSec)
        : segment.end + CONTEXT_PAD_SECONDS,
    ),
    strength: 'selected',
    // 練習頁的 confirm 步驟問的是「這段是真的沒聽懂嗎」，而框選就是學習者親手
    // 回答了那一題。再問一次既是侮辱，也會讓 confirm rate 這個指標失去意義。
    status: 'confirmed',
    // 整句留給診斷當上下文；框到的字另存 selection_text，兩者缺一不可。
    transcript_text: segment.text,
    selection_text: text,
    selection_kind: kind,
    // diagnosis 刻意留空：這裡不呼叫任何 LLM，交給練習頁的 diagnoseCapture。
    created_at: new Date().toISOString(),
  };

  upsertCapture(capture);
  void syncSelectionColumns(capture);

  // playback_rate 填 1：框選不經過播放器，拿不到當下速率，而這個欄位對 'select'
  // 來源本來就沒有意義（沒有人「以 0.85 倍速框了一個字」）。to_pos 填句子開頭，
  // 讓事件在後端仍讀得出「他指的是哪一段」。
  void syncReplayEvent(
    makeReplayEvent({
      episodeId,
      fromPos: positionSec,
      toPos: segment.start,
      playbackRate: 1,
      triggerSource: 'select',
    }),
  );

  return capture;
}

export interface SavedTermInput {
  episodeId: string;
  /** 那個詞所在的整句。呼叫端反查不到就不要呼叫，不要自己湊一個。 */
  segment: TranscriptSegment;
  /** app 標的那個詞本身（`Term.term`），已 trim 且非空。 */
  text: string;
  /** 單集長度，用來夾住 context_end；未知傳 0。 */
  durationSec: number;
}

/**
 * 同一集、同一句、同一個詞的 saved capture 是不是已經存在。
 *
 * 三個欄位一起比對而不是只比 `selection_text`：同一個詞在一集裡可能出現在好幾句，
 * 每一句都是不同的練習素材（上下文不同），只比詞會把第二句誤判成重複。
 */
function findSavedTerm(
  episodeId: string,
  segment: TranscriptSegment,
  text: string,
): Capture | undefined {
  const start = round1(segment.start);
  return getCaptures().find(
    (c) =>
      c.strength === 'saved' &&
      c.episode_id === episodeId &&
      c.window_start === start &&
      c.selection_text === text,
  );
}

/**
 * 這個詞已經加進練習了嗎（同一集、同一句、同一個詞）。
 *
 * 存在的理由是 `commitSelection` 這條管線**沒有任何冪等鍵**（每次都 uuidv4），
 * 而 TermSheet 的按鈕只要一次點擊——同一個詞點兩次就是兩筆一模一樣的 capture，
 * 隔天在練習佇列裡連續出現兩張同樣的卡。UI 用它把按鈕切成「已加入」。
 */
export function isTermSaved(
  episodeId: string,
  segment: TranscriptSegment,
  text: string,
): boolean {
  return findSavedTerm(episodeId, segment, text) !== undefined;
}

/**
 * 標註詞 →「我想學」的最弱訊號（strength 'saved'）。
 *
 * 與 `commitSelection` 的三條禁令之外，這裡多兩條，違反就是在資料庫裡捏造事實：
 *
 * 4. **絕不建 replay event。** 他沒有倒帶。`commitSelection` 無條件送出的那一筆
 *    trigger_source 'select' 在這條路徑上是一次從未發生的重聽——本地完全看不出來
 *    （UI 照跳、store 照寫），只有去撈 replay_events 才會發現。
 * 5. **絕不寫 selection_kind。** 「詞還是句型」是 evaluation，而 TermSheet 的
 *    設計底線是聽的當下不要求判斷（Involvement Load 的那一格留到隔天的練習卡）。
 *
 * status 沿用 'confirmed' 不是風格選擇：`captureEngine.ts:118` 的合併候選只挑
 * 'pending'，一旦用 pending 建立，之後一次重疊的倒帶就會把它併掉並硬寫成
 * 'strong'，同時把「那一個詞」的精確窗口 union 成模糊的十五秒。
 *
 * 冪等：同一集同一句同一個詞已經有一筆時，原樣回傳既有的那一筆、不寫第二次。
 */
export function commitSavedTerm(input: SavedTermInput): Capture {
  const { episodeId, segment, text, durationSec } = input;

  const existing = findSavedTerm(episodeId, segment, text);
  // 命中就整筆原樣回傳：連 upsertCapture 都不呼叫。重寫一次會把 created_at 以外
  // 的東西維持原狀卻多一次遠端 upsert，而那筆遠端寫入唯一可能造成的差異是把
  // 練習頁已經填好的 diagnosis 洗掉。
  if (existing) return existing;

  const capture: Capture = {
    id: uuidv4(),
    episode_id: episodeId,
    // 與框選同一套窗口：鎖的是**這一句**，不是 [T-15, T]。那個詞的練習素材就是
    // 它所在的句子，換成十五秒窗口等於把他點的那一個詞泡回一整段話裡。
    window_start: round1(segment.start),
    window_end: round1(segment.end),
    context_start: round1(Math.max(0, segment.start - CONTEXT_PAD_SECONDS)),
    context_end: round1(
      durationSec > 0
        ? Math.min(segment.end + CONTEXT_PAD_SECONDS, durationSec)
        : segment.end + CONTEXT_PAD_SECONDS,
    ),
    strength: 'saved',
    status: 'confirmed',
    transcript_text: segment.text,
    selection_text: text,
    // selection_kind 刻意不設，見上方禁令 5。
    // diagnosis 一樣留空：這裡不呼叫任何 LLM。
    created_at: new Date().toISOString(),
  };

  upsertCapture(capture);
  void syncSelectionColumns(capture);
  // 到此為止。沒有 makeReplayEvent、沒有 syncReplayEvent——他沒有倒帶。
  return capture;
}

/**
 * 第二次遠端 upsert，只為了補上 `selection_text` / `selection_kind`。
 *
 * 為什麼會有兩次遠端寫入：`upsertCapture` 內部的 `store.ts:syncCapture` 不認得
 * 這兩個新欄位，而 `store.ts` 這一輪不屬於任何人（平行作業會互相覆蓋）。兩次
 * upsert 各自只設自己知道的欄位，`on conflict (id) do update` 只會更新該次帶上
 * 的欄位，所以不論誰先到達都不會互相抹掉。
 *
 * ⚠️ **migration 006 沒套用到線上時，遠端不是「少兩個欄位」，是一筆都沒有。**
 * 這裡原本寫的是「缺欄位時只有這一次會失敗，capture 本體早已由 syncCapture 寫進去」
 * ——那個前提不成立。006 同時把 `strength` 的合法值從 ('weak','strong') 擴成四態
 * （`'saved'` / `'selected'` 都是這一版才進 CHECK 的），並把 `selection_kind` 放寬到
 * 含 `'segmentation'`，所以在 006 之前這三種新來源的遠端路徑**全部**被擋：
 *
 *   1. `store.ts:syncCapture` 撞 `captures_strength_check`（23514）→ 本體沒寫進去
 *   2. 這一支撞同一個 check、或撞 `captures_selection_kind_check`（segmentation），
 *      外加兩個欄位不存在（42703）
 *   3. `syncReplayEvent` 帶 `'select'` 撞 `replay_events_trigger_source_check`
 *      （只有框選有這一條；`commitSavedTerm` 不建事件，所以它只被 1、2 擋）
 *
 * 全部都只 `console.warn`，UI 照樣跳「已加入今天的練習」，本地 store 也照常運作，
 * 所以沒有人會發現伺服器端一筆都沒有。本地優先仍然成立（ADR-0004），但
 * **指標不能從線上撈**——這是 OTA 六天迭代的必然風險：JS bundle 一定比 SQL 早到。
 *
 * 這裡刻意**不做降級重寫**（偵測失敗後把 strength 改成 'strong'、trigger_source
 * 改成 'screen' 再送一次）：那等於在資料庫裡捏造一次從未發生的倒帶，而「這些數字
 * 是真的」是這個產品唯一的論點。寧可缺一列，也不要多一列假的。所以只把「線上
 * schema 落後」這件事講到夠白，讓人去把 006 套上去。
 *
 * TODO: 下一輪把它併回 `store.ts:315 syncCapture`。
 */
async function syncSelectionColumns(capture: Capture): Promise<void> {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('captures').upsert(
      {
        // 帶上完整欄位而不是只帶兩個新欄位：這一次 upsert 可能比 syncCapture 先
        // 到達，那時列還不存在，只帶新欄位會撞上 NOT NULL。
        id: capture.id,
        episode_id: capture.episode_id,
        window_start: capture.window_start,
        window_end: capture.window_end,
        context_start: capture.context_start,
        context_end: capture.context_end,
        strength: capture.strength,
        status: capture.status,
        transcript_text: capture.transcript_text ?? null,
        selection_text: capture.selection_text ?? null,
        selection_kind: capture.selection_kind ?? null,
        created_at: capture.created_at,
      },
      { onConflict: 'id' },
    );
    if (error) {
      // 42703 = 欄位不存在、23514 = check 約束擋下。這兩個碼在這條路徑上只有一個
      // 成因：線上還停在 006 之前。它跟一般的網路失敗不同——重試永遠不會成功，
      // 而且同一批被擋的還有 capture 本體與 replay event，所以要講清楚後果。
      if (error.code === '42703' || error.code === '23514') {
        console.warn(
          '[selection] 線上 schema 還沒套用 migration 006：這一筆的 capture 本體、' +
            'selection 欄位與（框選才有的）replay event 在伺服器端會全部遺失' +
            '（本地 store 不受影響）。006 這一版新增了 strength ' +
            "'saved' 與 selection_kind 'segmentation'，線上沒套用之前這兩種新來源" +
            '在伺服器端一筆都不會有。在套用 006 之前，指標只能以本地為準。',
        );
      } else {
        console.warn('[selection] capture sync failed:', error.message);
      }
    }
  } catch (err) {
    console.warn('[selection] capture sync error:', err);
  }
}
