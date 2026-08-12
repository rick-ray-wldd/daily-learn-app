# ADR-0017 — 框選是既有訊號的最強一級，不是新的管線

- **Status:** accepted
- **Date:** 2026-08-11
- **Amended:** 2026-08-12 — 階梯往下長一級（`saved`）、框選多一個出口
  （`segmentation`）。Decision 一條都沒被推翻，見文末〈Amendment〉。

## Context

倒帶是隱性訊號：它告訴我們「他在第 T 秒卡住了」，但不告訴我們卡在哪幾個字。
`captureEngine` 只能退而求其次，把 `[T-15, T]` 這十五秒整段交給診斷，讓 Claude
再猜一次「難點在哪」。實測下來這一步是整條鏈上最不準的環節——一段十五秒的話裡
可能有三個候選難點，猜錯就等於隔天的練習卡在練錯的東西。

逐字稿頁已經有全文，學習者只要點兩下就能指出是哪幾個字。問題是：**這個新動作
應該被建模成什麼？**

三個選項：

1. 新開一張 `selections` 表 + 新的元件狀態機 + 新的診斷入口。
2. 沿用 capture，但用一個獨立的 boolean 欄位（`is_manual`）標記來源。
3. 沿用 capture，把它放進既有的 `strength` 階梯。

## Decision

**一、採用第三個：框選 = `strength: 'selected'`，是 weak → strong 之上的第三級。**

```
weak      倒帶了                        （可能只是分心）
strong    倒帶 + 10 秒內降速或開逐字稿  （幾乎確定沒聽懂）
selected  倒帶 + 開稿 + 親手圈出哪幾個字（他自己說的，沒有推測成分）
```

> **2026-08-12 修訂：** 這道階梯的**下面**另外補了一級 `saved`（點了 app 標的詞
> 說想學，背後沒有倒帶）。上面三級的定義一個字都沒變，只是不再是最完整的清單——
> 讀到這裡請一併看文末〈Amendment〉的四級表。

具體承諾（migration 006 + `lib/selection.ts`）：

- **ADR-0003 的單一 replay-event 管線不變**，框選只是多一個
  `trigger_source: 'select'`。它是唯一不伴隨播放位置變動的來源。
- `window_start/window_end` = **被框的那一句**的 `segment.start/end`，不是
  `[T-15, T]` 窗口。這是框選比倒帶精確的地方，也是它存在的理由。
- `status` 直接是 `'confirmed'`：練習頁的 confirm 步驟問的是「這段是真的沒聽懂
  嗎」，而框選就是學習者親手回答了那一題。
- 框到的字存進新欄位 `selection_text`，**不覆寫 `transcript_text`**（後者仍是整句，
  診斷需要上下文）。
- 使用者意圖存進 `selection_kind`（`vocab` / `grammar`），**刻意不重用**
  `DiagnosisType` 的六個值——那六個是 app 的判斷結果，這一欄是學習者自己說的。
  兩者不一致（他圈了一個詞、診斷認為難在連音）本身就是有價值的資料。
- 框選**不呼叫 `ingestReplayEvent`、不 seek、不 pause**。前者會依 `[T-15, T]`
  另建一筆 weak capture 並可能與這一筆合併，把精確的一句話變回模糊的十五秒；
  後兩者會被 ADR-0016 的外部倒帶推斷誤判成鎖屏倒帶。

跨句選取不支援：每一句是 FlatList 的獨立列，跨列做不出連續的色塊，而且
`window_start/window_end` 一旦跨句就失去「那一句」的意義。

**二、手勢是「點頭、點尾」兩次獨立的 tap，不是長按拖曳。**

系統原生的文字選取（長按叫出把手、拖曳兩端）是使用者最熟的做法，但這裡不做。
狀態機只有四態、兩個純量（`anchor` / `focus`，`-1` = 未設）：

```
idle      一般閱讀，點一句 = tap-to-seek
armed     選取模式開著，還沒點頭
anchored  點了頭，範圍就是 [anchor, anchor]   ← 動作列已經出現
ranged    頭尾都有，[min, max] 全部高亮
```

三個理由，重要性由高到低：

1. **手勢仲裁。** 逐字稿是一個垂直捲動的 FlatList，而拖曳選取必須在捲動中途搶下
   responder。RN 沒有任意 token 範圍的原生選取把手，自己做等於 `PanResponder`
   ＋ 逐 token 的命中測試 ＋ 邊緣自動捲動，三者都要跟外層清單搶同一根手指。
   本輪的 `VolumeSlider` 已經示範過這類仲裁多容易做錯（`onStartShouldSetPanResponder`
   回 true 會讓垂直拖曳被吃掉，因為 RN 在既有 responder 存在時**不會**把
   `onMoveShouldSetPanResponder` 派給 responder 自己）。tap 完全不參與仲裁。
2. **單手可用性。** 這個 app 的使用情境是通勤時單手持機。拇指壓住起點再拖到終點，
   手指正好蓋住自己要圈的字，範圍的終點在拇指底下看不見。兩次獨立的 tap 每一次
   都看得見結果，而且點錯了再點一次就好——不必整段重拖。
3. **對應既有的跨度模型。** capture 的窗口本來就是 `[start, end]` 兩個端點，不是
   一條連續軌跡。兩點 tap 與資料模型同構：沒有中間態要維護，也不必在拖曳的每一幀
   重算切片。點頭自己＝往回收一階（有範圍收成單字，只剩頭就取消），連取消都不需要
   第三種手勢。

配套：**長按仍然是進入選取的主要入口**（看到聽不懂的那一句直接壓住，不必先找開關），
但長按只負責「鎖定哪一列」，不承載範圍。標題列另有一顆「框選」開關給第二條路；按下
它的**那一刻** tap-to-seek 就得停用，否則使用者以為進了選取模式，點第一句卻跳了播放
位置。`anchored` 就讓動作列出現，因為只圈一個字是最常見的情況——若非得點兩個字才能
送出，單字反而變成最難表達的東西。

## Consequences

- **下游一行都不用改。** 診斷、SRS、每日 session 對 `selected` 的 capture 與對
  `strong` 的完全一樣，因為它就是一筆 capture。代價是每一處 `=== 'strong'` 的
  二分法都要重看 else 分支——三態不能再用二分法（`screens/Practice.tsx` 的
  排序與強度標籤已在本輪修正）。
- **confirm rate 這個指標的定義變了。** 框選來的卡片天生 `confirmed`，若把它算進
  分母，這個數字會被灌水成「使用者有多常用框選」。本輪已經照做：`Practice.tsx`
  的確認率另跑一次 `computeWeaknessStats(captures.filter(c => c.strength !== 'selected'))`，
  首頁本週漏斗也把 `selected` 整筆排除（不能只從 `rewinds` 扣，否則
  `mastered ≤ confirmed ≤ rewinds` 這個不變式會破——框選來的卡天生就是 confirmed）。
  文案跟著改成「倒帶確認率（框選不計入）」，因為一個沒說清楚分母的比率比沒有還糟。
  難點總數與診斷類型分布**仍然含框選**：那些都是真的難點，只有「倒帶猜得準不準」
  這個問題不該讓框選回答。
- **兩點 tap 的代價是使用者要先學會。** 沒有系統原生的選取把手，就沒有現成的
  affordance。靠 `anchored` 立刻出現的動作列與提示列教；若實機上證明學不會，正確的
  修法是把提示做得更明顯，而不是回頭做拖曳——拖曳的手勢仲裁問題不會因為使用者
  熟悉它就消失。圈很長的一段要點兩次也是刻意的：值得框的東西本來就短。
- **綠色的語意被撐開但沒有被稀釋。** `accentSurface`（選取底色）與 `accent`
  是同一件事的兩種表面：學習者動手了。琥珀（app 在猜）與它**永遠不會同時出現在
  同一個字上**——選取模式一開，琥珀標註就先讓位，否則「證據 vs 推測」這條產品
  唯一的分界線會被抹掉。
- **兩次遠端 upsert 是暫時的技術債。** `store.ts:syncCapture` 不認得兩個新欄位，
  而 `store.ts` 在本輪的平行作業中不屬於任何人，所以 `lib/selection.ts` 自己補寫
  一次。兩次各自只設自己知道的欄位，`on conflict (id) do update` 不會互相抹掉，
  先後到達都安全。下一輪併回 `syncCapture`。
- ⚠️ **migration 006 還沒套用到線上專案，而後果比這裡原本寫的嚴重。**
  這一條原本寫「缺欄位時只有補寫那一次會失敗」——**那是錯的**，已用 app 自己的
  anon key 對線上專案實測：`select selection_text` 回
  `42703 column captures.selection_text does not exist`，而兩張表的 CHECK 約束
  也還是舊集合，所以 `strength='selected'` 與 `trigger_source='select'` 會各自撞
  `23514`。也就是**三次遠端寫入全部被拒**（`syncCapture` / `syncSelectionColumns` /
  `syncReplayEvent`），三處都只 `console.warn`，UI 一律回報成功。
  使用者端確實沒有壞——ADR-0004 的 local-first 照常成立，本地 store 仍是真相——
  但**線上的框選資料是空的**，任何跑在 Postgres 上的分析都看不到這一級訊號。
  唯一的修法是把 006 套上去；**刻意不做**「降級成 `'strong'` / `'screen'` 再重送」
  的 fallback，那會寫進一筆從沒發生過的倒帶，正是這份 ADR 要消滅的那種假訊號。
- Phase 2 的耳機捏一下、Phase 3 的眼鏡指認都可以直接接成 `selected`，不需要新表。

**這一輪（W6 改版）沒有 supersede 任何 ADR。** 逐條交代，免得日後靠猜：

- ADR-0003（單一 replay-event 管線）、ADR-0004（local-first）、ADR-0012（一個
  capture 一個 learning focus）：原樣成立，框選只是多一個 `trigger_source`。
- ADR-0011（每日 session 的界線）：不變。框選來的 capture 與倒帶來的走同一套規則，
  當天產生的一樣進搶先練那一層。⚠️ 但「今天的算不算」這個判斷目前有**兩份實作**
  （`screens/Practice.tsx` 的佇列、`App.tsx:computeBadge` 的分頁徽章），本輪只修得動
  前者，所以徽章會多算今天的框選。下一輪應該把它收成一個函式，而不是修第二份。
- ADR-0015（外殼式導覽）：整份有效，只有「mini player 在任何畫面都常駐」這一句被
  ADR-0019 **修訂（amend）為「首頁以外」**——收窄一條 consequence 不算 supersede。
- ADR-0016（外部倒帶推斷）：不變，而且是框選**不 seek、不 pause** 的原因之一。
- 同批的 ADR-0018（玻璃材質層）、0019（三分頁）、0020（首頁的兩種組織原則）
  各自也都沒有 supersede；三份的結尾都自己寫清楚了。

未來真的會發生 supersede 的兩個點，先寫在這裡：`expo-audio` 若把 remote command
以事件送進 JS，ADR-0016 那套推斷可以整包拆掉；面板哪天要浮在封面圖上，ADR-0018
的假毛玻璃就得換成 `expo-blur` 並接受一次 rebuild。

---

# Amendment（2026-08-12）— 同一條管線的兩個新入口

**這是 amend，不是 supersede。** 判準只有一條：上面的 Decision 有沒有被推翻。
沒有——框選仍然是 strength 階梯的最強一級、仍然不開新表、仍然是兩次獨立的 tap、
仍然不 seek/不 pause。這一輪加的兩件事都是同一條管線的延伸：一個在階梯**最下面**
補一級，一個在框選的**送出處**多一個出口。兩者都用既有的 `captures` 欄位表達，
下游一行都不用改。所以不寫 0021。

## 一、四級，不是三級

    saved      點了 app 標的琥珀詞說想學      ← 這一版新增，最弱
    weak       倒帶了
    strong     倒帶 + 開稿／降速
    selected   倒帶 + 開稿 + 親手指出

| | 背後的證據 | 這一筆能回答的問題 |
| --- | --- | --- |
| `saved` | **一次點擊**。沒有倒帶、沒有理解斷點 | 「他想學什麼」 |
| `weak` | 一次真的發生過的倒帶 | 「他哪裡可能沒聽懂」（可能只是分心） |
| `strong` | 倒帶 + 十秒內降速或開稿 | 「他哪裡幾乎確定沒聽懂」 |
| `selected` | 倒帶 + 開稿 + 親手指出範圍 | 「他哪裡沒聽懂、以及是哪幾個字」 |

`saved` 與其餘三級的差別是**質的、不是量的**：另外三級背後都有一次真的發生過的
倒帶，它只有一次點擊。所以這一級的處置分成兩半，而且兩半必須同時成立：

- **准進練習佇列。** 佇列問的是「練什麼」，那正是他按下按鈕要說的事。排除它等於
  做了一顆按下去隔天什麼都不會發生的按鈕。它在佇列裡**排最後**
  （`STRENGTH_RANK.saved = 3`）：十分鐘的 session 練不完時，先拿到的該是他真的
  卡住的地方。
- **不准進任何訊號指標。** 指標問的是「他哪裡聽不懂」，而它連倒帶都沒有。

### `saved` 被擋在外面的每一處（這是清單，不是舉例）

| 位置 | 做法 |
| --- | --- |
| `HomeScreen.tsx:computeWeekSignal` 本週漏斗 | 白名單 `weak`／`strong` |
| `Practice.tsx` 倒帶確認率的母體 `rewindWeakness` | 白名單 `weak`／`strong` |
| `Practice.tsx` 累計捕捉／難點分佈 `weakness` | 白名單 `weak`／`strong`／`selected` |
| `Practice.tsx` 完成畫面 + `PracticeRecord.weak_count` | 第三格 `saved_count`，`weak_count` 只含 `weak` |
| `lib/annotate.ts:weakTypesFromCaptures` | 白名單 `hasRewindEvidence()` |
| `App.tsx` 的「今天 N 次重聽」 | 不需過濾——`commitSavedTerm` 根本不建 replay event |

⚠️ **以 strength 分岔一律寫白名單（明列吃哪幾級），不准寫 `!== 'saved'`。**
這個 repo 在同一個地方犯過兩次錯：上一輪的確認率用 `!== 'selected'` 打補丁，
這一輪 `saved` 一加進 union 就原封不動漏了回來，而且更嚴重——它連倒帶都沒有，
卻會同時灌進分子與分母。黑名單讓**新增的級別預設被算進去**，而預設被算進去的
代價是產品唯一的論點（「這些數字是真的」）當場失效。白名單則讓下一級新來源預設
被排除，要納入得有人親手寫上去。

同一條規矩的三個編譯期護欄：`Practice.tsx` 的 `signalBucket` 與 `signalOrigin`
都改成 `switch` + `never`（新增一級會在編譯期爆，而不是靜靜掉進「弱訊號」那一桶），
`isStrongSignal` 改成委派給 `signalBucket`（分組只能有一份，兩份遲早分岔）。

`saved` 的徽章**不給星等**：★ 是倒帶強度的刻度，給它半顆星等於宣稱「這裡有一個
很弱的理解斷點」，那是一句假話。文案改講來歷（「＋ 你標記想學」），`signalOrigin`
更直接寫明「這裡沒有重聽紀錄」——含糊其辭會讓它讀起來像一次比較弱的重聽。

## 二、TermSheet 的一顆按鈕：不打斷，但也不再看完即丟

TermSheet 的檔頭底線是「聽的當下不打斷、不要求判斷」（Snipd 的教訓）。代價是這張
紙**看完即丟**——學習者點開解釋、讀完、關掉，什麼都沒留下，而那正是 Involvement
Load Hypothesis 裡保留率最低的條件（need 有了，search／evaluation 都是 0）。

破例的方式是**只破最小的那一格**：

- 只加**一顆**按鈕。**不問**「詞還是句型」——那是 evaluation，聽的當下一題都不問。
- **不 seek、不 pause、不建 replay event。** 播放位置紋風不動，所以也踩不到
  ADR-0016 的外部倒帶推斷（那套推斷把突然的向後跳判定成鎖屏倒帶）。
- 按完**不關面板、不跳 Alert／Toast**：他點開這張紙是為了讀解釋，關掉他就讀不完；
  任何蓋住畫面的回饋都是第二次打斷。按鈕自己就地翻成「✓ 已加入練習」。

**evaluation 沒有取消，只是延到隔天的練習卡**——那裡本來就有 confirm、分段揭露、
自評與 SRS 評分，involvement load 該在那裡發生，而且發生在他不在聽 podcast 的
時候。這才是這顆按鈕與「在播放中彈一張表單問你這是詞還是句型」的差別。

三個實作上不能鬆的點：

- **`status` 直接 `'confirmed'`**，與框選同一個理由，但這裡還多一層：
  `captureEngine` 的合併候選只挑 `'pending'`，若用 pending 建立，之後一次重疊的
  倒帶就會把它併掉、硬升成 `'strong'`，同時把「那一個詞」的精確窗口 union 成模糊
  的十五秒——一筆假的 strong 訊號。
- **冪等鍵是（集 + 句 + 詞）三個一起比。** `commitSelection` 這條管線沒有任何冪等
  鍵（每次 `uuidv4`），而這顆按鈕只要一次點擊；同一個詞點兩次就是隔天連續兩張
  一樣的卡。只比 `selection_text` 不行——同一個詞出現在不同句子是不同的練習素材。
- **反查不到句子就整顆按鈕不出現。** `Term.segment_id` 是 `segmentKey`（start×10），
  只還原得出 start；capture 的窗口還要 end 與整句文字，所以一定要回 transcript
  快取拿真正的 segment。**絕不拿 `segment_id / 10` 猜一個 end 湊窗口**——那是在
  資料庫裡捏造一段從沒發生過的時間範圍，而且看起來完全合法、事後抓不出來。窗口
  重轉會讓 Whisper 斷句挪動零點幾秒，反查 miss 是正常情形，不是錯誤。

## 三、`selection_kind: 'segmentation'` — 框不出來的人也要有出口

框選的預設前提是「使用者知道自己漏聽的是哪個詞」。但**詞界切分失敗**正是聽力最
常見的斷點之一（Field 2003；SSLLT 的複製研究）——聽者根本沒把那串聲音切成詞，
自然框不出範圍。前提不成立的時候還逼他框，只會得到亂框或放棄，兩種都是把唯一有
價值的資料丟掉。

所以框選動作列有第三個出口「我聽不出這裡有幾個字」：

- **只要有 anchor 就能按**（他指得出「大概在這附近」就夠了），不必框出範圍。
- 送出的 `selection_text` 是**整句**：斷點的位置本來就不在某個詞上。
- 它仍然是 `strength: 'selected'`——倒帶、開稿、親手指出三個條件一個不少，差別只
  在指的範圍是一整句。所以走既有的 `trigger_source: 'select'`，CHECK 不必加值。
- **不經過 `SelectionSheet`**：那張紙問的是「詞還是句型」，而這條路徑的整個前提
  就是他答不出來。
- 按鈕與「加入難點」**並排在同一列**，不收進選單、不多一層 sheet。收起來等於只有
  本來就知道自己漏聽哪個詞的人找得到它，而那正好是不需要這個出口的那群人。

**這是這個產品獨有的那一格。** 市面上沒有 app 收得到「學習者連詞界都切不出來的
位置」：字幕 app 只知道他暫停了，SRS app 只知道他建了一張卡。這一欄記的是使用者
**意圖**（他主動說「這裡我切不出來」），不是診斷結果（app 沒有判斷任何事），所以
它與 `DiagnosisType` 六類分開的理由跟 `vocab`／`grammar` 完全一樣，只是更極端。

下游因此有三處「說謊點」必須一起補，否則同一張卡會自己打自己：

- `signalOrigin` 依 kind 分兩句——不然卡片上會印「親手圈出了聽不懂的字」，而那
  正是他幾行前才明說自己做不到的動作。
- 徽章改走 `strengthBadge(capture)`，segmentation 印「✍ 你指了這一句」。
- 練習卡**不印** `selection_text`，只印標籤。整句就是答案，照印等於在遮罩正下方
  把答案原文貼一次，clue／hint 兩級當場報廢。
- 首頁「難點詞庫」把 segmentation 濾掉：34pt 單行膠囊裝不下一整句，而且那本來就
  不是「詞」。`saved` 的詞則留著（那確實是他想學的東西），但**不給綠底**、點改成
  琥珀——綠底會讓「我圈的」與「app 猜的」在首頁上長得一模一樣，而那條分界是整個
  產品的論點。

## 四、為什麼直接改 006，而不寫 007

「已 accepted 的 ADR 只能 supersede、已套用的 migration 不能改」這條紀律的理由是
**別人手上已經有那個狀態**：改一份跑過的 migration，等於讓同一個檔名在不同機器
上對應到不同的 schema，而且沒有任何一條路徑會把差異補起來。

006 從沒在任何地方跑過。已用 app 自己的 anon key 對線上專案實測：
`select selection_text` 回 `42703 column ... does not exist`，兩個 CHECK 也還是舊
的值集合。沒有任何一個資料庫處於「套了舊版 006」的狀態，所以那條紀律的前提不成立。

反過來，寫 007 的代價是留下一個**永遠不會被執行的中間狀態**：006 建立三態 CHECK、
007 立刻把它改成四態，往後每一個讀 migration 目錄的人都要重演一次歷史才知道最終
形狀是什麼。目錄應該讀起來像「這個 schema 是怎麼長成今天這樣的」，不是「我們那天
改了幾次主意」。

判準留給下一個人，只有一句：**這個檔案跑過了嗎？**（線上 schema 查得到 / 有人在
任何環境 apply 過）跑過 → 只能新增；沒跑過 → 就地改。006 一旦套上去，這條路就
關了，下一次改 `strength` 的合法值就是 007。

## 五、Consequences（本次新增）

- ⚠️ **006 仍然沒有套用到線上，而這一輪讓被擋的來源從一種變成三種。**
  `strength` 的 CHECK 擋掉 `'saved'` 與 `'selected'`，`selection_kind` 的 CHECK 擋掉
  `'segmentation'`，兩個新欄位本身則是 `42703`。框選被三條路徑全擋
  （`syncCapture` / `syncSelectionColumns` / `syncReplayEvent`）；`saved` 因為不建
  事件，只被前兩條擋。三處都只 `console.warn`，UI 一律回報成功。使用者端沒有壞
  （ADR-0004 的 local-first 照常成立，本地 store 仍是真相），但**伺服器端這三種來源
  一筆都不會有**，任何跑在 Postgres 上的分析都會靜靜地讀到 0。唯一的修法是把 006
  套上去；**刻意不做**「降級成 `'strong'` / `'screen'` 再重送」的 fallback。
- **標註 → 練習 → 標註的迴圈已經封住，但那是新開的洞。** `saved` 想學的那個詞正是
  `lib/annotate.ts` 標出來的；它出生就是 `confirmed`，所以 `weakTypesFromCaptures`
  原本的 status 過濾攔不住它。隔天練習頁一寫回 `diagnosis`，它的 type 就會回頭
  影響標註模型偏好標什麼——「模型標了什麼 → 他收藏 → 模型下次更愛標同一類」，
  整條鏈上一次倒帶都沒有，正是 annotate.ts 檔頭禁止的推測→證據方向。已加
  `hasRewindEvidence()` 白名單擋在 status 判斷之前。**修在 annotate.ts 而不是不給
  saved 診斷**：診斷卡是他要的學習內容，為了修指標而砍功能是本末倒置。
- **練習佇列的量級被放大一個數量級，本輪未解。** 框選要長按加兩次 tap，這顆按鈕
  只要**一次點擊**——一集點 20 個詞就是隔天 20 張全流程卡，ADR-0011 的十分鐘承諾
  當場破掉。目前只靠 `STRENGTH_RANK`（saved 排最後）讓它們沉到佇列尾，**沒有實作
  上限**。真正的 N=5 分流要同時動 `screens/Practice.tsx` 與 `App.tsx:computeBadge`
  這兩份孿生實作，單邊改會重演「徽章說有 3 張、點進去是空的」——那是獨立的一輪。
- **`items_completed` 含 `saved`，`weak_count` 不含。** streak 與 completion_rate 都
  吃前者，只練了 saved 的一天不該被記成沒練；但後者的定義是「倒帶了一次」，混進來
  就從「偵測到幾次重聽」變成「他練了幾張卡」。新欄位 `saved_count` 是 optional：它
  比既有的 practice log 晚出生，舊紀錄缺這一欄不是 0 也不是未知，是那時候還沒有
  這一級。
- **兩次遠端 upsert 的債沒還，而且多了一個呼叫端**（`commitSavedTerm` 走同一條
  `syncSelectionColumns`）。併回 `store.ts:syncCapture` 仍是下一輪的事。
- **TermSheet 的六類分類色不再借用語意色。** 舊的 `vocab` 是 `#4ADE80`，跟 `C.accent`
  一個位元都不差——同一張紙上綠色 chip 與新的綠色「加入練習」鍵並排，chip 會讀起來
  像可以按的東西。整組改成低彩度、避開三個語意色相（綠 142°、琥珀 43°、藍 217°）。
  這組色仍住在元件裡，該搬進 `lib/theme.ts` 成為 `CATEGORY`（與 GLASS/BLOOM 同級的
  非語意色群），搬家時連「為什麼不借語意色」的理由一起搬，否則下一個人又會借。
- **這一次一樣沒有 supersede 任何 ADR。** ADR-0003（單一 replay-event 管線）成立，
  而且 `saved` 是全 app 唯一一條**不建事件**的寫入路徑——查詢時 `captures` 裡的
  `saved` 列在 `replay_events` 沒有對應，那不是資料遺失，是它的定義。ADR-0004、
  0011、0012 不變；ADR-0016 仍是這兩個新入口都不 seek／不 pause 的原因之一。
